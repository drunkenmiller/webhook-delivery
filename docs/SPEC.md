# webhook-delivery — Specification (v1 / MVP)

> Status: **Draft** · Last updated: 2026-11-26
>
> This is the source of truth for *what* the system does. *Why* a decision was made lives in
> [`docs/adr/`](adr/). When the spec and the code disagree, fix one of them in the same PR.

## 1. Overview

A reliable webhook delivery service. Producers (our "customers") send events to an HTTP API; the
service fans each event out to every subscribed endpoint and delivers it with signed HTTP requests,
retrying with exponential backoff and jitter. Deliveries that exhaust their retries go to a
dead-letter state and can be replayed manually.

```
Producer ──POST /v1/messages──▶ API (Node.js/Express)
                                  │  one transaction: insert message + one delivery per endpoint
                                  ▼
                              PostgreSQL ◀── claim (FOR UPDATE SKIP LOCKED + lease) ── Worker (Go) ──signed POST──▶ Customer endpoints
                                  ▲
Dashboard (React) ──REST──▶ API ──┘
```

### Components

| Component | Tech | Responsibility |
|---|---|---|
| `api/` | Node.js 24, TypeScript, Express 5, zod, pino, `pg` | Auth, validation, ingest, management/read endpoints, replay |
| `worker/` | Go, `pgx`, `net/http` | Claim due deliveries, send signed requests, record attempts, schedule retries |
| `db/migrations/` | PostgreSQL 18, dbmate (plain SQL) | Single schema shared by API and worker |
| `dashboard/` | Vite, React, TypeScript, TanStack Query | Browse endpoints, messages, deliveries, attempts; trigger replay (December) |

## 2. Requirements

### Functional
- **F1** An application authenticates with an API key and manages its endpoints (URL + subscribed event types).
- **F2** An application submits a message (`event_type` + JSON `payload`). The service creates one delivery
  per active endpoint subscribed to that event type.
- **F3** Message submission is idempotent per `(application, Idempotency-Key)`.
- **F4** Each delivery is attempted until it succeeds or reaches the attempt limit; failures are retried
  with exponential backoff + full jitter.
- **F5** Every request to a customer endpoint is signed (HMAC-SHA256) so the receiver can verify origin and freshness.
- **F6** Every attempt is recorded (status code, duration, error).
- **F7** Deliveries that exhaust retries become `dead` (DLQ) and can be replayed through the API.
- **F8** Read APIs list messages, deliveries and attempts with filters and cursor pagination.

### Non-functional
- **N1 Delivery semantics:** at-least-once. No delivery is lost if a worker crashes; duplicates are possible
  and receivers deduplicate using `webhook-id` (ADR 0003).
- **N2 Durability:** a `202` from `POST /v1/messages` means the message and all its deliveries are committed.
- **N3 Horizontal scaling:** any number of worker processes can run concurrently without double-claiming a delivery.
- **N4 Isolation:** a slow or failing endpoint must not block deliveries to other endpoints beyond the
  per-request timeout (MVP); per-endpoint limits/circuit breaker are stretch goals.
- **N5 Observability:** structured JSON logs with a correlation ID from API to worker; `/metrics` in Prometheus format.
- **N6 Security:** API keys stored only as hashes; endpoint secrets never logged; payload size limited.

### Out of scope (MVP)
Multi-region, exactly-once delivery, ordering guarantees between messages, payload transformations
(planned for 2027 with WebAssembly), user accounts / UI login, per-endpoint rate limiting (stretch),
endpoint verification handshake.

## 3. Data model

PostgreSQL 18. IDs are `uuid` generated with `uuidv7()` (time-ordered → index locality and natural
cursor pagination). All timestamps are `timestamptz`.

### `applications`
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| name | text NOT NULL | |
| api_key_prefix | text NOT NULL UNIQUE | short public part of the key, used for lookup and display |
| api_key_hash | bytea NOT NULL | SHA-256 of the full key (keys are high-entropy random → fast hash is fine, ADR 0007) |
| created_at | timestamptz NOT NULL DEFAULT now() | |

### `endpoints`
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| app_id | uuid NOT NULL FK → applications | |
| url | text NOT NULL | `https://` required in production; `http://` allowed in dev |
| secret | text NOT NULL | `whsec_` + base64(32 random bytes); returned once on creation |
| event_types | text[] NOT NULL DEFAULT '{}' | empty array = subscribed to all event types |
| active | boolean NOT NULL DEFAULT true | inactive endpoints get no new deliveries |
| created_at / updated_at | timestamptz NOT NULL DEFAULT now() | `updated_at` is set by the API on every update (no trigger) |

### `messages`
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | also sent as the `webhook-id` header |
| app_id | uuid NOT NULL FK | |
| event_type | text NOT NULL | e.g. `invoice.paid`; must match `^[a-z0-9_.-]{1,64}$` |
| payload | jsonb NOT NULL | ≤ 256 KiB |
| idempotency_key | text NULL | ≤ 255 chars |
| request_hash | bytea NULL | SHA-256 of the canonical request body — detects key reuse with a different body |
| request_id | text NULL | correlation ID of the ingest request |
| created_at | timestamptz NOT NULL DEFAULT now() | |

Constraint: `UNIQUE (app_id, idempotency_key)` (rows with NULL keys are not deduplicated).

### `deliveries`
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| app_id | uuid NOT NULL | denormalized from the message for tenant-filtered reads (ADR 0009) |
| message_id | uuid NOT NULL | FK `(app_id, message_id)` → messages |
| endpoint_id | uuid NOT NULL | FK `(app_id, endpoint_id)` → endpoints — same application guaranteed |
| status | text NOT NULL | `pending` · `in_flight` · `succeeded` · `dead` (CHECK constraint) |
| attempt_count | int NOT NULL DEFAULT 0 | finished attempts; reset by replay |
| claim_count | int NOT NULL DEFAULT 0 | fencing token: +1 on every claim, never reset (ADR 0009) |
| next_attempt_at | timestamptz NOT NULL DEFAULT now() | when the delivery is due next: retry time if `pending`, lease expiry if `in_flight` |
| locked_by | text NULL | worker instance holding the lease |
| locked_until | timestamptz NULL | lease expiry |
| last_error | text NULL | |
| created_at / updated_at | timestamptz | |

Constraints: `UNIQUE (message_id, endpoint_id)`; `in_flight` requires `locked_by` and `locked_until`.
Claim index: `deliveries_due_idx ON (next_attempt_at) WHERE status IN ('pending','in_flight')` —
`EXPLAIN ANALYZE` in ADR 0009.

### `attempts`
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| delivery_id | uuid NOT NULL FK | |
| attempt_number | int NOT NULL | 1-based |
| worker_id | text NOT NULL | |
| started_at | timestamptz NOT NULL | |
| duration_ms | int NOT NULL | |
| status_code | int NULL | NULL when there was no response (timeout, DNS, connection refused) |
| error | text NULL | |
| response_body_snippet | text NULL | first 1 KiB, for debugging |

## 4. Delivery lifecycle

```
             claim (lease)             2xx
 pending ────────────────▶ in_flight ─────────▶ succeeded
    ▲                         │
    │   non-2xx / timeout /   │  attempt_count == max_attempts
    │   network error         ▼
    └──── schedule retry ─────┴──────────▶ dead ──replay──▶ pending

 in_flight with expired lease (worker crashed) ──▶ claimable again
```

Rules:
1. **Claimable** = `status IN ('pending', 'in_flight') AND next_attempt_at <= now()` — for an
   `in_flight` row `next_attempt_at` is the lease expiry, so an expired lease is simply "due" (ADR 0009).
2. **Claim** runs in a short transaction with `SELECT … FOR UPDATE SKIP LOCKED LIMIT <batch>` and sets
   `status = 'in_flight'`, `locked_by`, `locked_until = next_attempt_at = now() + lease` and
   `claim_count = claim_count + 1`. The HTTP request is made **outside** any database transaction.
3. **Lease** (default 30 s) must exceed the request timeout (default 10 s) plus a safety margin.
4. **Completion is fenced:** the worker updates the delivery only
   `WHERE id = $1 AND status = 'in_flight' AND locked_by = $me AND claim_count = $token` (the value
   its claim returned). If 0 rows change, the lease was lost and the outcome is discarded (the
   attempt row is still recorded).
5. **Success** = any `2xx` within the timeout. Redirects are not followed (3xx counts as failure).
6. **Failure** increments `attempt_count`. If `attempt_count >= max_attempts` → `dead`; otherwise →
   `pending` with `next_attempt_at = now() + backoff(attempt_count)`.
7. **Replay** (only from `dead`): `status = 'pending'`, `next_attempt_at = now()`, `attempt_count = 0`.
   Attempt history is kept.

### Retry policy (configurable)
- `max_attempts` = 8 · `base` = 5 s · `cap` = 1 h
- Full jitter: `delay = random_between(0, min(cap, base × 2^(attempt_count − 1)))`

## 5. Outbound webhook format

Follows the [Standard Webhooks](https://www.standardwebhooks.com/) convention.

```http
POST <endpoint.url>
Content-Type: application/json
User-Agent: webhook-delivery/<version>
webhook-id: <message.id>             # identical across retries → receiver's dedup key
webhook-timestamp: <unix seconds>    # time of this attempt
webhook-signature: v1,<base64(HMAC-SHA256(secret_bytes, "{id}.{timestamp}.{body}"))>

<message.payload as JSON>
```

- `secret_bytes` = base64-decode of the secret after removing the `whsec_` prefix.
- Receivers should reject timestamps older than 5 minutes (replay protection) and compare signatures in constant time.
- The repo ships a verification example for receivers and a test receiver for demos (`tools/receiver`).

## 6. HTTP API (`/v1`)

Conventions:
- Auth: `Authorization: Bearer <api_key>`; key format `whd_<prefix>_<secret>`. Admin routes use `ADMIN_TOKEN` (≥ 16 chars). Every authentication failure returns the same `401` with `WWW-Authenticate: Bearer`.
- CORS: browser origins listed in `CORS_ORIGINS` (comma-separated; the dashboard) get `Access-Control-Allow-Origin` and preflight answers; other origins get no CORS headers.
- Request bodies must be `Content-Type: application/json` (charset parameter allowed), otherwise `415`. Requests without a body are not checked.
- Endpoint URLs pointing to loopback, private (RFC 1918, `fc00::/7`), link-local (including `169.254.169.254`), CGNAT, multicast or reserved addresses, or to `localhost`/`*.localhost`, are rejected with `400` unless `ALLOW_PRIVATE_TARGETS=true` (default: `true` outside production).
- Errors: `application/problem+json` (RFC 9457) — `{ type, title, status, detail, errors? }`.
- Pagination: `?limit=` (1–100, default 20) and `?cursor=` (opaque); responses include `next_cursor`.
- Every response carries `X-Request-Id` (taken from the request if present, otherwise generated).
- Tenant isolation: another application's resource returns `404`, never `403`.

| Method & path | Auth | Description | Success |
|---|---|---|---|
| `POST /v1/applications` | admin | Create application; returns the API key **once** | 201 |
| `POST /v1/endpoints` | app | Create `{ url, event_types?, active? }`; returns secret **once** | 201 |
| `GET /v1/endpoints` | app | List endpoints, newest first: `{ data, next_cursor }` | 200 |
| `GET /v1/endpoints/:id` | app | Get endpoint (secret omitted) | 200 |
| `PATCH /v1/endpoints/:id` | app | Update `url`, `event_types`, `active` | 200 |
| `DELETE /v1/endpoints/:id` | app | Deactivate (soft delete) | 204 |
| `POST /v1/messages` | app | Ingest `{ event_type, payload }`; `Idempotency-Key` header recommended | 202 |
| `GET /v1/messages` | app | List, newest first, without payloads; filter `event_type` | 200 |
| `GET /v1/messages/:id` | app | Message with payload + all its deliveries | 200 |
| `GET /v1/deliveries` | app | List, newest first; filter `status`, `endpoint_id`, `message_id` | 200 |
| `GET /v1/deliveries/:id` | app | One delivery | 200 |
| `GET /v1/deliveries/:id/attempts` | app | Attempt history, oldest first (paginated) | 200 |
| `POST /v1/deliveries/:id/replay` | app | Replay a `dead` delivery (`409 delivery-not-dead` otherwise); returns the delivery | 202 |
| `GET /healthz` | — | Process is alive | 200 |
| `GET /readyz` | — | Database reachable | 200 / 503 |
| `GET /metrics` | — (internal) | Prometheus metrics | 200 |

### `POST /v1/messages` — idempotency rules
| Case | Result |
|---|---|
| New key (or no key) | Insert message + deliveries in **one transaction** → `202 { id, deliveries: n }` |
| Same key, same body | Original response, `202`, header `Idempotent-Replayed: true`; no new deliveries |
| Same key, different body | `422`, problem type `idempotency-key-reused` |
| Two concurrent requests, same key | Exactly one insert wins (unique constraint); the other gets the replayed response |
| No subscribed endpoints | `202 { id, deliveries: 0 }` — the message is still stored |

Validation (zod): `event_type` pattern above; `payload` must be a JSON object; body > 256 KiB → `413`.

### Delivery representation
`{ id, message_id, endpoint_id, status, attempt_count, next_attempt_at, last_error, created_at, updated_at }`.
`next_attempt_at` is the retry time while `pending` and the lease expiry while `in_flight`. Lease
internals (`locked_by`, `locked_until`, `claim_count`) are not exposed.

## 7. Worker behavior

- Config via env: `DATABASE_URL`, `WORKER_ID` (default hostname-pid), `CONCURRENCY` (8),
  `POLL_INTERVAL` (500 ms), `BATCH_SIZE` (= CONCURRENCY), `LEASE_DURATION` (30 s), `REQUEST_TIMEOUT` (10 s),
  `MAX_ATTEMPTS` (8), `BACKOFF_BASE` (5 s), `BACKOFF_CAP` (1 h), `SHUTDOWN_GRACE` (25 s).
- Loop: wait for a free slot → claim up to `min(free slots, BATCH_SIZE)` due deliveries → run each in
  its own goroutine (at most `CONCURRENCY` at a time) → sleep `POLL_INTERVAL` when nothing was claimed.
  (LISTEN/NOTIFY for lower latency is a stretch goal.)
- `ALLOW_PRIVATE_TARGETS` (default `false`): when false, the worker refuses to connect to private,
  loopback, link-local, CGNAT or reserved IPs, checked on the resolved address right before connecting.
- Every HTTP request runs under a `context` with `REQUEST_TIMEOUT`; the response body read is capped.
- **Graceful shutdown** on SIGINT/SIGTERM: stop claiming, let in-flight deliveries finish within
  `SHUTDOWN_GRACE`, then exit. Unfinished work is recovered through lease expiry; an attempt aborted
  by shutdown is not recorded and does not count. The claim and result writes are not cancelled by
  the signal (each has its own short timeout), so a committed claim is never dropped on the floor.
- Every log line about a delivery includes `delivery_id`, `message_id`, `endpoint_id`, `attempt`,
  `request_id`, `worker_id`.

## 8. Observability

| Metric | Type | Source |
|---|---|---|
| `http_requests_total{method,route,status}` | counter | API |
| `http_request_duration_seconds{method,route}` | histogram | API |
| `messages_ingested_total` | counter | API |
| `delivery_attempts_total{result="success\|failure\|timeout"}` | counter | worker |
| `delivery_attempt_duration_seconds` | histogram | worker |
| `deliveries_dead_total` | counter | worker |
| `deliveries_due` | gauge (sampled) | worker |

Correlation: the API's `X-Request-Id` is stored in `messages.request_id` and logged by the worker on every attempt.

## 9. Testing strategy

| Level | Tooling | What |
|---|---|---|
| Unit | Vitest / `go test` | validation, signature, backoff math, request hashing |
| Integration (API) | Vitest + Supertest + Testcontainers (Postgres) | routes against a real database |
| Integration (worker) | `go test` + Testcontainers + `httptest.Server` | claim, retry, dead, fencing, lease expiry |
| End-to-end | Docker Compose | API + worker + DB + test receiver |
| Failure test (documented) | script | kill the worker mid-delivery → recovered after lease expiry, nothing lost |
| Concurrency | test | N workers × M deliveries → no delivery is claimed twice for the same attempt |
| Benchmark | script (k6 as stretch) | deliveries/s with 1, 4 and 8 workers |

## 10. Security checklist
- [ ] API keys: 32 random bytes, stored as SHA-256, compared in constant time
- [ ] Endpoint secrets never logged nor returned after creation
- [ ] Parameterized SQL only
- [x] Body size limit; JSON-only content type
- [ ] Tenant isolation on every query (`app_id = <authenticated app>`)
- [ ] SSRF: block private, loopback and link-local destinations in production (`ALLOW_PRIVATE_TARGETS=true` only in dev)
  - [x] API: endpoint URLs with literal private IPs or `localhost` are rejected on create/update
  - [x] Worker: check the resolved IP at connect time (a public hostname can resolve to a private address — DNS rebinding)
- [ ] Secrets only via environment variables; `.env` is git-ignored
