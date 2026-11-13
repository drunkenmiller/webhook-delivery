# 0005. Explicit SQL and dbmate migrations, no ORM

- Status: Proposed
- Date: 2026-11-13

## Context
The most important queries (claim, fenced completion, idempotent insert) depend on exact SQL:
`FOR UPDATE SKIP LOCKED`, `ON CONFLICT`, partial indexes. Two languages access the same schema.

## Decision
- Schema changes are plain SQL files in `db/migrations/`, applied with **dbmate** (language-agnostic,
  single binary, `-- migrate:up` / `-- migrate:down` sections).
- Node uses `pg` with parameterized queries; Go uses `pgx`. Queries live next to the code that uses them.

## Alternatives considered
- **Prisma / Drizzle / TypeORM** — hide or complicate the claim query; migrations tied to one language.
- **golang-migrate / node-pg-migrate** — fine, but tied to one ecosystem's tooling.

## Consequences
- Full control and visibility of every query; easy to `EXPLAIN ANALYZE`.
- No generated types: request/response types come from zod; row types are written by hand.
- Migrations must stay backward compatible because API and worker deploy independently
  (expand → migrate code → contract).
