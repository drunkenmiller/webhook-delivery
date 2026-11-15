import pg from 'pg';
import type { Logger } from 'pino';
import type { Config } from './config.ts';

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
