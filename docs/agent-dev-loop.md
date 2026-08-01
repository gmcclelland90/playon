# Autonomous develop / test loop

PlayOn is meant to be built by an agent that **implements → verifies → fixes → next todo** without waiting for a human except at explicit gates (UI look, API keys, destructive ops).

## What exists

| Piece | Command | Role |
| ----- | ------- | ---- |
| Fast bar | `pnpm verify` | check + unit + contract (quick local feedback) |
| Merge bar | `pnpm loop:verify` | check → unit → contract → int → agent-replay |
| Runtime bar | `pnpm loop:verify:runtime` | merge bar + real Paper Docker smoke |
| Status artifact | `tmp/agent-loop-status.json` | last run result + failed layer tail |

Mocks are default: `PLAYON_LLM_MODE=mock`, `PLAYON_RUNTIME=mock`.

## Agent turn protocol

1. Read `tmp/agent-loop-status.json` if present. If `ok=false`, fix that layer first.
2. Pick the next incomplete Phase 1 todo from the plan (prefer in-progress, then pending in plan order).
3. Implement the smallest slice that moves the todo.
4. Run `pnpm loop:verify` (or `loop:verify:runtime` when touching Docker lifecycle).
5. If red: fix from the failed layer tail; do not start a new feature.
6. If green: mark the plan/session todo, pick the next one.
7. Stop and ask a human only for: UI/brand validation, secrets/API keys, irreversible host cleanup, or blocked external deps.

## Linux lab host

Canonical Docker host: see [linux-dev-host.md](linux-dev-host.md).

When the Windows workstation cannot run Docker:

1. Sync repo to `/home/playon/src/playon` (**preserve `apps/api/data`**).
2. On the host: `pnpm install && pnpm loop:verify` (add `:runtime` for Paper).
3. Bring the status JSON / failure tail back into the agent turn.

## Cursor session loop (dynamic)

Default is **dynamic**, not a fixed timer. After each slice the agent wakes itself when the next slice is worth doing (usually immediately / within ~1–2 minutes). No idle 15-minute gaps while MVP work remains.

Cadence goals:

1. **Function** — clear Phase 1 plan todos until MVP exit criteria are met  
2. **Prove** — `pnpm loop:verify` green every slice; `:runtime` / host sync when Docker is touched  
3. **Polish** — once function is solid, run Impeccable audit/polish on admin + player UI until the score is excellent  

Prompt shape:

> Dynamic MVP loop: read `tmp/agent-loop-status.json` → fix red or take next incomplete plan todo → implement one slice → `pnpm loop:verify` → update plan/session todos → re-arm wake. Human gates only: UI brand approval, API keys, destructive ops. After functional MVP, polish with Impeccable.

Say **stop the loop** to cancel the next wake.

## Human gates (do not automate past these)

- Venice / cloud API key entry and spend approval
- Visual approval of admin/player UI
- Force-push, wiping `apps/api/data`, or deleting running player worlds
