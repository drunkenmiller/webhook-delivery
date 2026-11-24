import type { RequestHandler } from 'express';

// CORS (Cross-Origin Resource Sharing) for the dashboard.
//
// A browser page served from http://localhost:5173 (the dashboard) may only READ responses from
// http://localhost:3000 (the API) if the API says so with Access-Control-Allow-Origin. For
// "non-simple" requests — ours all are, because they carry Authorization or a JSON body — the
// browser first sends a "preflight": OPTIONS with Access-Control-Request-Method/-Headers, and only
// sends the real request if the preflight answer allows it.
//
// CORS protects browser USERS, not the API: curl and the worker ignore it. Authentication is still
// done by the API key on every request.

const ALLOWED_METHODS = 'GET, POST, PATCH, DELETE';
const ALLOWED_HEADERS = 'Authorization, Content-Type, Idempotency-Key, X-Request-Id';
const EXPOSED_HEADERS = 'X-Request-Id, Idempotent-Replayed';
const PREFLIGHT_MAX_AGE_SECONDS = '600'; // the browser may cache the preflight answer for 10 min

export function cors(allowedOrigins: readonly string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);

  return (req, res, next) => {
    const origin = req.headers.origin;
    // The answer depends on the Origin header, so shared caches must key on it.
    res.vary('Origin');

    if (origin === undefined || !allowed.has(origin)) {
      // Not a cross-origin browser request, or an origin we don't trust: no CORS headers.
      // The browser will then refuse to hand the response to the page.
      next();
      return;
    }

    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Expose-Headers', EXPOSED_HEADERS);

    if (req.method === 'OPTIONS' && req.headers['access-control-request-method'] !== undefined) {
      // Preflight: answer it here, before auth and body parsing (it carries no credentials).
      res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
      res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
      res.setHeader('Access-Control-Max-Age', PREFLIGHT_MAX_AGE_SECONDS);
      res.status(204).end();
      return;
    }

    next();
  };
}
