import { describe, expect, it } from 'vitest';
import { clearSession, loadSession, saveSession } from '../src/session.ts';

// A minimal in-memory Storage (Vitest runs in Node here, which has no sessionStorage).
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  };
}

describe('session storage', () => {
  it('round-trips a session', () => {
    const storage = memoryStorage();
    const session = { apiUrl: 'http://localhost:3000', apiKey: 'whd_abc_secret' };
    saveSession(session, storage);
    expect(loadSession(storage)).toEqual(session);
    clearSession(storage);
    expect(loadSession(storage)).toBeUndefined();
  });

  it('ignores corrupted values', () => {
    const storage = memoryStorage();
    storage.setItem('webhook-delivery.session', '{not json');
    expect(loadSession(storage)).toBeUndefined();
    storage.setItem('webhook-delivery.session', '{"apiUrl":1}');
    expect(loadSession(storage)).toBeUndefined();
  });
});
