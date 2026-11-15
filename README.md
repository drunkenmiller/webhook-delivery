# webhook-delivery

> 🚧 **Work in progress** — MVP under active development. See the [roadmap](docs/ROADMAP.md).

A reliable webhook delivery service: a **Node.js/TypeScript** API ingests events, **Go** workers deliver
them with signed requests, retries with exponential backoff, idempotency and a dead-letter queue —
all coordinated through **PostgreSQL**.

```
Producer ──POST /v1/messages──▶ API (Node.js/Express)
                                  │ one transaction: message + deliveries
                                  ▼
                              PostgreSQL ◀── claim (FOR UPDATE SKIP LOCKED + lease) ── Go workers ──signed POST──▶ endpoints
                                  ▲
Dashboard (React) ──────▶ API ────┘
```

## Highlights (planned for the MVP)
- **PostgreSQL as the queue** — `SELECT … FOR UPDATE SKIP LOCKED` with leases, so crashed workers never lose work ([ADR 0002](docs/adr/0002-postgresql-as-the-queue.md))
- **At-least-once delivery** — `Idempotency-Key` on ingest, stable `webhook-id` for receiver dedup ([ADR 0003](docs/adr/0003-at-least-once-delivery.md))
- **Exponential backoff with full jitter**, dead-letter state and manual replay ([ADR 0006](docs/adr/0006-retries-backoff-jitter-dlq.md))
- **Signed webhooks** following [Standard Webhooks](https://www.standardwebhooks.com/) (HMAC-SHA256 + timestamp) ([ADR 0007](docs/adr/0007-signing-and-api-keys.md))
- **Graceful shutdown**, per-request timeouts, `/metrics` and correlation IDs from API to worker

## Documentation
- [Specification](docs/SPEC.md) — requirements, data model, delivery lifecycle, API
- [Architecture decisions](docs/adr/) — why each choice was made
- [Roadmap](docs/ROADMAP.md) · [Backlog](docs/BACKLOG.md)

## Repository layout
```
api/            Node.js + TypeScript + Express 5 (ingest & management API)
worker/         Go delivery worker
dashboard/      Vite + React + TanStack Query (planned)
db/migrations/  SQL migrations (dbmate), shared by API and worker
docs/           spec, ADRs, roadmap, backlog
```

## Running locally
Requirements: Docker Desktop (or another Docker engine).

```bash
cp .env.example .env
docker compose up -d        # starts PostgreSQL 18
docker compose ps           # wait until "healthy"
```

Migrations use [dbmate](https://github.com/amacneil/dbmate) (`brew install dbmate`). Shortcuts live in the
`Makefile` — run `make` to list them:

```bash
make db-up                      # start PostgreSQL and wait until healthy
make db-new name=init_schema    # create db/migrations/<timestamp>_init_schema.sql
make db-migrate                 # apply pending migrations
make db-rollback                # undo the last migration
make db-psql                    # psql shell inside the container
```

More steps (API, worker) will be added as each part lands.

## Status
| Area | Status |
|---|---|
| Spec & ADRs | ✅ draft |
| Local PostgreSQL (Compose) | ✅ |
| Schema v1 + migrations | ⏳ |
| `POST /v1/messages` with idempotency | ⏳ |
| CI (GitHub Actions) | ⏳ |
| Go worker (claim, lease, HMAC) | ⏳ |
| Retries, DLQ, replay, graceful shutdown | ⏳ |
| Dashboard | ⏳ |
| Deploy | ⏳ |
