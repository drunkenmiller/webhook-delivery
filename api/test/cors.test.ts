import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import type { Db } from '../src/db.ts';

const DASHBOARD = 'http://localhost:5173';

const app = createApp({
  logger: pino({ level: 'silent' }),
  db: { query: () => Promise.resolve({ rows: [] }) } as unknown as Db,
  adminToken: 'test-admin-token-123',
  allowHttpEndpointUrls: true,
  allowPrivateEndpointTargets: true,
  corsOrigins: [DASHBOARD],
});

describe('CORS', () => {
  it('answers a preflight from an allowed origin with 204 and the allowed methods/headers', async () => {
    const res = await request(app)
      .options('/v1/endpoints')
      .set('Origin', DASHBOARD)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization, content-type');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(DASHBOARD);
    expect(res.headers['access-control-allow-methods']).toContain('PATCH');
    expect(res.headers['access-control-allow-headers']).toContain('Authorization');
    expect(res.headers['vary']).toContain('Origin');
  });

  it('adds the allow-origin header to real requests from an allowed origin', async () => {
    const res = await request(app).get('/healthz').set('Origin', DASHBOARD);
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(DASHBOARD);
    expect(res.headers['access-control-expose-headers']).toContain('X-Request-Id');
  });

  it('sends no CORS headers to other origins', async () => {
    const preflight = await request(app)
      .options('/v1/endpoints')
      .set('Origin', 'https://evil.example.com')
      .set('Access-Control-Request-Method', 'POST');
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();

    const res = await request(app).get('/healthz').set('Origin', 'https://evil.example.com');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('is disabled when no origins are configured', async () => {
    const closed = createApp({
      logger: pino({ level: 'silent' }),
      db: { query: () => Promise.resolve({ rows: [] }) } as unknown as Db,
      adminToken: 'test-admin-token-123',
      allowHttpEndpointUrls: true,
      allowPrivateEndpointTargets: true,
    });
    const res = await request(closed).get('/healthz').set('Origin', DASHBOARD);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
