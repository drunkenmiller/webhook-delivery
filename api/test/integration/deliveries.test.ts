import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApplication, createTestContext, resetDatabase } from './helpers.ts';

// Read API (messages, deliveries, attempts) and replay. The worker isn't running here: delivery
// states and attempts are set directly in SQL, the way the worker would leave them.

const { app, pool } = createTestContext();

interface DeliveryBody {
  id: string;
  message_id: string;
  endpoint_id: string;
  status: string;
  attempt_count: number;
  last_error: string | null;
}
interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

let apiKey: string;
let otherKey: string;

beforeEach(async () => {
  await resetDatabase(pool);
  apiKey = (await createApplication(app)).api_key;
  otherKey = (await createApplication(app, 'Other')).api_key;
});

afterAll(async () => {
  await pool.end();
});

const auth = (key = apiKey) => ({ Authorization: `Bearer ${key}` });

async function createEndpoint(url: string, key = apiKey): Promise<string> {
  const res = await request(app).post('/v1/endpoints').set(auth(key)).send({ url });
  expect(res.status).toBe(201);
  return (res.body as { id: string }).id;
}

async function ingest(eventType: string, payload: object = { n: 1 }, key = apiKey) {
  const res = await request(app)
    .post('/v1/messages')
    .set(auth(key))
    .send({ event_type: eventType, payload });
  expect(res.status).toBe(202);
  return (res.body as { id: string }).id;
}

// What the worker does after MAX_ATTEMPTS failures (SPEC §4 rule 6), with two attempt rows.
async function makeDead(deliveryId: string): Promise<void> {
  await pool.query(
    `UPDATE deliveries SET status = 'dead', attempt_count = 2, claim_count = 2,
            last_error = 'HTTP 500' WHERE id = $1`,
    [deliveryId],
  );
  await pool.query(
    `INSERT INTO attempts (delivery_id, attempt_number, worker_id, started_at, duration_ms,
                           status_code, error, response_body_snippet)
     VALUES ($1, 1, 'w1', now(), 12, 500, 'HTTP 500', 'boom'),
            ($1, 2, 'w2', now(), 15, 500, 'HTTP 500', 'boom')`,
    [deliveryId],
  );
}

async function deliveriesOf(messageId: string, key = apiKey): Promise<DeliveryBody[]> {
  const res = await request(app).get(`/v1/messages/${messageId}`).set(auth(key));
  expect(res.status).toBe(200);
  return (res.body as { deliveries: DeliveryBody[] }).deliveries;
}

describe('GET /v1/messages', () => {
  it('lists newest first without payloads, filters by event type, and paginates', async () => {
    const first = await ingest('invoice.paid');
    const second = await ingest('user.created');
    const third = await ingest('invoice.paid');
    await ingest('invoice.paid', { n: 1 }, otherKey); // another tenant: never listed

    const all = await request(app).get('/v1/messages').set(auth());
    const body = all.body as Page<{ id: string; payload?: unknown }>;
    expect(body.data.map((m) => m.id)).toEqual([third, second, first]);
    expect(body.data[0]).not.toHaveProperty('payload');

    const filtered = await request(app).get('/v1/messages?event_type=invoice.paid').set(auth());
    expect((filtered.body as Page<{ id: string }>).data.map((m) => m.id)).toEqual([third, first]);

    const page1 = await request(app).get('/v1/messages?limit=2').set(auth());
    const p1 = page1.body as Page<{ id: string }>;
    expect(p1.data.map((m) => m.id)).toEqual([third, second]);
    const page2 = await request(app)
      .get(`/v1/messages?limit=2&cursor=${p1.next_cursor}`)
      .set(auth());
    const p2 = page2.body as Page<{ id: string }>;
    expect(p2.data.map((m) => m.id)).toEqual([first]);
    expect(p2.next_cursor).toBeNull();
  });

  it('validates the query', async () => {
    expect((await request(app).get('/v1/messages?event_type=Bad Type').set(auth())).status).toBe(
      400,
    );
    expect((await request(app).get('/v1/messages?cursor=garbage').set(auth())).status).toBe(400);
  });
});

describe('GET /v1/messages/:id', () => {
  it('returns the payload and every delivery of the message', async () => {
    const a = await createEndpoint('https://a.example.com/hook');
    const b = await createEndpoint('https://b.example.com/hook');
    const id = await ingest('invoice.paid', { invoice_id: 'inv_1' });

    const res = await request(app).get(`/v1/messages/${id}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id,
      event_type: 'invoice.paid',
      payload: { invoice_id: 'inv_1' },
    });
    const deliveries = (res.body as { deliveries: DeliveryBody[] }).deliveries;
    expect(deliveries.map((d) => d.endpoint_id).sort()).toEqual([a, b].sort());
    expect(deliveries[0]).not.toHaveProperty('locked_by');
    expect(deliveries[0]).not.toHaveProperty('claim_count');
  });

  it('is 404 for another application’s message', async () => {
    const id = await ingest('invoice.paid', {}, otherKey);
    expect((await request(app).get(`/v1/messages/${id}`).set(auth())).status).toBe(404);
  });
});

describe('GET /v1/deliveries', () => {
  it('filters by status, endpoint and message', async () => {
    const a = await createEndpoint('https://a.example.com/hook');
    await createEndpoint('https://b.example.com/hook');
    const m1 = await ingest('invoice.paid');
    const m2 = await ingest('invoice.paid');
    const [dead] = (await deliveriesOf(m1)).filter((d) => d.endpoint_id === a);
    await makeDead(dead!.id);

    const list = async (query: string) => {
      const res = await request(app).get(`/v1/deliveries?${query}`).set(auth());
      expect(res.status).toBe(200);
      return (res.body as Page<DeliveryBody>).data;
    };

    expect(await list('')).toHaveLength(4);
    expect((await list('status=dead')).map((d) => d.id)).toEqual([dead!.id]);
    expect(await list('status=pending')).toHaveLength(3);
    expect((await list(`endpoint_id=${a}`)).every((d) => d.endpoint_id === a)).toBe(true);
    expect((await list(`message_id=${m2}`)).every((d) => d.message_id === m2)).toBe(true);
    expect(await list(`message_id=${m2}&endpoint_id=${a}`)).toHaveLength(1);
  });

  it('never lists another application’s deliveries', async () => {
    await createEndpoint('https://other.example.com/hook', otherKey);
    await ingest('invoice.paid', {}, otherKey);
    const res = await request(app).get('/v1/deliveries').set(auth());
    expect((res.body as Page<DeliveryBody>).data).toEqual([]);
  });

  it('validates filters', async () => {
    for (const query of ['status=lost', 'endpoint_id=nope', 'limit=0']) {
      expect((await request(app).get(`/v1/deliveries?${query}`).set(auth())).status).toBe(400);
    }
  });
});

describe('GET /v1/deliveries/:id and /attempts', () => {
  it('returns the delivery and its attempts oldest first, paginated', async () => {
    await createEndpoint('https://a.example.com/hook');
    const [delivery] = await deliveriesOf(await ingest('invoice.paid'));
    await makeDead(delivery!.id);

    const one = await request(app).get(`/v1/deliveries/${delivery!.id}`).set(auth());
    expect(one.body).toMatchObject({ status: 'dead', attempt_count: 2, last_error: 'HTTP 500' });

    const page1 = await request(app)
      .get(`/v1/deliveries/${delivery!.id}/attempts?limit=1`)
      .set(auth());
    const p1 = page1.body as Page<{ attempt_number: number; status_code: number }>;
    expect(p1.data).toMatchObject([{ attempt_number: 1, status_code: 500 }]);

    const page2 = await request(app)
      .get(`/v1/deliveries/${delivery!.id}/attempts?limit=1&cursor=${p1.next_cursor}`)
      .set(auth());
    const p2 = page2.body as Page<{ attempt_number: number }>;
    expect(p2.data).toMatchObject([{ attempt_number: 2 }]);
    expect(p2.next_cursor).toBeNull();
  });

  it('is 404 for another application’s delivery', async () => {
    await createEndpoint('https://other.example.com/hook', otherKey);
    const [delivery] = await deliveriesOf(await ingest('invoice.paid', {}, otherKey), otherKey);
    expect((await request(app).get(`/v1/deliveries/${delivery!.id}`).set(auth())).status).toBe(404);
    const attempts = await request(app).get(`/v1/deliveries/${delivery!.id}/attempts`).set(auth());
    expect(attempts.status).toBe(404);
  });
});

describe('POST /v1/deliveries/:id/replay', () => {
  it('moves a dead delivery back to pending with a fresh budget and keeps its history', async () => {
    await createEndpoint('https://a.example.com/hook');
    const [delivery] = await deliveriesOf(await ingest('invoice.paid'));
    await makeDead(delivery!.id);

    const res = await request(app).post(`/v1/deliveries/${delivery!.id}/replay`).set(auth());
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: 'pending', attempt_count: 0, last_error: null });

    const { rows } = await pool.query<{ claim_count: number; due: boolean; attempts: number }>(
      `SELECT claim_count, next_attempt_at <= now() AS due,
              (SELECT count(*)::int FROM attempts WHERE delivery_id = d.id) AS attempts
       FROM deliveries d WHERE id = $1`,
      [delivery!.id],
    );
    // Due now for the worker; the fencing token never goes back; history is kept.
    expect(rows[0]).toEqual({ claim_count: 2, due: true, attempts: 2 });
  });

  it('is 409 unless the delivery is dead', async () => {
    await createEndpoint('https://a.example.com/hook');
    const [delivery] = await deliveriesOf(await ingest('invoice.paid'));
    const res = await request(app).post(`/v1/deliveries/${delivery!.id}/replay`).set(auth());
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ type: 'delivery-not-dead' });
  });

  it('is 404 for an unknown or foreign delivery', async () => {
    await createEndpoint('https://other.example.com/hook', otherKey);
    const [foreign] = await deliveriesOf(await ingest('invoice.paid', {}, otherKey), otherKey);
    await makeDead(foreign!.id);

    const res = await request(app).post(`/v1/deliveries/${foreign!.id}/replay`).set(auth());
    expect(res.status).toBe(404);
    const unknown = await request(app)
      .post('/v1/deliveries/01890000-0000-7000-8000-000000000000/replay')
      .set(auth());
    expect(unknown.status).toBe(404);
  });

  it('lets exactly one of two concurrent replays win', async () => {
    await createEndpoint('https://a.example.com/hook');
    const [delivery] = await deliveriesOf(await ingest('invoice.paid'));
    await makeDead(delivery!.id);

    const statuses = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app)
          .post(`/v1/deliveries/${delivery!.id}/replay`)
          .set(auth())
          .then((r) => r.status),
      ),
    );
    expect(statuses.filter((s) => s === 202)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(4);
  });
});
