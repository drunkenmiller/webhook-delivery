# 0006. Retries with exponential backoff, full jitter and a DLQ

- Status: Proposed
- Date: 2026-11-13

## Context
Customer endpoints fail in ordinary ways: deploys, 5xx, timeouts, rate limits. Retrying immediately
hammers a struggling endpoint; retrying everything at the same moment creates synchronized spikes.
Some deliveries will never succeed and must not retry forever.

## Decision
- Failed attempts are rescheduled with **exponential backoff and full jitter**:
  `delay = random(0, min(cap, base × 2^(n−1)))`, defaults `base = 5 s`, `cap = 1 h`, `max_attempts = 8`.
- After `max_attempts`, the delivery becomes `dead` (our dead-letter queue is a status, not a separate table).
- `POST /v1/deliveries/:id/replay` moves a dead delivery back to `pending` with a fresh attempt budget.
- Success is any 2xx; redirects are not followed.

## Alternatives considered
- **Fixed interval** — synchronized retries, slow recovery or too aggressive.
- **Exponential without jitter** — clients that failed together retry together (thundering herd).
- **Separate DLQ table** — moving rows adds complexity; a status keeps history in one place.

## Consequences
- Retry timing is non-deterministic → tests must inject the random source / clock.
- A permanently broken endpoint still consumes 8 attempts per message; a circuit breaker per endpoint is a stretch goal.
- `410 Gone` could disable an endpoint automatically (later).
