import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Applies dbmate migrations (db/migrations/*.sql) in filename order, running only the
// "-- migrate:up" section of each file. This lets the tests build the real schema without
// installing the dbmate binary. Production and local development keep using dbmate itself.

export const MIGRATIONS_DIR = join(import.meta.dirname, '../../../db/migrations');

// Only `query` is needed, so a pg.Pool, a pg.Client or a test fake all fit.
export interface SqlRunner {
  query(sql: string): Promise<unknown>;
}

export async function applyMigrations(client: SqlRunner, dir = MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = extractUpSection(await readFile(join(dir, file), 'utf8'));
    await client.query(sql);
  }
  return files;
}

// Returns the SQL between "-- migrate:up" and "-- migrate:down" (or the end of the file).
export function extractUpSection(sql: string): string {
  const up = /^-- migrate:up\b.*$/m.exec(sql);
  if (!up) {
    throw new Error('migration has no "-- migrate:up" section');
  }
  const rest = sql.slice(up.index + up[0].length);
  const down = /^-- migrate:down\b.*$/m.exec(rest);
  return (down ? rest.slice(0, down.index) : rest).trim();
}
