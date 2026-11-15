import { STATUS_CODES } from 'node:http';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { z } from 'zod';

// Errors are returned as RFC 9457 "problem details" (Content-Type: application/problem+json):
//   { "type": "...", "title": "...", "status": 404, "detail": "...", "request_id": "..." }
// "about:blank" is the RFC's default type when the HTTP status alone explains the problem.

export interface ProblemInit {
  status: number;
  title?: string | undefined;
  type?: string | undefined;
  detail?: string | undefined;
  errors?: unknown[] | undefined;
}

// Throw this from a route handler to answer with a specific problem response.
export class ProblemError extends Error {
  readonly status: number;
  readonly title: string;
  readonly type: string;
  readonly detail: string | undefined;
  readonly errors: unknown[] | undefined;

  constructor(init: ProblemInit) {
    const title = init.title ?? STATUS_CODES[init.status] ?? 'Error';
    super(init.detail ?? title);
    this.name = 'ProblemError';
    this.status = init.status;
    this.title = title;
    this.type = init.type ?? 'about:blank';
    this.detail = init.detail;
    this.errors = init.errors;
  }
}

// Registered after all routes: nothing matched, so answer 404.
export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new ProblemError({ status: 404, detail: `No route for ${req.method} ${req.path}` }));
};

// Express recognizes an error handler by its 4 parameters, so `_next` must stay.
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const problem = toProblem(err);
  if (problem.status >= 500) {
    req.log.error({ err }, 'unhandled error');
  }
  res
    .status(problem.status)
    .type('application/problem+json')
    .json({
      type: problem.type,
      title: problem.title,
      status: problem.status,
      ...(problem.detail !== undefined && { detail: problem.detail }),
      ...(problem.errors !== undefined && { errors: problem.errors }),
      request_id: req.id,
    });
};

function toProblem(err: unknown): ProblemError {
  if (err instanceof ProblemError) {
    return err;
  }
  if (err instanceof z.ZodError) {
    return new ProblemError({
      status: 400,
      type: 'validation-error',
      title: 'Invalid request',
      errors: err.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  // Errors raised by Express itself (e.g. the JSON body parser: 400 malformed JSON,
  // 413 body too large) carry a 4xx `status` and `expose: true` when the message is safe to show.
  if (isClientHttpError(err)) {
    return new ProblemError({ status: err.status, detail: err.message });
  }
  // Anything else is a bug or an outage: log it, but never leak internals to the client.
  return new ProblemError({ status: 500 });
}

function isClientHttpError(err: unknown): err is { status: number; message: string } {
  return (
    err instanceof Error &&
    'status' in err &&
    typeof err.status === 'number' &&
    err.status >= 400 &&
    err.status < 500 &&
    'expose' in err &&
    err.expose === true
  );
}
