import { Router } from 'express';
import { ProblemError } from '../http/problem.ts';

// The only thing the health routes need from the database. Accepting this small interface
// (instead of the whole pg.Pool) lets tests pass a fake.
export interface Pingable {
  query(text: string): Promise<unknown>;
}

export function healthRouter(db: Pingable): Router {
  const router = Router();

  // Liveness: the process is running and can answer HTTP. Never touches the database,
  // so a database outage does not make the platform restart a healthy process.
  router.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Readiness: the process can do useful work (database reachable). Express 5 forwards a
  // rejected promise from an async handler to the error handler automatically.
  router.get('/readyz', async (req, res) => {
    try {
      await db.query('SELECT 1');
    } catch (err) {
      req.log.warn({ err }, 'readiness check failed');
      throw new ProblemError({ status: 503, detail: 'Database is not reachable' });
    }
    res.json({ status: 'ok' });
  });

  return router;
}
