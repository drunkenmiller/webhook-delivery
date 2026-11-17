import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createReceiver, type ReceiverOptions } from '../src/receiver.ts';
import { sign } from '../src/signature.ts';

const secret = `whsec_${randomBytes(32).toString('base64')}`;
const now = 1_800_000_000;
const body = '{"event":"invoice.paid"}';

function build(overrides: Partial<ReceiverOptions> = {}) {
  const sleeps: number[] = [];
  const listener = createReceiver({
    secrets: [secret],
    nowSeconds: () => now,
    random: () => 0.99,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    log: () => {},
    ...overrides,
  });
  return { listener, sleeps };
}

function signedHeaders(id = 'msg_1', s = secret) {
  const ts = String(now);
  return {
    'content-type': 'application/json',
    'webhook-id': id,
    'webhook-timestamp': ts,
    'webhook-signature': `v1,${sign(s, id, ts, body).toString('base64')}`,
  };
}

describe('receiver', () => {
  it('acknowledges a correctly signed webhook', async () => {
    const { listener } = build();
    const res = await request(listener).post('/hook').set(signedHeaders()).send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
  });

  it('rejects a bad signature with 401', async () => {
    const { listener } = build();
    const other = `whsec_${randomBytes(32).toString('base64')}`;
    const res = await request(listener).post('/hook').set(signedHeaders('msg_1', other)).send(body);
    expect(res.status).toBe(401);
  });

  it('skips verification when no secret is configured', async () => {
    const { listener } = build({ secrets: [] });
    const res = await request(listener).post('/hook').send(body);
    expect(res.status).toBe(200);
  });

  it('answers the status forced with ?status=', async () => {
    const { listener } = build();
    const res = await request(listener).post('/hook?status=503').set(signedHeaders()).send(body);
    expect(res.status).toBe(503);
  });

  it('fails according to ?fail_rate= using the injected random source', async () => {
    const failing = build({ random: () => 0.1 }).listener;
    expect(
      (await request(failing).post('/h?fail_rate=0.3').set(signedHeaders()).send(body)).status,
    ).toBe(500);

    const passing = build({ random: () => 0.5 }).listener;
    expect(
      (await request(passing).post('/h?fail_rate=0.3').set(signedHeaders()).send(body)).status,
    ).toBe(200);
  });

  it('waits ?delay_ms= through the injected sleep, capped at 120 s', async () => {
    const { listener, sleeps } = build();
    await request(listener).post('/h?delay_ms=15000').set(signedHeaders()).send(body);
    await request(listener).post('/h?delay_ms=999999').set(signedHeaders()).send(body);
    expect(sleeps).toEqual([15_000, 120_000]);
  });

  it('counts duplicates only among acknowledged deliveries', async () => {
    const { listener } = build();
    await request(listener).post('/h?status=500').set(signedHeaders('msg_A')).send(body); // failed attempt
    await request(listener).post('/h').set(signedHeaders('msg_A')).send(body); // retry succeeds
    await request(listener).post('/h').set(signedHeaders('msg_A')).send(body); // duplicate
    await request(listener).post('/h').set(signedHeaders('msg_B')).send(body);

    const stats = await request(listener).get('/stats');
    expect(stats.body).toEqual({
      received: 4,
      rejected: 0,
      failed: 1,
      acknowledged: 3,
      unique: 2,
      duplicates: 1,
    });
  });

  it('returns 413 for bodies over 1 MiB and 405 for other methods', async () => {
    const { listener } = build({ secrets: [] });
    const big = 'x'.repeat(1024 * 1024 + 1);
    expect((await request(listener).post('/h').send(big)).status).toBe(413);
    expect((await request(listener).put('/h').send(body)).status).toBe(405);
    expect((await request(listener).get('/healthz')).status).toBe(200);
  });
});
