import { Router } from 'express';
import { z } from 'zod';
import { authenticateApp, authenticatedApp } from '../auth/app-auth.ts';
import type { Db } from '../db.ts';
import { listMessageDeliveries } from '../deliveries/repository.ts';
import { toDeliveryResponse } from '../deliveries/routes.ts';
import { decodeCursor, PageQuery, toPage } from '../http/pagination.ts';
import { ProblemError } from '../http/problem.ts';
import { withValidation } from '../http/validate.ts';
import { findMessage, ingestMessage, listMessages } from './repository.ts';
import { hashRequest } from './request-hash.ts';

const EventType = z.string().regex(/^[a-z0-9_.-]{1,64}$/, 'must match ^[a-z0-9_.-]{1,64}$');

const IngestBody = z.strictObject({
  event_type: EventType,
  // A JSON object (not an array or a scalar), with any fields.
  payload: z.record(z.string(), z.unknown()),
});

const ListQuery = PageQuery.extend({ event_type: EventType.optional() });
const IdParams = z.object({ id: z.uuid() });

// Printable ASCII, 1–255 chars: a UUID, a hash, "order-42-paid"… anything the producer picks.
const IdempotencyKey = z
  .string()
  .regex(/^[\x21-\x7e]{1,255}$/, 'must be 1–255 printable ASCII characters without spaces');

export function messagesRouter({ db }: { db: Db }): Router {
  const router = Router();

  router.use('/v1/messages', authenticateApp(db));

  // POST /v1/messages — idempotent ingest + fan-out (SPEC §6).
  router.post(
    '/v1/messages',
    withValidation({ body: IngestBody }, async ({ body }, req, res) => {
      const idempotencyKey = parseIdempotencyKey(req.headers['idempotency-key']);

      const result = await ingestMessage(db, {
        appId: authenticatedApp(req).id,
        eventType: body.event_type,
        payload: body.payload,
        idempotencyKey,
        requestHash: hashRequest(body),
        // Always a string: app.ts generates it (pino-http types it more loosely).
        requestId: typeof req.id === 'string' ? req.id : undefined,
      });

      if (result.kind === 'key-reused') {
        throw new ProblemError({
          status: 422,
          type: 'idempotency-key-reused',
          detail: 'This Idempotency-Key was already used with a different request body',
        });
      }
      if (result.kind === 'replayed') {
        res.setHeader('Idempotent-Replayed', 'true');
      }
      // 202 Accepted: stored and queued; delivery happens later, in the worker.
      res.status(202).json({ id: result.id, deliveries: result.deliveries });
    }),
  );

  // GET /v1/messages?event_type=&limit=&cursor= — newest first, without payloads.
  router.get(
    '/v1/messages',
    withValidation({ query: ListQuery }, async ({ query }, req, res) => {
      const rows = await listMessages(db, authenticatedApp(req).id, {
        limit: query.limit + 1,
        afterId: decodeCursor(query.cursor),
        eventType: query.event_type,
      });
      res.json(toPage(rows, query.limit, (row) => row));
    }),
  );

  // GET /v1/messages/:id — the message with its payload and every delivery it fanned out to.
  router.get(
    '/v1/messages/:id',
    withValidation({ params: IdParams }, async ({ params }, req, res) => {
      const appId = authenticatedApp(req).id;
      const message = await findMessage(db, appId, params.id);
      if (message === undefined) {
        throw new ProblemError({ status: 404, detail: 'Message not found' });
      }
      const deliveries = await listMessageDeliveries(db, appId, message.id);
      res.json({ ...message, deliveries: deliveries.map(toDeliveryResponse) });
    }),
  );

  return router;
}

// Node joins repeated headers into one string with ", ", so a string[] never shows up here
// for Idempotency-Key, but the type allows it.
function parseIdempotencyKey(header: string | string[] | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  const parsed = IdempotencyKey.safeParse(header);
  if (!parsed.success) {
    throw new ProblemError({
      status: 400,
      type: 'validation-error',
      title: 'Invalid request',
      errors: [
        { location: 'headers', path: 'idempotency-key', message: parsed.error.issues[0]?.message },
      ],
    });
  }
  return parsed.data;
}
