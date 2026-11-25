import express from 'express';
import { pino } from 'pino';
import request from 'supertest';
import { inject } from 'vitest';
import { createApp } from '../../src/app.ts';
import { createPool } from '../../src/db.ts';

export const ADMIN_TOKEN = 'integration-admin-token';

// The real app wired to the real database started by global-setup.ts.
export function createTestContext() {
  const logger = pino({ level: 'silent' });
  const pool = createPool({ DATABASE_URL: inject('databaseUrl') }, logger);
  const app = createApp({
    logger,
    db: pool,
    adminToken: ADMIN_TOKEN,
    allowHttpEndpointUrls: false,
    allowPrivateEndpointTargets: false,
  });
  return { app, pool };
}

// Empties the tables between tests so each test starts from a known state.
export async function resetDatabase(pool: ReturnType<typeof createPool>): Promise<void> {
  await pool.query('TRUNCATE applications, endpoints, messages, deliveries, attempts CASCADE');
}

// Creates an application through the admin API and returns its id and API key.
export async function createApplication(app: express.Express, name = 'Acme') {
  const res = await request(app)
    .post('/v1/applications')
    .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
    .send({ name });
  if (res.status !== 201) {
    throw new Error(`creating the application failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body as { id: string; name: string; api_key: string; api_key_prefix: string };
}
