import { Router } from 'express';
import { z } from 'zod';
import { authenticateApp, authenticatedApp } from '../auth/app-auth.ts';
import type { Db } from '../db.ts';
import { decodeCursor, PageQuery, toPage } from '../http/pagination.ts';
import { ProblemError } from '../http/problem.ts';
import { withValidation } from '../http/validate.ts';
import {
  findDelivery,
  listAttempts,
  listDeliveries,
  replayDelivery,
  type AttemptRow,
  type DeliveryRow,
} from './repository.ts';

const IdParams = z.object({ id: z.uuid() });

const ListQuery = PageQuery.extend({
  status: z.enum(['pending', 'in_flight', 'succeeded', 'dead']).optional(),
  endpoint_id: z.uuid().optional(),
  message_id: z.uuid().optional(),
});

export function deliveriesRouter({ db }: { db: Db }): Router {
  const router = Router();

  router.use('/v1/deliveries', authenticateApp(db));

  // GET /v1/deliveries?status=&endpoint_id=&message_id=&limit=&cursor= — newest first.
  router.get(
    '/v1/deliveries',
    withValidation({ query: ListQuery }, async ({ query }, req, res) => {
      const rows = await listDeliveries(db, authenticatedApp(req).id, {
        limit: query.limit + 1,
        afterId: decodeCursor(query.cursor),
        status: query.status,
        endpointId: query.endpoint_id,
        messageId: query.message_id,
      });
      res.json(toPage(rows, query.limit, toDeliveryResponse));
    }),
  );

  router.get(
    '/v1/deliveries/:id',
    withValidation({ params: IdParams }, async ({ params }, req, res) => {
      const delivery = await findDelivery(db, authenticatedApp(req).id, params.id);
      if (delivery === undefined) throw notFound();
      res.json(toDeliveryResponse(delivery));
    }),
  );

  // GET /v1/deliveries/:id/attempts — oldest first (the history of one delivery).
  router.get(
    '/v1/deliveries/:id/attempts',
    withValidation({ params: IdParams, query: PageQuery }, async ({ params, query }, req, res) => {
      // Tenant check first: attempts have no app_id; their delivery does.
      const delivery = await findDelivery(db, authenticatedApp(req).id, params.id);
      if (delivery === undefined) throw notFound();
      const rows = await listAttempts(db, delivery.id, {
        limit: query.limit + 1,
        afterId: decodeCursor(query.cursor),
      });
      res.json(toPage(rows, query.limit, toAttemptResponse));
    }),
  );

  // POST /v1/deliveries/:id/replay — only from `dead` (409 otherwise). 202: the worker will
  // pick it up on its next poll.
  router.post(
    '/v1/deliveries/:id/replay',
    withValidation({ params: IdParams }, async ({ params }, req, res) => {
      const result = await replayDelivery(db, authenticatedApp(req).id, params.id);
      switch (result.kind) {
        case 'not-found':
          throw notFound();
        case 'not-dead':
          throw new ProblemError({
            status: 409,
            type: 'delivery-not-dead',
            detail: `Only dead deliveries can be replayed; this one is ${result.status}`,
          });
        case 'replayed':
          res.status(202).json(toDeliveryResponse(result.delivery));
      }
    }),
  );

  return router;
}

// next_attempt_at is "when it is due next": the retry time while pending, the lease expiry while
// in flight (ADR 0009). Lease internals (locked_by, claim_count) stay internal.
export function toDeliveryResponse(row: DeliveryRow) {
  return {
    id: row.id,
    message_id: row.message_id,
    endpoint_id: row.endpoint_id,
    status: row.status,
    attempt_count: row.attempt_count,
    next_attempt_at: row.next_attempt_at,
    last_error: row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toAttemptResponse(row: AttemptRow) {
  return {
    id: row.id,
    attempt_number: row.attempt_number,
    worker_id: row.worker_id,
    started_at: row.started_at,
    duration_ms: row.duration_ms,
    status_code: row.status_code,
    error: row.error,
    response_body_snippet: row.response_body_snippet,
  };
}

function notFound(): ProblemError {
  return new ProblemError({ status: 404, detail: 'Delivery not found' });
}
