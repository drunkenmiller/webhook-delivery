import express from 'express';
import { pino } from 'pino';
import { pinoHttp } from 'pino-http';
import request from 'supertest';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { errorHandler } from '../src/http/problem.ts';
import { withValidation, type ValidationIssue } from '../src/http/validate.ts';

// A tiny app with one example route, wired like the real one (pino-http gives req.id/req.log,
// errorHandler turns errors into problem+json).
const ParamsSchema = z.object({ id: z.uuid() });
const QuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });
const BodySchema = z.object({
  event_type: z.string().regex(/^[a-z0-9_.-]{1,64}$/),
  payload: z.record(z.string(), z.unknown()),
});

function buildApp() {
  const app = express();
  app.use(pinoHttp({ logger: pino({ level: 'silent' }) }));
  app.use(express.json());

  app.post(
    '/things/:id',
    withValidation(
      { params: ParamsSchema, query: QuerySchema, body: BodySchema },
      ({ params, query, body }, _req, res) => {
        // Compile-time checks: the handler receives the schemas' output types.
        expectTypeOf(params).toEqualTypeOf<{ id: string }>();
        expectTypeOf(query).toEqualTypeOf<{ limit: number }>();
        expectTypeOf(body.event_type).toEqualTypeOf<string>();
        res.json({ id: params.id, limit: query.limit, event_type: body.event_type });
      },
    ),
  );

  app.get(
    '/only-query',
    withValidation({ query: QuerySchema }, ({ params, body, query }, _req, res) => {
      expectTypeOf(params).toEqualTypeOf<undefined>();
      expectTypeOf(body).toEqualTypeOf<undefined>();
      res.json(query);
    }),
  );

  app.get(
    '/boom',
    withValidation({}, async () => {
      await Promise.resolve();
      throw new Error('handler failed');
    }),
  );

  app.use(errorHandler);
  return app;
}

// Supertest types res.body as `any`; this narrows it for the assertions below.
const errorsOf = (body: unknown): ValidationIssue[] =>
  (body as { errors: ValidationIssue[] }).errors;

const id = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const validBody = { event_type: 'invoice.paid', payload: { amount: 42 } };

describe('withValidation', () => {
  it('passes parsed and coerced values to the handler', async () => {
    const res = await request(buildApp()).post(`/things/${id}?limit=50`).send(validBody);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id, limit: 50, event_type: 'invoice.paid' });
  });

  it('applies schema defaults', async () => {
    const res = await request(buildApp()).get('/only-query');
    expect(res.body).toEqual({ limit: 20 });
  });

  it('reports every invalid part at once as a 400 problem', async () => {
    const res = await request(buildApp())
      .post('/things/not-a-uuid?limit=0')
      .send({ event_type: 'Invalid Type!', payload: 'nope' });

    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ type: 'validation-error', title: 'Invalid request' });
    expect(errorsOf(res.body).map((e) => `${e.location}:${e.path}`)).toEqual([
      'params:id',
      'query:limit',
      'body:event_type',
      'body:payload',
    ]);
  });

  it('rejects a missing body', async () => {
    const res = await request(buildApp()).post(`/things/${id}`);
    expect(res.status).toBe(400);
    expect(errorsOf(res.body)).toMatchObject([{ location: 'body' }]);
  });

  it('forwards errors thrown by the handler to the error handler', async () => {
    const res = await request(buildApp()).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ status: 500, title: 'Internal Server Error' });
  });
});
