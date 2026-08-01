# PlayOn — agent coding contract

PlayOn is a self-hosted AI control plane for game servers ([playon.games](https://playon.games)).

## Repo layout

- `apps/web` — React + Vite admin/player UI
- `apps/api` — Hono control plane (auth, agents, skills, panel, snapshots)
- `apps/node-agent` — executes scoped tools on a host
- `packages/shared` — Zod schemas and shared types
- `packages/agent-core` — orchestrator, tool registry, skill loading
- `packages/runtime` — Docker/native adapters and mocks
- `skills/` — global + fixture skills
- `design-docs/` — product intent (update only when asked)

## Commands

```bash
pnpm install
pnpm clean                 # wipe dist / turbo / tsbuildinfo (needed after partial cleans)
pnpm check                 # typecheck across packages
pnpm test:unit
pnpm test:contract
pnpm verify                # fast bar: check + unit + contract
pnpm loop:verify           # merge bar: + int + agent-replay → tmp/agent-loop-status.json
pnpm loop:verify:runtime   # merge bar + Paper Docker smoke (Linux/Docker host)
pnpm smoke:paper-docker    # real Docker Paper path only
pnpm test:e2e              # Playwright UI smoke (opt-in; not part of loop:verify)
pnpm dev                   # api + web + local node-agent
```

Autonomous loop protocol: [docs/agent-dev-loop.md](docs/agent-dev-loop.md)  
Linux lab host notes: [docs/linux-dev-host.md](docs/linux-dev-host.md)

## Autonomy rules

- Default LLM/runtime for tests: **mock** (`PLAYON_LLM_MODE=mock`, `PLAYON_RUNTIME=mock`)
- Do not require SteamCMD, real game downloads, cloud API keys, or GPU for `pnpm loop:verify`
- Each test uses an isolated temp `PLAYON_DATA_ROOT`
- Prefer scripted API/integration tests over brittle UI for runtime behaviour
- Keep secrets out of logs and player panel payloads
- Path jail: agent FS tools may only touch the target server dir + read global skills
- After each implementation slice: run `pnpm loop:verify`; if red, fix that layer before new work
- Read `tmp/agent-loop-status.json` at the start of a turn when present
- Prefer a **dynamic** develop loop (wake when the next slice is ready), not long idle timers; after functional MVP, polish admin/player UI with Impeccable until the score is excellent

## Conventions

- TypeScript strict; ESM (`NodeNext`)
- Package name prefix: `@playon/*`
- Additive schema changes with version fields where applicable
