# 0003. At-least-once delivery with idempotency on both sides

- Status: Proposed
- Date: 2026-11-13

## Context
A worker can send a webhook, the receiver can process it, and the worker can crash (or time out)
before recording success. From the sender's side, "delivered" and "not delivered" are then
indistinguishable. Producers can also retry `POST /v1/messages` after a network error.

## Decision
We will guarantee **at-least-once** delivery and push deduplication to the edges:

- **Inbound:** `POST /v1/messages` accepts an `Idempotency-Key`. `UNIQUE (app_id, idempotency_key)`
  plus a stored request hash makes retries return the original response instead of creating new
  deliveries.
- **Outbound:** every attempt carries `webhook-id` = message id, identical across retries, so
  receivers can deduplicate.

## Alternatives considered
- **At-most-once** (mark as sent before sending) — loses events on crashes; unacceptable for webhooks.
- **Exactly-once** — impossible across an HTTP boundary we do not control without the receiver's
  cooperation; the receiver-side dedup by `webhook-id` is exactly that cooperation.

## Consequences
- Receivers must be idempotent; documented in the README and the receiver example.
- Duplicates are expected in rare cases (crash after send, lease expiry during a slow request).
- Idempotency keys are kept forever in the MVP; a retention window (e.g. 24 h–30 days) is a later decision.
