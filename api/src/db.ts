import pg from 'pg';
import type { Logger } from 'pino';
import type { Config } from './config.ts';

// What the rest of the code needs from the database: `query`, and `connect` for transactions.
// A pg.Pool fits; tests may pass fakes.
export type Db = Pick<pg.Pool, 'query' | 'connect'>;

// One connection lent by the pool: every statement of a transaction must run on the SAME
// connection (BEGIN on one connection and INSERT on another would be two unrelated sessions).
export type DbClient = Pick<pg.PoolClient, 'query'>;

// Runs `work` inside BEGIN … COMMIT on one pooled connection. Any error → ROLLBACK and rethrow,
// so either every statement is committed or none is. The connection always returns to the pool.
export async function withTransaction<T>(
  db: Db,
  work: (client: DbClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined); // the original error matters more
    throw error;
  } finally {
    client.release();
  }
}

// A connection pool keeps a few open connections to PostgreSQL and lends them to queries,
// instead of opening a new TCP connection (and authenticating) for every request.
export function createPool(config: Pick<Config, 'DATABASE_URL'>, logger: Logger): pg.Pool {
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: 10,
    // Fail fast instead of waiting forever when the database is unreachable.
    connectionTimeoutMillis: 2_000,
  });

  // An idle connection can break (e.g. database restart). Without this listener the
  // 'error' event would be unhandled and crash the process.
  pool.on('error', (err) => {
    logger.error({ err }, 'idle database connection error');
  });

  return pool;
}
