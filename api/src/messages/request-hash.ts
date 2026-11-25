import { createHash } from 'node:crypto';

// The "same body?" check of idempotent ingest (SPEC §6) compares hashes of the request, so it
// must not depend on formatting: `{"a":1,"b":2}` and `{ "b": 2, "a": 1 }` are the same request.
// canonicalJson() serializes with object keys sorted at every level and no whitespace; array
// order is kept (it is meaningful in JSON).

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined) // JSON.stringify drops undefined fields too
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) // by UTF-16 code unit, locale-independent
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  // string, number, boolean, null: JSON.stringify already has a single canonical form.
  return JSON.stringify(value);
}

// SHA-256 → 32 bytes, stored in messages.request_hash.
export function hashRequest(body: {
  event_type: string;
  payload: Record<string, unknown>;
}): Buffer {
  return createHash('sha256').update(canonicalJson(body)).digest();
}
