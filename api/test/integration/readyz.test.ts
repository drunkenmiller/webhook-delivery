import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestContext } from './helpers.ts';

const { app, pool } = createTestContext();

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
