import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { createApiClient, normalizeApiUrl, type Session } from '../api/client.ts';
import { ErrorMessage } from './ErrorMessage.tsx';

const DEFAULT_API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

// Asks for the API URL and an application's API key, and checks them with one real request
// before accepting them (a wrong key → 401 shown right here).
export function ConnectForm({ onConnect }: { onConnect: (session: Session) => void }) {
  const [apiUrl, setApiUrl] = useState(DEFAULT_API_URL);
  const [apiKey, setApiKey] = useState('');
  const [urlError, setUrlError] = useState<unknown>(undefined);

  const check = useMutation({
    mutationFn: async (candidate: Session) => {
      await createApiClient(candidate).listEndpoints(undefined, 1);
      return candidate;
    },
    onSuccess: onConnect,
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); // stop the browser's own form submission (a full page reload)
    setUrlError(undefined);
    try {
      check.mutate({ apiUrl: normalizeApiUrl(apiUrl), apiKey: apiKey.trim() });
    } catch (error) {
      check.reset();
      setUrlError(error);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>Connect</h2>
      <p className="muted">
        Use the API key returned by <code>POST /v1/applications</code>. It is kept in this tab only
        (sessionStorage).
      </p>
      <label>
        API URL
        <input value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} required />
      </label>
      <label>
        API key
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="whd_…"
          autoComplete="off"
          required
        />
      </label>
      <button type="submit" disabled={check.isPending}>
        {check.isPending ? 'Checking…' : 'Connect'}
      </button>
      <ErrorMessage error={urlError ?? check.error} />
    </form>
  );
}
