import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import type { Pingable } from '../src/routes/health.ts';

// These tests build the app with fakes instead of a real database (fast, no Docker needed).
// Integration tests against a real PostgreSQL (Testcontainers) come with the first real routes.
const silentLogger = pino({ level: 'silent' });
const healthyDb: Pingable = { query: () => Promise.resolve({ rows: [] }) };
const brokenDb: Pingable = { query: () => Promise.reject(new Error('connection refused')) };

describe('GET /healthz', () => {
  it('returns 200 without touching the database', async () => {
    const app = createApp({ logger: silentLogger, db: brokenDb });
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});

describe('GET /readyz', () => {
  it('returns 200 when the database answers', async () => {
    const app = createApp({ logger: silentLogger, db: healthyDb });
    const res = await request(app).get('/readyz');
    expect(res.status).toBe(200);
  });

  it('returns 503 problem+json when the database is unreachable', async () => {
    const app = createApp({ logger: silentLogger, db: brokenDb });
    const res = await request(app).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ status: 503, title: 'Service Unavailable' });
  });
});

describe('error handling', () => {
  const app = createApp({ logger: silentLogger, db: healthyDb });

  it('returns 404 problem+json for unknown routes', async () => {
    const res = await request(app).get('/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ type: 'about:blank', status: 404 });
  });

  it('returns 400 for malformed JSON', async () => {
    const res = await request(app)
      .post('/healthz')
      .set('Content-Type', 'application/json')
      .send('{not json');
    expect(res.status).toBe(400);
  });

  it('returns 413 for bodies over 256 KiB', async () => {
    const res = await request(app)
      .post('/healthz')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ data: 'x'.repeat(300 * 1024) }));
    expect(res.status).toBe(413);
  });
});

describe('X-Request-Id', () => {
  const app = createApp({ logger: silentLogger, db: healthyDb });

  it('echoes a valid caller-provided id', async () => {
    const res = await request(app).get('/healthz').set('X-Request-Id', 'abc-123');
    expect(res.headers['x-request-id']).toBe('abc-123');
  });

  it('generates an id when none is provided, and includes it in problem responses', async () => {
    const res = await request(app).get('/does-not-exist');
    const header = res.headers['x-request-id'];
    expect(header).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body).toMatchObject({ request_id: header });
  });
});
