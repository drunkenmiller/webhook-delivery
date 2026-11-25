# 0002. PostgreSQL as the queue (SKIP LOCKED + lease)

- Status: Proposed
- Date: 2026-11-13

## Context
Every ingested message creates deliveries that workers must pick up, attempt, and reschedule.
We need: no lost work when a worker crashes, no two workers processing the same delivery at the
same time, delayed retries (`next_attempt_at`), and a queryable history for the dashboard.
The message and its deliveries must be created atomically with the API request.

## Decision
We will use the `deliveries` table in PostgreSQL as the queue.

- Workers claim due rows with `SELECT … FOR UPDATE SKIP LOCKED LIMIT n` inside a short transaction
  and mark them `in_flight` with `locked_by` and `locked_until` (a **lease**).
- The HTTP call happens after that transaction commits, so no row lock or connection is held
  during network I/O.
- If a worker dies, its lease expires and the delivery becomes claimable again.
- Completion updates are fenced by `locked_by` so a worker whose lease expired cannot overwrite
  the result of the worker that took over.

## Alternatives considered
- **Redis (lists/streams), RabbitMQ, SQS, Kafka** — a second system to run and keep consistent.
  Writing the message to Postgres and publishing to a broker is a dual write (needs an outbox).
  Delayed retries and "show me all dead deliveries for endpoint X" are awkward on most brokers.
- **Holding the row lock during the HTTP call** — simpler, but ties up a connection and a
  transaction for up to the request timeout; limits concurrency to the pool size.
- **Advisory locks** — no persistence of who owns what; harder to inspect.

## Consequences
- One datastore, transactional ingest, and SQL-queryable state for the dashboard.
- Throughput is bounded by Postgres write capacity (every attempt updates a row). Fine for the
  target scale (hundreds of deliveries/s); beyond that, partition by `endpoint_id` or move
  dispatch to a log-based broker while keeping Postgres as the source of truth.
- Polling adds up to `POLL_INTERVAL` of latency; LISTEN/NOTIFY can reduce it later.
- Table bloat from frequent updates: watch autovacuum; archive old rows.
- Validated: `EXPLAIN ANALYZE` of the claim query uses the partial index — plan and fencing details in ADR 0009.
