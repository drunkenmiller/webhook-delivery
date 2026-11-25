import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApplication, createTestContext, resetDatabase } from './helpers.ts';

const { app, pool } = createTestContext();

interface IngestBody {
  id: string;
  deliveries: number;
}

let apiKey: string;

beforeEach(async () => {
  await resetDatabase(pool);
  apiKey = (await createApplication(app)).api_key;
});

afterAll(async () => {
  await pool.end();
});

const auth = (key = apiKey) => ({ Authorization: `Bearer ${key}` });

async function createEndpoint(body: object, key = apiKey): Promise<string> {
  const res = await request(app).post('/v1/endpoints').set(auth(key)).send(body);
  expect(res.status).toBe(201);
  return (res.body as { id: string }).id;
}

function ingest(body: object, idempotencyKey?: string, key = apiKey) {
  const req = request(app).post('/v1/messages').set(auth(key));
  if (idempotencyKey !== undefined) {
    void req.set('Idempotency-Key', idempotencyKey);
  }
  return req.send(body);
}

const invoicePaid = { event_type: 'invoice.paid', payload: { invoice_id: 'inv_1', amount: 4200 } };

describe('POST /v1/messages', () => {
  it('requires an API key', async () => {
    const res = await request(app).post('/v1/messages').send(invoicePaid);
    expect(res.status).toBe(401);
  });

  it('stores the message and fans out to subscribed, active endpoints only', async () => {
    const all = await createEndpoint({ url: 'https://a.example.com/hook' }); // every event type
    const subscribed = await createEndpoint({
      url: 'https://b.example.com/hook',
      event_types: ['invoice.paid', 'invoice.voided'],
    });
    await createEndpoint({ url: 'https://c.example.com/hook', event_types: ['user.created'] });
    await createEndpoint({ url: 'https://d.example.com/hook', active: false });

    const res = await ingest(invoicePaid).set('X-Request-Id', 'req-ingest-1');
    expect(res.status).toBe(202);
    const body = res.body as IngestBody;
    expect(body.deliveries).toBe(2);

    const message = await pool.query<{ event_type: string; payload: unknown; request_id: string }>(
      'SELECT event_type, payload, request_id FROM messages WHERE id = $1',
      [body.id],
    );
    expect(message.rows[0]).toEqual({
      event_type: 'invoice.paid',
      payload: invoicePaid.payload,
      request_id: 'req-ingest-1',
    });

    const deliveries = await pool.query<{ endpoint_id: string; status: string }>(
      'SELECT endpoint_id, status, attempt_count FROM deliveries WHERE message_id = $1',
      [body.id],
    );
    expect(deliveries.rows.map((d) => d.endpoint_id).sort()).toEqual([all, subscribed].sort());
    expect(deliveries.rows.every((d) => d.status === 'pending')).toBe(true);
  });

  it('stores the message even when no endpoint is subscribed', async () => {
    const res = await ingest(invoicePaid);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ deliveries: 0 });
  });

  it('never fans out to another application’s endpoints', async () => {
    const other = await createApplication(app, 'Other');
    await createEndpoint({ url: 'https://other.example.com/hook' }, other.api_key);

    const res = await ingest(invoicePaid);
    expect(res.body).toMatchObject({ deliveries: 0 });
  });

  it('validates the body', async () => {
    const cases = [
      {},
      { event_type: 'Invoice Paid', payload: {} },
      { event_type: 'invoice.paid', payload: [1, 2] },
      { event_type: 'invoice.paid', payload: 'text' },
      { event_type: 'invoice.paid', payload: {}, extra: true },
    ];
    for (const body of cases) {
      const res = await ingest(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('rejects an invalid Idempotency-Key header', async () => {
    const res = await ingest(invoicePaid, 'has spaces');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errors: [{ location: 'headers', path: 'idempotency-key' }] });
  });

  it('rejects bodies over 256 KiB with 413', async () => {
    const res = await ingest({ event_type: 'big', payload: { blob: 'x'.repeat(300 * 1024) } });
    expect(res.status).toBe(413);
  });
});

describe('idempotency', () => {
  it('replays the original response for the same key and body', async () => {
    await createEndpoint({ url: 'https://a.example.com/hook' });

    const first = await ingest(invoicePaid, 'order-42');
    expect(first.status).toBe(202);
    expect(first.headers['idempotent-replayed']).toBeUndefined();

    // Same content, different key order and formatting: still the same request.
    const second = await ingest(
      { payload: { amount: 4200, invoice_id: 'inv_1' }, event_type: 'invoice.paid' },
      'order-42',
    );
    expect(second.status).toBe(202);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);

    const counts = await pool.query<{ messages: number; deliveries: number }>(
      `SELECT (SELECT count(*)::int FROM messages) AS messages,
              (SELECT count(*)::int FROM deliveries) AS deliveries`,
    );
    expect(counts.rows[0]).toEqual({ messages: 1, deliveries: 1 });
  });

  it('returns 422 when the key is reused with a different body', async () => {
    await ingest(invoicePaid, 'order-42');
    const res = await ingest({ ...invoicePaid, payload: { invoice_id: 'inv_2' } }, 'order-42');
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ type: 'idempotency-key-reused' });
  });

  it('scopes keys per application', async () => {
    const other = await createApplication(app, 'Other');
    const mine = await ingest(invoicePaid, 'order-42');
    const theirs = await ingest(invoicePaid, 'order-42', other.api_key);
    expect(theirs.status).toBe(202);
    expect(theirs.headers['idempotent-replayed']).toBeUndefined();
    expect((theirs.body as IngestBody).id).not.toBe((mine.body as IngestBody).id);
  });

  it('never deduplicates messages without a key', async () => {
    const a = await ingest(invoicePaid);
    const b = await ingest(invoicePaid);
    expect((a.body as IngestBody).id).not.toBe((b.body as IngestBody).id);
  });

  it('creates exactly one message when equal requests race', async () => {
    await createEndpoint({ url: 'https://a.example.com/hook' });

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => ingest(invoicePaid, 'race-key')),
    );

    expect(responses.every((r) => r.status === 202)).toBe(true);
    const ids = new Set(responses.map((r) => (r.body as IngestBody).id));
    expect(ids.size).toBe(1);
    expect(responses.filter((r) => r.headers['idempotent-replayed'] === undefined)).toHaveLength(1);

    const counts = await pool.query<{ messages: number; deliveries: number }>(
      `SELECT (SELECT count(*)::int FROM messages) AS messages,
              (SELECT count(*)::int FROM deliveries) AS deliveries`,
    );
    expect(counts.rows[0]).toEqual({ messages: 1, deliveries: 1 });
  });
});

describe('schema constraints', () => {
  it('rejects a delivery whose endpoint belongs to another application', async () => {
    const other = await createApplication(app, 'Other');
    const foreignEndpoint = await createEndpoint(
      { url: 'https://other.example.com/hook' },
      other.api_key,
    );
    const { id: messageId } = (await ingest(invoicePaid)).body as IngestBody;

    // The composite FK (app_id, endpoint_id) → endpoints (app_id, id) makes this impossible.
    await expect(
      pool.query(
        `INSERT INTO deliveries (app_id, message_id, endpoint_id)
         SELECT app_id, id, $2 FROM messages WHERE id = $1`,
        [messageId, foreignEndpoint],
      ),
    ).rejects.toThrow(/deliveries_endpoint_fkey/);
  });
});
