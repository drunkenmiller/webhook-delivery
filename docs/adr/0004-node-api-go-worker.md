# 0004. Node.js/Express for the API, Go for the worker

- Status: Proposed
- Date: 2026-11-13

## Context
The API is I/O-bound request handling: auth, validation, a few queries. The worker runs many
concurrent outbound HTTP requests with timeouts, cancellation and graceful shutdown.

## Decision
- **API:** Node.js 24 + TypeScript + Express 5, zod for validation, pino for logs.
- **Worker:** Go, using goroutines for concurrency, `context` for timeouts/cancellation, `net/http`
  client and `pgx`.
- The two services share only the database schema (ADR 0005) — no RPC between them.

## Alternatives considered
- **All Node** — workable (the event loop handles many concurrent requests), but Go's
  context/goroutine model makes timeouts, bounded concurrency and graceful shutdown explicit and
  cheap, and produces a single static binary.
- **All Go** — simpler ops, but Node/TypeScript is the main API stack we want to demonstrate.
- **Fastify / NestJS** — Express is the most widely used; NestJS adds structure we do not need at this size.

## Consequences
- Two languages, two toolchains, two CI jobs.
- The schema is the contract: migrations must be backward compatible with the running worker.
- Clear seam for scaling: API and worker scale independently.
- Stretch: benchmark the same delivery loop in Node (worker_threads / plain async) vs Go.
