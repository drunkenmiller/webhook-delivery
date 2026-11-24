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
  const ADMIN_TOKEN = 'a-long-admin-token';

  it('applies defaults', () => {
    expect(loadConfig({ DATABASE_URL, ADMIN_TOKEN })).toEqual({
      NODE_ENV: 'development',
      PORT: 3000,
      LOG_LEVEL: 'info',
      DATABASE_URL,
      ADMIN_TOKEN,
      CORS_ORIGINS: [],
    });
  });

  it('parses ALLOW_PRIVATE_TARGETS as a boolean string', () => {
    expect(loadConfig({ DATABASE_URL, ADMIN_TOKEN, ALLOW_PRIVATE_TARGETS: 'true' })).toMatchObject({
      ALLOW_PRIVATE_TARGETS: true,
    });
    expect(loadConfig({ DATABASE_URL, ADMIN_TOKEN, ALLOW_PRIVATE_TARGETS: 'false' })).toMatchObject(
      { ALLOW_PRIVATE_TARGETS: false },
    );
    expect(() => loadConfig({ DATABASE_URL, ADMIN_TOKEN, ALLOW_PRIVATE_TARGETS: 'maybe' })).toThrow(
      /ALLOW_PRIVATE_TARGETS/,
    );
  });

  it('parses CORS_ORIGINS as a list of origins', () => {
    expect(
      loadConfig({
        DATABASE_URL,
        ADMIN_TOKEN,
        CORS_ORIGINS: 'http://localhost:5173, https://dash.example.com',
      }).CORS_ORIGINS,
    ).toEqual(['http://localhost:5173', 'https://dash.example.com']);
    expect(() =>
      loadConfig({ DATABASE_URL, ADMIN_TOKEN, CORS_ORIGINS: 'http://localhost:5173/' }),
    ).toThrow(/CORS_ORIGINS/);
  });

  it('coerces PORT from a string', () => {
    expect(loadConfig({ DATABASE_URL, ADMIN_TOKEN, PORT: '8080' }).PORT).toBe(8080);
  });

  it('fails fast on invalid values', () => {
    expect(() => loadConfig({ DATABASE_URL, ADMIN_TOKEN, PORT: 'abc' })).toThrow(
      /Invalid configuration/,
    );
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ DATABASE_URL, ADMIN_TOKEN: 'short' })).toThrow(/ADMIN_TOKEN/);
    expect(() => loadConfig({ DATABASE_URL: 'mysql://localhost/db', ADMIN_TOKEN })).toThrow(
      /DATABASE_URL/,
    );
  });
});
