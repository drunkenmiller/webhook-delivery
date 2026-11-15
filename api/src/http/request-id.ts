import { randomUUID } from 'node:crypto';

// Accept a caller-provided X-Request-Id only if it is short and made of safe characters,
// so it cannot inject anything into logs or headers. Otherwise generate a new one.
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function resolveRequestId(header: string | string[] | undefined): string {
  if (typeof header === 'string' && SAFE_REQUEST_ID.test(header)) {
    return header;
  }
  return randomUUID();
}
