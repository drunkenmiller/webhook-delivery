# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project
Reliable webhook delivery service (MVP target: 2026-12-31). Read `docs/SPEC.md` (what), `docs/adr/` (why),
`docs/ROADMAP.md` (when) and `docs/BACKLOG.md` (next tasks) before making changes.

- `api/` — Node.js 24 + TypeScript + Express 5 + zod + pino + `pg`
- `worker/` — Go + `pgx` + `net/http`
- `db/migrations/` — plain SQL, dbmate
- `dashboard/` — Vite + React + TanStack Query (December)
- Local infra: `docker compose up -d`

## Collaboration rules (important)
- **The owner writes the core**: claim/lease query, fenced completion, retry/backoff logic, idempotent
  ingest, the Go worker loop, the schema migrations. Claude must **not** write these unprompted — guide,
  review, explain, and propose a reference only when explicitly asked.
- **Claude may write support code**: Docker/Compose, CI, configs, lint, scaffolding, test skeletons,
  scripts, dashboard UI scaffolding. Always on a branch, via PR, explained line by line.
- Every line merged must be explainable by the owner — explain non-obvious code, using C/C++ analogies when useful.
- Review the owner's PRs like a senior engineer: correctness, concurrency, SQL, tests, naming.
- The owner is new to Docker, Railway and GitHub Actions: explain those briefly when touching them.
- Conversation with the owner is in Portuguese; **everything in the repo is in English** (code, comments,
  commits, PRs, ADRs, README).

## Workflow
- issue → branch (`feat/…`, `fix/…`, `docs/…`, `chore/…`) → PR with description/checklist → green CI → merge.
- Conventional Commits (`feat(api): …`, `fix(worker): …`).
- Significant decisions become ADRs (`docs/adr/NNNN-title.md`, template `0000`). Keep `docs/SPEC.md` in sync with code.
- Never commit secrets; config only via environment variables (`.env` is git-ignored, see `.env.example`).
