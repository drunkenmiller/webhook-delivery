import type { Db, DbClient } from '../db.ts';
import { withTransaction } from '../db.ts';

export interface IngestInput {
  appId: string;
  eventType: string;
  payload: Record<string, unknown>;
  idempotencyKey: string | undefined;
  requestHash: Buffer;
  requestId: string | undefined;
}

export type IngestResult =
  // A new message: `deliveries` rows were created in the same transaction.
  | { kind: 'created'; id: string; deliveries: number }
  // Same key, same body: the original message, nothing new was written.
  | { kind: 'replayed'; id: string; deliveries: number }
  // Same key, different body.
  | { kind: 'key-reused' };

// Idempotent ingest + fan-out in ONE transaction (SPEC §6, ADR 0003). A 202 means the message
// and all its deliveries are committed (N2); a crash halfway leaves nothing behind.
//
// Concurrency — two requests with the same key at the same time:
//   1. both run INSERT … ON CONFLICT DO NOTHING;
//   2. the second one's insert hits the unique index entry of the first, which is not committed
//      yet, so PostgreSQL makes it WAIT for the first transaction;
//   3. the first commits → the second's insert does nothing (0 rows) → it reads the committed row
//      (READ COMMITTED: each statement sees what was committed before it started) and replays.
//   If the first had rolled back instead, the second's insert would simply succeed.
// No SELECT-then-INSERT, so there is no window where both see "no row" and both insert.
export async function ingestMessage(db: Db, input: IngestInput): Promise<IngestResult> {
  return withTransaction(db, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO messages (app_id, event_type, payload, idempotency_key, request_hash, request_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (app_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [
        input.appId,
        input.eventType,
        input.payload,
        input.idempotencyKey ?? null,
        input.requestHash,
        input.requestId ?? null,
      ],
    );

    const inserted = rows[0];
    if (inserted !== undefined) {
      const deliveries = await fanOut(client, input.appId, inserted.id, input.eventType);
      return { kind: 'created', id: inserted.id, deliveries };
    }

    // Conflict: a message with this key already exists (only possible when a key was given).
    return findByIdempotencyKey(client, input);
  });
}

// One pending delivery per active endpoint subscribed to the event type (an empty event_types
// array means "every type"). INSERT … SELECT: the database does the loop, in one statement.
async function fanOut(
  client: DbClient,
  appId: string,
  messageId: string,
  eventType: string,
): Promise<number> {
  const { rowCount } = await client.query(
    `INSERT INTO deliveries (app_id, message_id, endpoint_id)
     SELECT e.app_id, $2, e.id
     FROM endpoints e
     WHERE e.app_id = $1
       AND e.active
       AND (cardinality(e.event_types) = 0 OR $3 = ANY (e.event_types))`,
    [appId, messageId, eventType],
  );
  return rowCount ?? 0;
}

async function findByIdempotencyKey(client: DbClient, input: IngestInput): Promise<IngestResult> {
  const { rows } = await client.query<{ id: string; request_hash: Buffer; deliveries: number }>(
    `SELECT m.id, m.request_hash,
            (SELECT count(*)::int FROM deliveries d WHERE d.message_id = m.id) AS deliveries
     FROM messages m
     WHERE m.app_id = $1 AND m.idempotency_key = $2`,
    [input.appId, input.idempotencyKey],
  );
  const existing = rows[0];
  if (existing === undefined) {
    // ON CONFLICT fired, so the row exists and is committed: unreachable unless it was deleted.
    throw new Error('idempotency conflict but no message found');
  }
  if (!existing.request_hash.equals(input.requestHash)) {
    return { kind: 'key-reused' };
  }
  return { kind: 'replayed', id: existing.id, deliveries: existing.deliveries };
}
