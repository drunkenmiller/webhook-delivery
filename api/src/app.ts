import express, { type Express } from 'express';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import { errorHandler, notFoundHandler } from './http/problem.ts';
import { resolveRequestId } from './http/request-id.ts';
import { healthRouter, type Pingable } from './routes/health.ts';

export interface AppDeps {
  logger: Logger;
  db: Pingable;
}

// Builds the Express app without starting a server. Dependencies are passed in
// (instead of imported as globals) so tests can create an app with fakes.
export function createApp({ logger, db }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');

  // One log line per request, tagged with a request ID that is also returned to the caller
  // in X-Request-Id. Later it is stored in messages.request_id to correlate API and worker logs.
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = resolveRequestId(req.headers['x-request-id']);
        res.setHeader('X-Request-Id', id);
        return id;
      },
    }),
  );

  // JSON bodies only, capped at 256 KiB (SPEC §6).
  app.use(express.json({ limit: '256kb' }));

  app.use(healthRouter(db));

  // Must come after every route: 404 for unmatched paths, then the problem+json error handler.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
