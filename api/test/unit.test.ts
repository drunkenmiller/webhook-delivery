import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { resolveRequestId } from '../src/http/request-id.ts';

describe('resolveRequestId', () => {
  it('keeps a safe header value', () => {
    expect(resolveRequestId('req_01:abc.def-9')).toBe('req_01:abc.def-9');
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['too long', 'a'.repeat(129)],
    ['unsafe characters', 'abc\n{"injected":true}'],
    ['repeated header', ['a', 'b']],
  ])('generates a new id when the header is %s', (_label, header) => {
    expect(resolveRequestId(header)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('loadConfig', () => {
  const DATABASE_URL = 'postgres://user:pass@localhost:5432/db';

  it('applies defaults', () => {
    expect(loadConfig({ DATABASE_URL })).toEqual({
      NODE_ENV: 'development',
      PORT: 3000,
      LOG_LEVEL: 'info',
      DATABASE_URL,
    });
  });

  it('coerces PORT from a string', () => {
    expect(loadConfig({ DATABASE_URL, PORT: '8080' }).PORT).toBe(8080);
  });

  it('fails fast on invalid values', () => {
    expect(() => loadConfig({ DATABASE_URL, PORT: 'abc' })).toThrow(/Invalid configuration/);
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ DATABASE_URL: 'mysql://localhost/db' })).toThrow(/DATABASE_URL/);
  });
});
