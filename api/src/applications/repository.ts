import type { Db } from '../db.ts';

// SQL for the applications table. Every query is parameterized ($1, $2…): values travel
// separately from the SQL text, so input can never change the query (no SQL injection).

export interface ApplicationRow {
  id: string;
  name: string;
  api_key_prefix: string;
  created_at: Date;
}

export interface ApplicationAuthRow {
  id: string;
  name: string;
  api_key_hash: Buffer;
}

export async function insertApplication(
  db: Db,
  input: { name: string; apiKeyPrefix: string; apiKeyHash: Buffer },
): Promise<ApplicationRow> {
  const { rows } = await db.query<ApplicationRow>(
    `INSERT INTO applications (name, api_key_prefix, api_key_hash)
     VALUES ($1, $2, $3)
     RETURNING id, name, api_key_prefix, created_at`,
    [input.name, input.apiKeyPrefix, input.apiKeyHash],
  );
  return rows[0]!;
}

export async function findApplicationByKeyPrefix(
  db: Db,
  prefix: string,
): Promise<ApplicationAuthRow | undefined> {
  const { rows } = await db.query<ApplicationAuthRow>(
    'SELECT id, name, api_key_hash FROM applications WHERE api_key_prefix = $1',
    [prefix],
  );
  return rows[0];
}
