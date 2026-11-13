# Architecture Decision Records

Short documents that capture one decision each: the context, the choice, and its consequences.
Format: [Michael Nygard's template](0000-template.md). Numbers are never reused; a changed decision
gets a new ADR that supersedes the old one.

| # | Title | Status |
|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-postgresql-as-the-queue.md) | PostgreSQL as the queue (SKIP LOCKED + lease) | Proposed |
| [0003](0003-at-least-once-delivery.md) | At-least-once delivery with idempotency on both sides | Proposed |
| [0004](0004-node-api-go-worker.md) | Node.js/Express for the API, Go for the worker | Proposed |
| [0005](0005-explicit-sql-and-dbmate.md) | Explicit SQL and dbmate migrations, no ORM | Proposed |
| [0006](0006-retries-backoff-jitter-dlq.md) | Retries with exponential backoff, full jitter and a DLQ | Proposed |
| [0007](0007-signing-and-api-keys.md) | Standard Webhooks signing and hashed API keys | Proposed |
| [0008](0008-hosting.md) | Hosting platform | Proposed |
