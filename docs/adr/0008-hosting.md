# 0008. Hosting platform

- Status: Proposed — decide before the first deploy
- Date: 2026-11-13

## Context
We need a public demo running three things: the API (HTTP), the worker (an **always-on background
process**, not request-driven), and PostgreSQL 18. Budget is small, and setup time should be low.
In 2027 the project will also be deployed to AWS with Terraform.

## Options
| Option | Pros | Cons |
|---|---|---|
| **Railway** | Deploys from the repo/Dockerfile, managed Postgres, background services, simplest UI | Paid after trial credits (check current pricing) |
| Fly.io | Docker-native, good CLI, regions | Requires a card; more concepts (machines, volumes) |
| Render | Simple, free web tier | Free web services sleep; background workers are paid; free Postgres is time-limited |
| VPS + Docker Compose | Cheapest, full control | You operate everything (TLS, backups, updates) |
| Serverless (Vercel, Netlify, Lambda) | — | No always-on worker; not a fit for this design |

## Decision
Pending. Leaning towards **Railway** for the MVP because it has the fewest new concepts. Every service
ships as a Dockerfile, so moving to another host or AWS later is cheap.

## Consequences
- Dockerfiles are the portability layer; nothing platform-specific in the code.
- Configuration only through environment variables (`DATABASE_URL`, `ADMIN_TOKEN`, …).
