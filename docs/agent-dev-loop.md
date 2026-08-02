# Autonomous develop / test loop

PlayOn is built by an agent that **implements → verifies → fixes → next todo** against **real** Venice + Docker on the Linux lab host.

## What exists

| Piece | Command | Role |
| ----- | ------- | ---- |
| Fast bar | `pnpm verify` | check + unit + contract |
| Merge bar | `pnpm loop:verify` | check → unit → contract → int → agent (Venice + Docker) |
| Runtime bar | `pnpm loop:verify:runtime` | merge bar + Paper Docker smoke |
| Status artifact | `tmp/agent-loop-status.json` | last run result + failed layer tail |

**Required on the lab host:** Docker engine, `PLAYON_VENICE_API_KEY` (or `VENICE_API_KEY`), network access to `api.venice.ai`.

Defaults: `PLAYON_LLM_MODE=openai_compatible`, `PLAYON_RUNTIME=docker`.

## Agent turn protocol

1. Read `tmp/agent-loop-status.json` if present. If `ok=false`, fix that layer first.
2. Pick the next incomplete plan todo.
3. Implement the smallest slice that moves the todo.
4. Sync to the Linux lab and run `pnpm loop:verify` (add `:runtime` when touching Docker lifecycle).
5. If red: fix from the failed layer tail; do not start a new feature.
6. If green: mark the plan/session todo, pick the next one.
7. Human gates: Venice spend, UI brand, irreversible host cleanup.

## Linux lab host

Canonical verify host: [linux-dev-host.md](linux-dev-host.md). Windows is edit/sync only for this track.
