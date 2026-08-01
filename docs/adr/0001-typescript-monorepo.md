# ADR 0001 — TypeScript monorepo

## Status

Accepted

## Context

PlayOn needs a web panel, control plane, node agent, LLM orchestration, and scoped runtime tools. Autonomous coding agents should iterate quickly with one language.

## Decision

Use a pnpm + Turborepo TypeScript monorepo:

- React/Vite web UI
- Hono API on Node.js
- SQLite + Drizzle
- Shared Zod schemas
- Injectable mock LLM and mock Docker/process adapters for CI

## Consequences

- Fast agent loops without real games or cloud keys
- Clear path to swap in real Docker/Ollama adapters later
- Windows + Linux validated via CI matrix over time
