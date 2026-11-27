import type { Db } from '../db.ts';

// Reads and replay for deliveries and their attempts. Every query filters by app_id — denormalized
// onto deliveries for exactly this (ADR 0009) — so another application's rows simply don't exist.

export type DeliveryStatus = 'pending' | 'in_flight' | 'succeeded' | 'dead';

export interface DeliveryRow {
  id: string;
  message_id: string;
  endpoint_id: string;
  status: DeliveryStatus;
  attempt_count: number;
  next_attempt_at: Date;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `id, message_id, endpoint_id, status, attempt_count, next_attempt_at, last_error,
                 created_at, updated_at`;

export interface DeliveryFilters {
  status: DeliveryStatus | undefined;
  endpointId: string | undefined;
  messageId: string | undefined;
}

// Newest first, keyset on id. Each filter is optional: `$n IS NULL OR column = $n` turns it off.
export async function listDeliveries(
  db: Db,
  appId: string,
  options: DeliveryFilters & { limit: number; afterId: string | undefined },
): Promise<DeliveryRow[]> {
  const { rows } = await db.query<DeliveryRow>(
    `SELECT ${COLUMNS} FROM deliveries
     WHERE app_id = $1
       AND ($2::uuid IS NULL OR id < $2)
       AND ($3::text IS NULL OR status = $3)
       AND ($4::uuid IS NULL OR endpoint_id = $4)
       AND ($5::uuid IS NULL OR message_id = $5)
     ORDER BY id DESC
     LIMIT $6`,
    [
      appId,
      options.afterId ?? null,
      options.status ?? null,
      options.endpointId ?? null,
      options.messageId ?? null,
      options.limit,
    ],
  );
  return rows;
}

export async function findDelivery(
  db: Db,
  appId: string,
  id: string,
): Promise<DeliveryRow | undefined> {
  const { rows } = await db.query<DeliveryRow>(
    `SELECT ${COLUMNS} FROM deliveries WHERE id = $1 AND app_id = $2`,
    [id, appId],
  );
  return rows[0];
}

export interface AttemptRow {
  id: string;
  attempt_number: number;
  worker_id: string;
  started_at: Date;
  duration_ms: number;
  status_code: number | null;
  error: string | null;
  response_body_snippet: string | null;
}

// History reads oldest first (attempt 1, 2, 3…), so the keyset goes the other way: id > cursor.
// The caller has already checked that the delivery belongs to the application.
export async function listAttempts(
  db: Db,
  deliveryId: string,
  options: { limit: number; afterId: string | undefined },
): Promise<AttemptRow[]> {
  const { rows } = await db.query<AttemptRow>(
    `SELECT id, attempt_number, worker_id, started_at, duration_ms, status_code, error,
            response_body_snippet
     FROM attempts
     WHERE delivery_id = $1 AND ($2::uuid IS NULL OR id > $2)
     ORDER BY id
     LIMIT $3`,
    [deliveryId, options.afterId ?? null, options.limit],
  );
  return rows;
}

export type ReplayResult =
  | { kind: 'replayed'; delivery: DeliveryRow }
  | { kind: 'not-dead'; status: DeliveryStatus }
  | { kind: 'not-found' };

// Replay (SPEC §4 rule 7): dead → pending, due now, with a fresh attempt budget. Attempt history
// and claim_count are kept (claim_count must never go back: it is the fencing token).
//
// The status check is IN the UPDATE's WHERE, so two concurrent replays (or a replay racing the
// worker) can't both succeed: the second one finds status = 'pending' and changes nothing.
export async function replayDelivery(db: Db, appId: string, id: string): Promise<ReplayResult> {
  const { rows } = await db.query<DeliveryRow>(
    `UPDATE deliveries
     SET status = 'pending', attempt_count = 0, next_attempt_at = now(), last_error = NULL,
         updated_at = now()
     WHERE id = $1 AND app_id = $2 AND status = 'dead'
     RETURNING ${COLUMNS}`,
    [id, appId],
  );
  const replayed = rows[0];
  if (replayed !== undefined) {
    return { kind: 'replayed', delivery: replayed };
  }
  // Nothing changed: tell "doesn't exist" (404) from "exists but isn't dead" (409).
  const existing = await findDelivery(db, appId, id);
  return existing === undefined
    ? { kind: 'not-found' }
    : { kind: 'not-dead', status: existing.status };
}

// Every delivery of one message (one per subscribed endpoint at ingest time), oldest first.
// Not paginated: it is bounded by the application's endpoint count.
export async function listMessageDeliveries(
  db: Db,
  appId: string,
  messageId: string,
): Promise<DeliveryRow[]> {
  const { rows } = await db.query<DeliveryRow>(
    `SELECT ${COLUMNS} FROM deliveries WHERE app_id = $1 AND message_id = $2 ORDER BY id`,
    [appId, messageId],
  );
  return rows;
}
