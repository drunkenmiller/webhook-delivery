import express, { type Express } from 'express';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import { applicationsRouter } from './applications/routes.ts';
import type { Db } from './db.ts';
import { endpointsRouter } from './endpoints/routes.ts';
import { cors } from './http/cors.ts';
import { errorHandler, notFoundHandler } from './http/problem.ts';
import { resolveRequestId } from './http/request-id.ts';
import { requireJsonBody } from './http/require-json.ts';
import { messagesRouter } from './messages/routes.ts';
import { healthRouter } from './routes/health.ts';

export interface AppDeps {
  logger: Logger;
  db: Db;
  adminToken: string;
  allowHttpEndpointUrls: boolean;
  allowPrivateEndpointTargets: boolean;
  // Browser origins allowed to call the API (the dashboard). Empty = no cross-origin access.
  corsOrigins?: readonly string[];
}

// Builds the Express app without starting a server. Dependencies are passed in
// (instead of imported as globals) so tests can create an app with fakes.
export function createApp({
  logger,
  db,
  adminToken,
  allowHttpEndpointUrls,
  allowPrivateEndpointTargets,
  corsOrigins = [],
}: AppDeps): Express {
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

  // Before the body checks and auth: a CORS preflight has no body and no credentials.
  app.use(cors(corsOrigins));

  // JSON bodies only (415 otherwise), capped at 256 KiB (SPEC §6).
  app.use(requireJsonBody);
  app.use(express.json({ limit: '256kb' }));

  app.use(healthRouter(db));
  app.use(applicationsRouter({ db, adminToken }));
  app.use(
    endpointsRouter({
      db,
      allowHttpUrls: allowHttpEndpointUrls,
      allowPrivateTargets: allowPrivateEndpointTargets,
    }),
  );
  app.use(messagesRouter({ db }));

  // Must come after every route: 404 for unmatched paths, then the problem+json error handler.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
