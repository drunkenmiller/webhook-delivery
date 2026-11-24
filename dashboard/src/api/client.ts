import type {
  CreateEndpointInput,
  CreatedEndpoint,
  Endpoint,
  Page,
  Problem,
  UpdateEndpointInput,
} from './types.ts';

// Where the dashboard talks to, and with which application's API key.
export interface Session {
  apiUrl: string; // e.g. http://localhost:3000 (no trailing slash)
  apiKey: string; // whd_<prefix>_<secret>
}

// Thrown for every non-2xx answer, carrying the problem+json body when there is one, so the UI
// can show `detail` and per-field `errors`.
export class ApiError extends Error {
  readonly status: number;
  readonly problem: Problem | undefined;

  constructor(status: number, problem: Problem | undefined) {
    super(problem?.detail ?? problem?.title ?? `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.problem = problem;
  }
}

// `fetchFn` is injectable so tests can pass a fake instead of the real network (same idea as the
// `Db` fake in the API tests).
// Only the (url string, init) form of fetch is used, so that is all a fake has to implement.
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export function createApiClient(session: Session, fetchFn: FetchFn = fetch) {
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${session.apiKey}` };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetchFn(`${session.apiUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

    if (!res.ok) {
      throw new ApiError(res.status, await readProblem(res));
    }
    if (res.status === 204) {
      return undefined as T; // no body (e.g. DELETE)
    }
    return (await res.json()) as T;
  }

  return {
    listEndpoints(cursor?: string, limit = 20): Promise<Page<Endpoint>> {
      const query = new URLSearchParams({ limit: String(limit) });
      if (cursor !== undefined) {
        query.set('cursor', cursor);
      }
      return request('GET', `/v1/endpoints?${query.toString()}`);
    },
    createEndpoint(input: CreateEndpointInput): Promise<CreatedEndpoint> {
      return request('POST', '/v1/endpoints', input);
    },
    updateEndpoint(id: string, input: UpdateEndpointInput): Promise<Endpoint> {
      return request('PATCH', `/v1/endpoints/${encodeURIComponent(id)}`, input);
    },
    deactivateEndpoint(id: string): Promise<void> {
      return request('DELETE', `/v1/endpoints/${encodeURIComponent(id)}`);
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

async function readProblem(res: Response): Promise<Problem | undefined> {
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('json')) {
    return undefined;
  }
  try {
    return (await res.json()) as Problem;
  } catch {
    return undefined; // the body said JSON but wasn't
  }
}

// "http://localhost:3000/" → "http://localhost:3000". Throws unless it is an http(s) URL.
// Beware: new URL('localhost:3000') does NOT throw — it parses "localhost:" as the scheme.
export function normalizeApiUrl(input: string): string {
  const url = new URL(input.trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('The API URL must start with http:// or https://');
  }
  return url.origin + url.pathname.replace(/\/+$/, '');
}
