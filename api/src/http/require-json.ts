import type { IncomingHttpHeaders } from 'node:http';
import type { RequestHandler } from 'express';
import { ProblemError } from './problem.ts';

// The API only speaks JSON (SPEC §10). Without this check, express.json() silently skips a body
// sent as e.g. text/plain or a form, the handler sees `req.body === undefined`, and the client gets
// a confusing validation error. Answering 415 Unsupported Media Type says what is actually wrong.
//
// Requests WITHOUT a body are let through whatever their method (GET, DELETE, a POST with no body),
// so this only judges bodies that exist.
export const requireJsonBody: RequestHandler = (req, _res, next) => {
  if (hasBody(req.headers) && !req.is('application/json')) {
    // req.is() matches the media type and ignores parameters: "application/json; charset=utf-8" passes.
    throw new ProblemError({
      status: 415,
      detail: `Content-Type must be application/json (got ${req.headers['content-type'] ?? 'none'})`,
    });
  }
  next();
};

// HTTP/1.1 announces a body with Content-Length (a size) or Transfer-Encoding (streamed in chunks).
// "Content-Length: 0" means an empty body, which is fine without a Content-Type.
export function hasBody(headers: IncomingHttpHeaders): boolean {
  if (headers['transfer-encoding'] !== undefined) {
    return true;
  }
  const length = headers['content-length'];
  return length !== undefined && length !== '0';
}
