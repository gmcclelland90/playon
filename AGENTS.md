# PlayOn — agent coding contract

PlayOn is a self-hosted AI control plane for game servers ([playon.games](https://playon.games)).

## Repo layout

- `apps/web` — React + Vite admin/player UI
- `apps/api` — Hono control plane (auth, agents, skills, panel, snapshots)
- `apps/node-agent` — executes scoped tools on a host
- `packages/shared` — Zod schemas and shared types
- `packages/agent-core` — orchestrator, tool registry, skill loading
- `packages/runtime` — Docker/native adapters
- `skills/` — platform (+ test fixtures) only. No curated `games.*` here — those live in sibling `playon-games`; hosts install from the playon.games catalog. Lab/unit tests use `fixtures.lab-docker-server`.
- `design-docs/` — product intent (update only when asked)
- Sibling `playon-games` — public site + host docs (`/docs/*`); keep onboarding in sync when Add-node / install UX changes

## Commands

```bash
pnpm install
pnpm clean # wipe dist / turbo / tsbuildinfo (needed after partial cleans)
pnpm check # typecheck across packages
pnpm test:unit
pnpm test:contract
pnpm verify # fast bar: check + unit + contract
pnpm loop:verify # merge bar on Linux lab: + int + agent (real Venice + Docker)
pnpm loop:verify:runtime # merge bar + Paper Docker smoke
pnpm smoke:paper-docker # real Docker Paper path only
pnpm test:e2e # Playwright UI smoke (opt-in; not part of loop:verify)
pnpm dev # api + web + local node-agent
```

Autonomous loop protocol: [docs/agent-dev-loop.md](docs/agent-dev-loop.md)  
Linux lab host notes: [docs/linux-dev-host.md](docs/linux-dev-host.md)  
Home release / playon.games CI/CD: [docs/release.md](docs/release.md)

## Autonomy rules

- **Production only:** Venice (`openai_compatible`) + `PLAYON_RUNTIME=docker` (or `native`). No mock LLM/runtime mode.
- Verify runner is the **Linux lab host** with Docker and `PLAYON_VENICE_API_KEY` (or key in Settings DB).
- Do not invent placeholder containers, sleep stubs, or scripted IntentMock paths.
- Each test uses an isolated temp `PLAYON_DATA_ROOT` where applicable.
- Keep secrets out of logs and player panel payloads.
- Path jail: agent FS tools may only touch the target server dir + read global skills
- After each implementation slice: run `pnpm loop:verify` on the lab; if red, fix that layer before new work
- Read `tmp/agent-loop-status.json` at the start of a turn when present

## Conventions

- TypeScript strict; ESM (`NodeNext`)
- Package name prefix: `@playon/*`
- Additive schema changes with version fields where applicable
