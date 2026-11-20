import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApplication, createTestContext, resetDatabase } from './helpers.ts';

const { app, pool } = createTestContext();

interface EndpointBody {
  id: string;
  url: string;
  event_types: string[];
  active: boolean;
  secret?: string;
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

async function createEndpoint(body: object = { url: 'https://example.com/hook' }, key = apiKey) {
  const res = await request(app).post('/v1/endpoints').set(auth(key)).send(body);
  expect(res.status).toBe(201);
  return res.body as EndpointBody;
}

describe('authentication', () => {
  it('rejects requests without a valid API key', async () => {
    expect((await request(app).get('/v1/endpoints')).status).toBe(401);
    expect(
      (
        await request(app)
          .get('/v1/endpoints')
          .set(auth('whd_000000000000_' + 'x'.repeat(43)))
      ).status,
    ).toBe(401);

    // Right prefix, wrong secret.
    const tampered = apiKey.slice(0, -1) + (apiKey.endsWith('A') ? 'B' : 'A');
    const res = await request(app).get('/v1/endpoints').set(auth(tampered));
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
  });
});

describe('POST /v1/endpoints', () => {
  it('creates an endpoint and returns the signing secret once', async () => {
    const created = await createEndpoint({
      url: 'https://example.com/hook',
      event_types: ['invoice.paid'],
    });
    expect(created).toMatchObject({
      url: 'https://example.com/hook',
      event_types: ['invoice.paid'],
      active: true,
    });
    expect(created.secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);

    const fetched = await request(app).get(`/v1/endpoints/${created.id}`).set(auth());
    expect(fetched.status).toBe(200);
    expect(fetched.body).not.toHaveProperty('secret');
  });

  it('defaults to all event types and active', async () => {
    const created = await createEndpoint();
    expect(created).toMatchObject({ event_types: [], active: true });
  });

  it('validates the body', async () => {
    const cases = [
      { url: 'http://example.com/hook' }, // http not allowed in production mode
      { url: 'not a url' },
      { url: 'https://example.com', event_types: ['Invoice Paid'] },
      { url: 'https://example.com', secret: 'whsec_mine' }, // unknown field
    ];
    for (const body of cases) {
      const res = await request(app).post('/v1/endpoints').set(auth()).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe('tenant isolation', () => {
  it("never exposes another application's endpoints", async () => {
    const mine = await createEndpoint();
    const otherKey = (await createApplication(app, 'Other')).api_key;
    await createEndpoint({ url: 'https://other.example.com' }, otherKey);

    expect((await request(app).get(`/v1/endpoints/${mine.id}`).set(auth(otherKey))).status).toBe(
      404,
    );
    expect(
      (
        await request(app)
          .patch(`/v1/endpoints/${mine.id}`)
          .set(auth(otherKey))
          .send({ active: false })
      ).status,
    ).toBe(404);
    expect((await request(app).delete(`/v1/endpoints/${mine.id}`).set(auth(otherKey))).status).toBe(
      404,
    );

    const list = await request(app).get('/v1/endpoints').set(auth(otherKey));
    expect((list.body as { data: EndpointBody[] }).data.map((e) => e.url)).toEqual([
      'https://other.example.com',
    ]);
  });
});

describe('GET /v1/endpoints (cursor pagination)', () => {
  it('pages through all endpoints, newest first, without repeats', async () => {
    const created: string[] = [];
    for (let i = 0; i < 5; i++) {
      created.push((await createEndpoint({ url: `https://example.com/${i}` })).id);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await request(app)
        .get('/v1/endpoints')
        .query({ limit: 2, ...(cursor && { cursor }) })
        .set(auth());
      expect(res.status).toBe(200);
      const body = res.body as { data: EndpointBody[]; next_cursor: string | null };
      seen.push(...body.data.map((e) => e.id));
      cursor = body.next_cursor;
    } while (cursor !== null);

    expect(seen).toEqual([...created].reverse());
  });

  it('rejects an invalid cursor', async () => {
    const res = await request(app).get('/v1/endpoints?cursor=garbage').set(auth());
    expect(res.status).toBe(400);
  });
});

describe('PATCH and DELETE /v1/endpoints/:id', () => {
  it('updates only the provided fields', async () => {
    const created = await createEndpoint({ url: 'https://example.com/a', event_types: ['a.b'] });
    const res = await request(app)
      .patch(`/v1/endpoints/${created.id}`)
      .set(auth())
      .send({ active: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      url: 'https://example.com/a',
      event_types: ['a.b'],
      active: false,
    });
  });

  it('rejects an empty update', async () => {
    const created = await createEndpoint();
    const res = await request(app).patch(`/v1/endpoints/${created.id}`).set(auth()).send({});
    expect(res.status).toBe(400);
  });

  it('DELETE deactivates (soft delete) and keeps the row', async () => {
    const created = await createEndpoint();
    const res = await request(app).delete(`/v1/endpoints/${created.id}`).set(auth());
    expect(res.status).toBe(204);

    const fetched = await request(app).get(`/v1/endpoints/${created.id}`).set(auth());
    expect(fetched.status).toBe(200);
    expect(fetched.body).toMatchObject({ active: false });
  });

  it('answers 404 for an unknown id and 400 for a malformed one', async () => {
    const unknown = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
    expect((await request(app).get(`/v1/endpoints/${unknown}`).set(auth())).status).toBe(404);
    expect((await request(app).get('/v1/endpoints/not-a-uuid').set(auth())).status).toBe(400);
  });
});
