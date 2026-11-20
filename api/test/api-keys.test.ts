import { describe, expect, it } from 'vitest';
import {
  bearerToken,
  generateApiKey,
  hashApiKey,
  parseApiKeyPrefix,
} from '../src/auth/api-keys.ts';

describe('API keys', () => {
  it('generates whd_<12 hex>_<43 base64url> keys whose prefix and hash match', () => {
    const { key, prefix, hash } = generateApiKey();
    expect(key).toMatch(/^whd_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
    expect(parseApiKeyPrefix(key)).toBe(prefix);
    expect(hash.equals(hashApiKey(key))).toBe(true);
    expect(hash).toHaveLength(32);
  });

  it('generates a different key every time', () => {
    expect(generateApiKey().key).not.toBe(generateApiKey().key);
  });

  it('rejects strings that are not API keys', () => {
    expect(parseApiKeyPrefix('whd_short_abc')).toBeUndefined();
    expect(parseApiKeyPrefix('Bearer whd_x')).toBeUndefined();
    expect(parseApiKeyPrefix('')).toBeUndefined();
  });

  it('extracts bearer tokens', () => {
    expect(bearerToken('Bearer abc.123')).toBe('abc.123');
    expect(bearerToken('bearer abc')).toBe('abc');
    expect(bearerToken('Basic abc')).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
  });
});
