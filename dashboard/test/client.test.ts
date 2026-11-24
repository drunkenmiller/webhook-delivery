import { describe, expect, it } from 'vitest';
import { ApiError, createApiClient, normalizeApiUrl } from '../src/api/client.ts';

const session = { apiUrl: 'http://api.test', apiKey: 'whd_abc_secret' };

interface Call {
  url: string;
  init: RequestInit | undefined;
}

// A fake fetch that records what it was called with and answers with a fixed Response.
function fakeFetch(response: Response) {
  const calls: Call[] = [];
  // The client always passes a string URL, so the fake only accepts strings.
  const fetch = (input: string, init?: RequestInit) => {
    calls.push({ url: input, init });
    return Promise.resolve(response);
  };
  return { fetch, calls };
}

const json = (status: number, body: unknown, type = 'application/json') =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': type } });

describe('createApiClient', () => {
  it('sends the API key and builds the list URL', async () => {
    const page = { data: [], next_cursor: null };
    const { fetch, calls } = fakeFetch(json(200, page));

    await expect(createApiClient(session, fetch).listEndpoints('cur', 50)).resolves.toEqual(page);

    expect(calls[0]?.url).toBe('http://api.test/v1/endpoints?limit=50&cursor=cur');
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.init?.headers).toEqual({ Authorization: 'Bearer whd_abc_secret' });
  });

  it('sends JSON bodies with a Content-Type', async () => {
    const { fetch, calls } = fakeFetch(json(201, { id: '1', secret: 'whsec_x' }));

    await createApiClient(session, fetch).createEndpoint({ url: 'https://example.com/hook' });

    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBe('{"url":"https://example.com/hook"}');
    expect(calls[0]?.init?.headers).toMatchObject({ 'Content-Type': 'application/json' });
  });

  it('returns undefined for 204 No Content', async () => {
    const { fetch } = fakeFetch(new Response(null, { status: 204 }));
    await expect(
      createApiClient(session, fetch).deactivateEndpoint('a/b'),
    ).resolves.toBeUndefined();
  });

  it('turns problem+json errors into ApiError', async () => {
    const problem = {
      type: 'validation-error',
      title: 'Invalid request',
      status: 400,
      errors: [{ location: 'body', path: 'url', message: 'Invalid URL' }],
    };
    const { fetch } = fakeFetch(json(400, problem, 'application/problem+json'));

    const error = await createApiClient(session, fetch)
      .createEndpoint({ url: 'nope' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 400, problem, message: 'Invalid request' });
  });

  it('copes with non-JSON error bodies', async () => {
    const { fetch } = fakeFetch(new Response('Bad Gateway', { status: 502 }));
    await expect(createApiClient(session, fetch).listEndpoints()).rejects.toMatchObject({
      status: 502,
      problem: undefined,
      message: 'HTTP 502',
    });
  });
});

describe('normalizeApiUrl', () => {
  it.each([
    ['http://localhost:3000', 'http://localhost:3000'],
    ['http://localhost:3000/', 'http://localhost:3000'],
    ['  https://api.example.com/base//  ', 'https://api.example.com/base'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeApiUrl(input)).toBe(expected);
  });

  it('throws on something that is not an http(s) URL', () => {
    expect(() => normalizeApiUrl('not a url')).toThrow();
    // Parses, with "localhost:" as the scheme — must still be rejected.
    expect(() => normalizeApiUrl('localhost:3000')).toThrow(/http/);
  });
});
