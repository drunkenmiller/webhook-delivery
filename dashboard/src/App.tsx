import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { createApiClient, type Session } from './api/client.ts';
import { ConnectForm } from './components/ConnectForm.tsx';
import { EndpointsPage } from './components/EndpointsPage.tsx';
import { clearSession, loadSession, saveSession } from './session.ts';

export function App() {
  const queryClient = useQueryClient();
  // Lazy initial state: read sessionStorage once, on the first render only.
  const [session, setSession] = useState<Session | undefined>(() => loadSession());
  // A new client only when the session changes (useMemo caches it between renders).
  const api = useMemo(() => (session ? createApiClient(session) : undefined), [session]);

  function connect(next: Session) {
    saveSession(next);
    setSession(next);
  }

  function disconnect() {
    clearSession();
    queryClient.clear(); // drop every cached response of the previous application
    setSession(undefined);
  }

  return (
    <main className="container">
      <header className="header">
        <h1>webhook-delivery</h1>
        {session && (
          <div className="session">
            <span className="muted">
              {session.apiUrl} · <code>{session.apiKey.split('_').slice(0, 2).join('_')}_…</code>
            </span>
            <button type="button" className="link" onClick={disconnect}>
              Disconnect
            </button>
          </div>
        )}
      </header>
      {api ? <EndpointsPage api={api} /> : <ConnectForm onConnect={connect} />}
    </main>
  );
}
