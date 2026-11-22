import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createPool } from './db.ts';
import { createLogger } from './logger.ts';

// Entry point: wires config → logger → app, starts listening and handles shutdown.
const config = loadConfig();
const logger = createLogger(config);
const pool = createPool(config, logger);
const app = createApp({
  logger,
  db: pool,
  adminToken: config.ADMIN_TOKEN,
  allowHttpEndpointUrls: config.NODE_ENV !== 'production',
  allowPrivateEndpointTargets: config.ALLOW_PRIVATE_TARGETS ?? config.NODE_ENV !== 'production',
});

const server = app.listen(config.PORT, (error) => {
  if (error) {
    logger.fatal({ err: error }, 'failed to start');
    process.exit(1);
  }
  logger.info({ port: config.PORT }, 'api listening');
});

// Graceful shutdown: stop accepting new connections, let in-flight requests finish,
// close the database pool, then exit. Platforms (Docker, Railway) send SIGTERM before killing the process.
function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, 'shutting down');
  server.close((error) => {
    if (error) {
      logger.error({ err: error }, 'error while closing the server');
    }
    pool.end().then(
      () => process.exit(error ? 1 : 0),
      (poolError: unknown) => {
        logger.error({ err: poolError }, 'error while closing the database pool');
        process.exit(1);
      },
    );
  });
  // Safety net: force exit if connections do not drain in time.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
