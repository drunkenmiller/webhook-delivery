import { Router } from 'express';
import { z } from 'zod';
import { authenticateApp, authenticatedApp } from '../auth/app-auth.ts';
import type { Db } from '../db.ts';
import { ProblemError } from '../http/problem.ts';
import { withValidation } from '../http/validate.ts';
import { ingestMessage } from './repository.ts';
import { hashRequest } from './request-hash.ts';

const IngestBody = z.strictObject({
  event_type: z.string().regex(/^[a-z0-9_.-]{1,64}$/, 'must match ^[a-z0-9_.-]{1,64}$'),
  // A JSON object (not an array or a scalar), with any fields.
  payload: z.record(z.string(), z.unknown()),
});

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
