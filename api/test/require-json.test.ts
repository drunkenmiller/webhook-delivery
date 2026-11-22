import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import type { Db } from '../src/db.ts';
import { hasBody } from '../src/http/require-json.ts';

const app = createApp({
  logger: pino({ level: 'silent' }),
  db: { query: () => Promise.resolve({ rows: [] }) } as unknown as Db,
  adminToken: 'test-admin-token-123',
  allowHttpEndpointUrls: true,
  allowPrivateEndpointTargets: true,
});

describe('requireJsonBody', () => {
  it('answers 415 problem+json for a non-JSON body', async () => {
    const res = await request(app)
      .post('/v1/applications')
      .set('Content-Type', 'text/plain')
      .send('name=Acme');
    expect(res.status).toBe(415);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({
      status: 415,
      title: 'Unsupported Media Type',
      detail: 'Content-Type must be application/json (got text/plain)',
    });
  });

  it('rejects form bodies too', async () => {
    const res = await request(app).post('/v1/applications').type('form').send({ name: 'Acme' });
    expect(res.status).toBe(415);
  });

  it('accepts JSON with a charset parameter', async () => {
    // Passes the media type check and reaches the admin auth (401 without a token).
    const res = await request(app)
      .post('/v1/applications')
      .set('Content-Type', 'application/json; charset=utf-8')
      .send(JSON.stringify({ name: 'Acme' }));
    expect(res.status).toBe(401);
  });

  it('lets requests without a body through', async () => {
    expect((await request(app).get('/healthz')).status).toBe(200);
    expect((await request(app).post('/v1/applications')).status).toBe(401);
  });
});

describe('hasBody', () => {
  it.each([
    [{}, false],
    [{ 'content-length': '0' }, false],
    [{ 'content-length': '12' }, true],
    [{ 'transfer-encoding': 'chunked' }, true],
  ])('%o → %s', (headers, expected) => {
    expect(hasBody(headers)).toBe(expected);
  });
});
