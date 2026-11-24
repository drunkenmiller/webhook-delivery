import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import type { ApiClient } from '../api/client.ts';
import type { CreatedEndpoint, Endpoint } from '../api/types.ts';
import { ErrorMessage } from './ErrorMessage.tsx';

const ENDPOINTS_KEY = ['endpoints'] as const;

export function EndpointsPage({ api }: { api: ApiClient }) {
  // Cursor pagination maps directly onto useInfiniteQuery: each page's next_cursor is the
  // pageParam of the next fetch; null means "no more pages".
  const endpoints = useInfiniteQuery({
    queryKey: ENDPOINTS_KEY,
    queryFn: ({ pageParam }) => api.listEndpoints(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
  });

  const rows = endpoints.data?.pages.flatMap((page) => page.data) ?? [];

  return (
    <section>
      <CreateEndpointForm api={api} />
      <div className="card">
        <h2>Endpoints</h2>
        {endpoints.isPending && <p className="muted">Loading…</p>}
        <ErrorMessage error={endpoints.error} />
        {endpoints.isSuccess && rows.length === 0 && (
          <p className="muted">No endpoints yet — create one above.</p>
        )}
        {rows.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>URL</th>
                <th>Event types</th>
                <th>Status</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((endpoint) => (
                <EndpointRow key={endpoint.id} api={api} endpoint={endpoint} />
              ))}
            </tbody>
          </table>
        )}
        {endpoints.hasNextPage && (
          <button
            type="button"
            onClick={() => void endpoints.fetchNextPage()}
            disabled={endpoints.isFetchingNextPage}
          >
            {endpoints.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>
    </section>
  );
}

function EndpointRow({ api, endpoint }: { api: ApiClient; endpoint: Endpoint }) {
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: () => api.updateEndpoint(endpoint.id, { active: !endpoint.active }),
    // Refetch the list so every page shows the server's truth.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ENDPOINTS_KEY }),
  });

  return (
    <tr>
      <td>
        <code>{endpoint.url}</code>
      </td>
      <td>{endpoint.event_types.length === 0 ? <em>all</em> : endpoint.event_types.join(', ')}</td>
      <td>
        <span className={endpoint.active ? 'badge ok' : 'badge'}>
          {endpoint.active ? 'active' : 'inactive'}
        </span>
      </td>
      <td className="muted">{new Date(endpoint.created_at).toLocaleString()}</td>
      <td>
        <button
          type="button"
          className="link"
          onClick={() => toggle.mutate()}
          disabled={toggle.isPending}
        >
          {endpoint.active ? 'Deactivate' : 'Activate'}
        </button>
        <ErrorMessage error={toggle.error} />
      </td>
    </tr>
  );
}

function CreateEndpointForm({ api }: { api: ApiClient }) {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState('');
  const [eventTypes, setEventTypes] = useState('');
  const [created, setCreated] = useState<CreatedEndpoint | undefined>(undefined);

  const create = useMutation({
    mutationFn: () =>
      api.createEndpoint({
        url: url.trim(),
        // "invoice.paid, invoice.voided" → ["invoice.paid", "invoice.voided"]; empty → all events
        event_types: eventTypes
          .split(',')
          .map((type) => type.trim())
          .filter((type) => type !== ''),
      }),
    onSuccess: (endpoint) => {
      setCreated(endpoint);
      setUrl('');
      setEventTypes('');
      return queryClient.invalidateQueries({ queryKey: ENDPOINTS_KEY });
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreated(undefined);
    create.mutate();
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>New endpoint</h2>
      <label>
        URL
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com/webhooks"
          required
        />
      </label>
      <label>
        Event types <span className="muted">(comma-separated; empty = all)</span>
        <input
          value={eventTypes}
          onChange={(e) => setEventTypes(e.target.value)}
          placeholder="invoice.paid, invoice.voided"
        />
      </label>
      <button type="submit" disabled={create.isPending}>
        {create.isPending ? 'Creating…' : 'Create endpoint'}
      </button>
      <ErrorMessage error={create.error} />
      {created && (
        <div className="notice" role="status">
          <strong>Signing secret — copy it now, it will not be shown again:</strong>
          <code className="secret">{created.secret}</code>
        </div>
      )}
    </form>
  );
}
