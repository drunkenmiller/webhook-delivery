import { createHash, randomBytes } from 'node:crypto';

// API keys look like `whd_<prefix>_<secret>`:
//   prefix: 12 hex chars, public — stored as is, used to find the application and to show
//           the key in a UI ("whd_3f9a…") without revealing it.
//   secret: 32 random bytes in base64url (43 chars) — never stored.
// The database keeps only SHA-256(full key). A fast hash is fine because the key has 256 bits of
// randomness: brute force is impossible, unlike human passwords that need bcrypt/argon2 (ADR 0007).

const API_KEY_PATTERN = /^whd_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;

export interface GeneratedApiKey {
  key: string; // shown to the user ONCE
  prefix: string;
  hash: Buffer;
}

export function generateApiKey(): GeneratedApiKey {
  const prefix = randomBytes(6).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  const key = `whd_${prefix}_${secret}`;
  return { key, prefix, hash: hashApiKey(key) };
}

// Returns the prefix if the string has the API key format, otherwise undefined.
export function parseApiKeyPrefix(key: string): string | undefined {
  return API_KEY_PATTERN.exec(key)?.[1];
}

export function hashApiKey(key: string): Buffer {
  return createHash('sha256').update(key).digest();
}

// Extracts the token from an `Authorization: Bearer <token>` header.
export function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer ([^\s]+)$/i.exec(header ?? '');
  return match?.[1];
}
