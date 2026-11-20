import type { Db } from '../db.ts';

// Every query filters by app_id: an application can only ever see or change its own endpoints
// (tenant isolation, SPEC §6). Another app's endpoint simply "doesn't exist" → 404.

export interface EndpointRow {
  id: string;
  app_id: string;
  url: string;
  secret: string;
  event_types: string[];
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = 'id, app_id, url, secret, event_types, active, created_at, updated_at';

export async function insertEndpoint(
  db: Db,
  input: { appId: string; url: string; secret: string; eventTypes: string[]; active: boolean },
): Promise<EndpointRow> {
  const { rows } = await db.query<EndpointRow>(
    `INSERT INTO endpoints (app_id, url, secret, event_types, active)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${COLUMNS}`,
    [input.appId, input.url, input.secret, input.eventTypes, input.active],
  );
  return rows[0]!;
}

export async function findEndpoint(
  db: Db,
  appId: string,
  id: string,
): Promise<EndpointRow | undefined> {
  const { rows } = await db.query<EndpointRow>(
    `SELECT ${COLUMNS} FROM endpoints WHERE id = $1 AND app_id = $2`,
    [id, appId],
  );
  return rows[0];
}

// Keyset ("cursor") pagination, newest first. uuidv7 ids grow with time, so "older than the
// last id I saw" is simply `id < $cursor`, served by the (app_id, id) index. Unlike OFFSET, it
// doesn't skip or repeat rows when new endpoints are created between two pages.
export async function listEndpoints(
  db: Db,
  appId: string,
  options: { limit: number; afterId: string | undefined },
): Promise<EndpointRow[]> {
  const { rows } = await db.query<EndpointRow>(
    `SELECT ${COLUMNS} FROM endpoints
     WHERE app_id = $1 AND ($2::uuid IS NULL OR id < $2)
     ORDER BY id DESC
     LIMIT $3`,
    [appId, options.afterId ?? null, options.limit],
  );
  return rows;
}

// Fields left undefined keep their value: COALESCE(NULL, url) = url.
export async function updateEndpoint(
  db: Db,
  appId: string,
  id: string,
  changes: {
    url?: string | undefined;
    eventTypes?: string[] | undefined;
    active?: boolean | undefined;
  },
): Promise<EndpointRow | undefined> {
  const { rows } = await db.query<EndpointRow>(
    `UPDATE endpoints
     SET url         = COALESCE($3, url),
         event_types = COALESCE($4, event_types),
         active      = COALESCE($5, active),
         updated_at  = now()
     WHERE id = $1 AND app_id = $2
     RETURNING ${COLUMNS}`,
    [id, appId, changes.url ?? null, changes.eventTypes ?? null, changes.active ?? null],
  );
  return rows[0];
}

// Soft delete: the row stays (future deliveries reference it), it just stops receiving events.
export async function deactivateEndpoint(db: Db, appId: string, id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    'UPDATE endpoints SET active = false, updated_at = now() WHERE id = $1 AND app_id = $2',
    [id, appId],
  );
  return rowCount === 1;
}
