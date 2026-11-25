# Backlog

Each item becomes a GitHub issue. **Owner** = who writes the code (`core` = repository owner,
`support` = may be scaffolded with AI assistance and reviewed by the owner).

## M1 — Skeleton
- [x] Spec, ADRs, roadmap, README — support
- [x] `docker-compose.yml` with PostgreSQL 18 + healthcheck — support
- [x] **Schema v1 migration** (`applications`, `endpoints`, `messages`, `deliveries`, `attempts`, constraints, claim index — ADR 0009) — core (reference implementation, 2026-11-25)
- [x] API scaffolding: TypeScript config, Express 5 app, pino, config from env, `/healthz`, `/readyz`, error handler (problem+json), request ID — support
- [x] API key auth middleware (prefix lookup + SHA-256 + constant-time compare) — core (reference implementation, reviewed by owner)
- [x] `POST /v1/applications` (admin) — core (reference implementation, reviewed by owner)
- [x] `POST/GET/PATCH/DELETE /v1/endpoints` — core (reference implementation, reviewed by owner)
- [x] **`POST /v1/messages` with idempotency + fan-out in one transaction** — core (reference implementation, 2026-11-25)
- [ ] Integration test setup: Vitest + Supertest + Testcontainers — support (skeleton ✅) / core (cases)
- [x] CI: lint, typecheck, tests for `api/` — support
- [ ] Dockerfile for the API (done); deploy skeleton (after ADR 0008 is decided) — support

## M2 — Worker
- [ ] Go module scaffolding, config from env, pgx pool, structured logs (slog) — support
- [ ] **Claim query with SKIP LOCKED + lease** — core
- [ ] **HTTP delivery with timeout + Standard Webhooks signature** — core
- [ ] Attempt recording + fenced completion — core
- [x] Test receiver (`tools/receiver`) that verifies signatures and can simulate failures/slowness — support
- [ ] CI job for `worker/` (vet, test) — support

## M3 — Reliability
- [ ] **Backoff with full jitter (injectable clock/random)** — core
- [ ] Dead state + `POST /v1/deliveries/:id/replay` — core
- [ ] **Graceful shutdown via context** — core
- [ ] Read endpoints with cursor pagination (messages, deliveries, attempts) — core
- [ ] Integration tests: lease expiry, fencing, concurrent workers, idempotency races — core

## M4 — Product
- [x] Dashboard scaffolding (Vite + React + TanStack Query) — support (+ endpoints page, CORS)
- [ ] Pages: endpoints, messages, delivery detail with attempts, replay button — core/support
- [ ] Full deploy (API + worker + DB + dashboard) — support

## M5 — Proof
- [ ] Failure test script + write-up (kill worker mid-delivery) — core
- [ ] `/metrics` in API and worker; correlation ID propagated to worker logs — core
- [ ] README: architecture diagram, decisions, trade-offs, demo GIF — core (support reviews)

## M6 — Polish
- [ ] Benchmark: deliveries/s with 1, 4, 8 workers; results in README — core
- [ ] Bug fixes, docs, presentation rehearsal
