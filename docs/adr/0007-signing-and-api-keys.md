# 0007. Standard Webhooks signing and hashed API keys

- Status: Proposed
- Date: 2026-11-13

## Context
Receivers must be able to verify that a request came from us and is recent. Producers authenticate
with API keys, which must not be recoverable from a database leak.

## Decision
- **Outbound signing** follows [Standard Webhooks](https://www.standardwebhooks.com/):
  headers `webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64 HMAC-SHA256>` over
  `"{id}.{timestamp}.{body}"`, with a per-endpoint secret `whsec_<base64>`. Including the timestamp in
  the signed content lets receivers reject replays older than a tolerance (5 min).
- **API keys** are `whd_<prefix>_<secret>` with 32 random bytes of secret. We store the prefix
  (lookup) and the **SHA-256** of the full key, and compare hashes in constant time.

## Alternatives considered
- **Custom signature scheme** — no benefit; a standard has existing verification libraries.
- **bcrypt/argon2 for API keys** — designed for low-entropy passwords; for 256-bit random keys a
  fast hash is sufficient and avoids a slow hash on every request.
- **Asymmetric signatures (ed25519)** — receivers would not need a shared secret, but more complex; possible later.

## Consequences
- Endpoint secrets are stored in plaintext (the worker needs them to sign) → the database is sensitive;
  encryption at rest with a KMS key is a later improvement.
- Secret rotation (two valid secrets during a window) is a later feature.
