import type { Session } from './api/client.ts';

// The API key is kept in sessionStorage: it survives a page reload but is gone when the tab is
// closed, and it is never sent anywhere except the API. (localStorage would keep it forever.)
// Any page script can read it, so the dashboard must never render untrusted HTML.
const KEY = 'webhook-delivery.session';

export function loadSession(storage: Storage = sessionStorage): Session | undefined {
  try {
    const raw = storage.getItem(KEY);
    if (raw === null) return undefined;
    const value = JSON.parse(raw) as Partial<Session>;
    return typeof value.apiUrl === 'string' && typeof value.apiKey === 'string'
      ? { apiUrl: value.apiUrl, apiKey: value.apiKey }
      : undefined;
  } catch {
    return undefined; // storage blocked or corrupted: just ask again
  }
}

export function saveSession(session: Session, storage: Storage = sessionStorage): void {
  try {
    storage.setItem(KEY, JSON.stringify(session));
  } catch {
    // storage blocked (private mode): the session lives only in memory
  }
}

export function clearSession(storage: Storage = sessionStorage): void {
  try {
    storage.removeItem(KEY);
  } catch {
    // nothing to clear
  }
}
