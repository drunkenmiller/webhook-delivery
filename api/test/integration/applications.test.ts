import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { hashApiKey } from '../../src/auth/api-keys.ts';
import { ADMIN_TOKEN, createTestContext, resetDatabase } from './helpers.ts';

const { app, pool } = createTestContext();

beforeEach(async () => {
  await resetDatabase(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('POST /v1/applications', () => {
  it('creates an application and returns its API key once', async () => {
    const res = await request(app)
      .post('/v1/applications')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ name: '  Acme Billing  ' });

    expect(res.status).toBe(201);
    const body = res.body as { id: string; name: string; api_key: string; api_key_prefix: string };
    expect(body.name).toBe('Acme Billing');
    expect(body.api_key).toMatch(new RegExp(`^whd_${body.api_key_prefix}_`));

    // Only the hash is stored, never the key itself.
    const { rows } = await pool.query<{ api_key_hash: Buffer }>(
      'SELECT api_key_hash FROM applications WHERE id = $1',
      [body.id],
    );
    expect(rows[0]?.api_key_hash.equals(hashApiKey(body.api_key))).toBe(true);
  });

  it('requires the admin token', async () => {
    const missing = await request(app).post('/v1/applications').send({ name: 'Acme' });
    expect(missing.status).toBe(401);
    expect(missing.headers['www-authenticate']).toBe('Bearer');

    const wrong = await request(app)
      .post('/v1/applications')
      .set('Authorization', 'Bearer not-the-admin-token')
      .send({ name: 'Acme' });
    expect(wrong.status).toBe(401);
  });

  it('validates the name', async () => {
    const res = await request(app)
      .post('/v1/applications')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ name: '   ' });
    expect(res.status).toBe(400);
  });
});
