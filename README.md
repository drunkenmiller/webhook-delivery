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
dashboard/      Vite + React + TanStack Query
db/migrations/  SQL migrations (dbmate), shared by API and worker
tools/receiver/ test receiver (signature verification, simulated failures)
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

Node.js code lives in **npm workspaces** (`api/`, `tools/receiver/`, `dashboard/`) that share one lockfile and
one TypeScript/ESLint/Prettier setup at the repository root. Install once, at the root:

```bash
npm install                     # installs every workspace
npm run check                   # lint + format + typecheck + tests, in every workspace
npm run dev --workspace api     # http://localhost:3000/healthz — reloads on file changes
npm run dev --workspace dashboard   # http://localhost:5173 — needs CORS_ORIGINS=http://localhost:5173 in .env
npm run test:integration        # tests against a real PostgreSQL 18 (needs Docker running)
```

Or run everything in containers (PostgreSQL + API + [test receiver](tools/receiver/README.md)):

```bash
make up                         # docker compose --profile app up -d --build --wait
curl localhost:3000/readyz      # API, connected to the database
curl localhost:4000/stats       # test receiver
make down
```

### Try the API

```bash
make db-up && make db-migrate && npm run dev --workspace api      # in another terminal:

# 1. Create an application (admin) — the API key is shown only once
curl -s localhost:3000/v1/applications -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"Acme"}'

# 2. Register an endpoint with that key — the signing secret is shown only once
curl -s localhost:3000/v1/endpoints -H "Authorization: Bearer whd_..." \
  -H 'Content-Type: application/json' \
  -d '{"url":"http://localhost:4000/hook","event_types":["invoice.paid"]}'

# 3. List, update, deactivate
curl -s 'localhost:3000/v1/endpoints?limit=10' -H "Authorization: Bearer whd_..."
curl -s -X PATCH localhost:3000/v1/endpoints/<id> -H "Authorization: Bearer whd_..." \
  -H 'Content-Type: application/json' -d '{"active":false}'
```

Or open the dashboard (`npm run dev --workspace dashboard`, http://localhost:5173), paste the API
key and manage endpoints there.

Send an event (fanned out to every active endpoint subscribed to `invoice.paid`); repeating the
same request with the same `Idempotency-Key` returns the same id with `Idempotent-Replayed: true`:

```bash
curl -si localhost:3000/v1/messages -H "Authorization: Bearer whd_..." \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: order-42-paid' \
  -d '{"event_type":"invoice.paid","payload":{"invoice_id":"inv_42","amount":4200}}'
```

Run the worker (needs Go; reads `.env`), which claims the deliveries and sends them signed:

```bash
make worker        # or: make up  → API, worker and the demo receiver in containers
make worker-test   # unit + integration tests (Docker)
```

Follow what happened, and replay a delivery that exhausted its retries (`dead`):

```bash
curl -s localhost:3000/v1/messages/<message_id> -H "Authorization: Bearer whd_..."      # + its deliveries
curl -s 'localhost:3000/v1/deliveries?status=dead' -H "Authorization: Bearer whd_..."
curl -s localhost:3000/v1/deliveries/<id>/attempts -H "Authorization: Bearer whd_..."
curl -s -X POST localhost:3000/v1/deliveries/<id>/replay -H "Authorization: Bearer whd_..."
```

## Status
| Area | Status |
|---|---|
| Spec & ADRs | ✅ draft |
| Local PostgreSQL (Compose) | ✅ |
| Schema v1 + migrations | ✅ |
| Applications, API key auth, endpoints CRUD | ✅ |
| `POST /v1/messages` with idempotency | ✅ |
| API scaffolding (health checks, problem+json errors, request IDs) | ✅ |
| CI (GitHub Actions) | ✅ Node workspaces + Go worker |
| Go worker (claim, lease, HMAC) | ✅ |
| Retries, DLQ, replay, graceful shutdown | ✅ |
| Read API (messages, deliveries, attempts) | ✅ |
| Dashboard | 🟡 endpoints page |
| Deploy | ⏳ |
