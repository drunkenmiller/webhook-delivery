import { pino } from 'pino';
import request from 'supertest';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { createApp } from '../../src/app.ts';
import { createPool } from '../../src/db.ts';

// The same app as production, wired to the real database started by global-setup.ts.
const logger = pino({ level: 'silent' });
const pool = createPool({ DATABASE_URL: inject('databaseUrl') }, logger);
const app = createApp({ logger, db: pool });

afterAll(async () => {
  await pool.end();
});

describe('integration: PostgreSQL', () => {
  it('runs PostgreSQL 18', async () => {
    const { rows } = await pool.query<{ server_version_num: string }>('SHOW server_version_num');
    expect(Number(rows[0]?.server_version_num)).toBeGreaterThanOrEqual(180000);
  });

  it('GET /readyz answers 200 when the database is reachable', async () => {
    const res = await request(app).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});
