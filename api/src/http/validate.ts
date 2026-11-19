import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { z } from 'zod';
import { ProblemError } from './problem.ts';

// Validates params, query and body of a request with zod schemas and hands the handler the
// PARSED values, already typed from the schemas (one schema → runtime check + TypeScript type):
//
//   router.post(
//     '/v1/things/:id',
//     withValidation({ params: z.object({ id: z.uuid() }), body: CreateThing }, async ({ params, body }, req, res) => {
//       params.id;   // string, already validated
//       body;        // z.output<typeof CreateThing>
//     }),
//   );
//
// The parsed values are passed as an argument instead of overwriting req.query/req.body:
// in Express 5 `req.query` is a read-only getter, and keeping req untouched avoids surprises.

export interface RequestSchemas {
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
}

// For each part: the schema's output type if a schema was given, otherwise `undefined`.
type Parsed<S, K extends keyof RequestSchemas> =
  S extends Record<K, infer T extends z.ZodType> ? z.output<T> : undefined;

export interface ValidatedInput<S extends RequestSchemas> {
  params: Parsed<S, 'params'>;
  query: Parsed<S, 'query'>;
  body: Parsed<S, 'body'>;
}

export type ValidatedHandler<S extends RequestSchemas> = (
  input: ValidatedInput<S>,
  req: Request,
  res: Response,
  next: NextFunction,
) => void | Promise<void>;

export interface ValidationIssue {
  location: keyof RequestSchemas; // where the problem is: params, query or body
  path: string; // e.g. "event_type" or "items.0.name"
  message: string;
}

export function withValidation<S extends RequestSchemas>(
  schemas: S,
  handler: ValidatedHandler<S>,
): RequestHandler {
  return async (req, res, next) => {
    // Validate all three parts before answering, so the client sees every problem at once.
    const issues: ValidationIssue[] = [];
    const params = parsePart('params', schemas.params, req.params, issues);
    const query = parsePart('query', schemas.query, req.query, issues);
    const body = parsePart('body', schemas.body, req.body, issues);

    if (issues.length > 0) {
      throw new ProblemError({
        status: 400,
        type: 'validation-error',
        title: 'Invalid request',
        errors: issues,
      });
    }

    // The cast is safe: each value came from the matching schema (or is undefined when absent).
    await handler({ params, query, body } as ValidatedInput<S>, req, res, next);
  };
}

function parsePart(
  location: keyof RequestSchemas,
  schema: z.ZodType | undefined,
  value: unknown,
  issues: ValidationIssue[],
): unknown {
  if (schema === undefined) {
    return undefined;
  }
  const result = schema.safeParse(value);
  if (result.success) {
    return result.data;
  }
  for (const issue of result.error.issues) {
    issues.push({ location, path: issue.path.join('.'), message: issue.message });
  }
  return undefined;
}
