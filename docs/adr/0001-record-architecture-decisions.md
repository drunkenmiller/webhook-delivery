# 0001. Record architecture decisions

- Status: Accepted
- Date: 2026-11-13

## Context
Decisions about queueing, delivery semantics and data access are the core of this project. They
need to be explainable later — to reviewers, to future contributors, and in interviews.

## Decision
We will record every significant decision as a short ADR in `docs/adr/`, using the template in
`0000-template.md`. ADRs are written in English and merged through pull requests like code.

## Consequences
- The "why" survives after the code changes.
- Writing an ADR forces alternatives to be considered explicitly.
- Small overhead per decision; trivial choices do not need an ADR.
