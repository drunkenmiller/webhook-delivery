# Roadmap

MVP target: **2026-12-31**. Roughly 5–6 hours of project work per week.

| Milestone | Dates | Deliverables |
|---|---|---|
| **M1 — Skeleton** | Nov 13 – Nov 22 | Repo, spec & ADRs, Compose with PostgreSQL, schema v1 + migrations, `POST /v1/messages` with idempotency, CI, skeleton deployed, initial README |
| **M2 — Worker** | Nov 16 – Nov 22 | Go worker: claim with SKIP LOCKED + lease, HTTP delivery with timeout, attempt recording, HMAC signing |
| **M3 — Reliability** | Nov 23 – Nov 30 | Backoff + jitter, dead state, replay, graceful shutdown, integration tests (API + worker + DB) |
| **M4 — Product** | Dec 1 – Dec 7 | React dashboard (endpoints, messages, attempts); full deploy |
| **M5 — Proof** | Dec 8 – Dec 14 | Documented failure test (kill the worker mid-delivery), `/metrics`, README with diagram and ADRs, demo GIF |
| **M6 — Polish** | Dec 15 – Dec 31 | Benchmark (deliveries/s with N workers), fixes, presentation rehearsal. **No new features.** |

## Stretch (only after the MVP)
- Per-endpoint rate limiting (Redis) and circuit breaker
- Prometheus/OpenTelemetry dashboards; k6 load test with numbers in the README
- Node (worker_threads) vs Go benchmark of the delivery loop
- LISTEN/NOTIFY to reduce pickup latency

## 2027
- Deploy to AWS with Terraform
- Payload transformations as sandboxed WebAssembly modules (wazero) in the worker
