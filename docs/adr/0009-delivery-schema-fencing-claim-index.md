# 0009. Delivery schema: fencing token, claim index and app_id on deliveries

- Status: Accepted
- Date: 2026-11-25

## Context
ADR 0002 makes the `deliveries` table the queue and leaves three details open:

1. **Fencing.** SPEC §4 fences completion with `locked_by = $me`. That fails when the same worker
   loses a lease and re-claims the same delivery (or two processes share a `WORKER_ID`, e.g. a
   restarted container with the same hostname): both copies pass the `locked_by` check.
   `attempt_count` can't be the token either, because replay resets it to 0 — values repeat (ABA).
2. **The claim index.** Claimable = `pending` and due, **or** `in_flight` with an expired lease.
   That `OR` over two columns can't be served by one ordered index scan, and the queue table keeps
   every finished delivery forever, so a full scan grows with history, not with pending work.
3. **Tenant filter for deliveries.** `GET /v1/deliveries` lists "this application's deliveries".
   A delivery reaches its application only through its message.

## Decision
1. **`claim_count`** — every claim does `claim_count = claim_count + 1` and returns the new value
   to the worker. Completion is fenced with
   `WHERE id = $1 AND status = 'in_flight' AND locked_by = $me AND claim_count = $token`.
   It only grows (replay doesn't touch it), so a stale worker can never match again.
2. **One due-time column and one partial index.** `next_attempt_at` means "when this delivery is due
   next" in every claimable status: for `pending` the retry time, for `in_flight` the lease expiry
   (the claim sets `next_attempt_at = locked_until = now() + lease`). The claim becomes
   `WHERE status IN ('pending','in_flight') AND next_attempt_at <= now() ORDER BY next_attempt_at`,
   served by
   `CREATE INDEX deliveries_due_idx ON deliveries (next_attempt_at) WHERE status IN ('pending','in_flight')`.
   Finished rows (`succeeded`, `dead`) are not in the index at all.
3. **`app_id` is denormalized onto `deliveries`**, with composite foreign keys
   `(app_id, message_id) → messages (app_id, id)` and `(app_id, endpoint_id) → endpoints (app_id, id)`,
   so a delivery can never mix applications, and read APIs filter with an `(app_id, id)` index.

## Proof (EXPLAIN ANALYZE)
200 000 deliveries: 95 % succeeded, 2 % dead, 1 % in flight with an expired lease, 2 % pending
(half due, half an hour in the future). PostgreSQL 18, claim of a batch of 8:

```
Update on deliveries d (actual rows=8.00 loops=1)
  CTE due
    ->  Limit (actual rows=8.00 loops=1)
          ->  LockRows (actual rows=8.00 loops=1)
                ->  Index Scan using deliveries_due_idx on deliveries (actual rows=8.00 loops=1)
                      Index Cond: (next_attempt_at <= now())
                      Buffers: shared hit=8
  ->  Nested Loop (actual rows=8.00 loops=1)
        ->  CTE Scan on due (actual rows=8.00 loops=1)
        ->  Index Scan using deliveries_pkey on deliveries d (actual rows=1.00 loops=8)
```

8 index pages read for 8 rows, out of 200 000; the 194 000 finished rows are never touched. (The
plan also showed FK triggers firing on the update; that is because the seed rows were inserted in
the same transaction — PostgreSQL skips the check for unchanged keys of older rows.)

## Alternatives considered
- **Fence with `locked_by` only** (the original SPEC) — fails on a re-claim by the same worker id.
- **A random lease token (uuid) per claim** — works too; a counter is smaller, ordered, and also
  tells how many times a delivery was picked up (useful when debugging lease expiry).
- **Two partial indexes** (`next_attempt_at` for pending, `locked_until` for in flight) — the `OR`
  becomes a BitmapOr that must collect every match before ordering; no early stop at `LIMIT`.
- **Join messages for the tenant filter** — every delivery list joins a table that grows as fast;
  no single index serves "app X's deliveries, newest first".

## Consequences
- `next_attempt_at` changes meaning with `status`; documented in the migration and SPEC §3.
  `locked_until` is kept for readability and must be set together with it.
- One more `int` per delivery and one more `uuid`; negligible.
- The claim index stays as small as the pending work. Watch autovacuum: every claim and completion
  moves rows in and out of it.
