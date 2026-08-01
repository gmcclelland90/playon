# Linux development host

Canonical automated build/test host for PlayOn (Docker + Node).

## Current lab host

- Address: `172.16.0.155`
- User: `playon`
- Workspace: `/home/playon/src/playon`

## Toolchain

- Node.js 22 via NodeSource
- pnpm 9.15.4 via Corepack
- Docker Engine (user in `docker` group)

## Sync from a Windows workstation

```bash
# on the workstation: sync (preserve apps/api/data), then on the host:
pnpm install
pnpm loop:verify              # merge bar (mock LLM/runtime)
pnpm loop:verify:runtime      # + real Paper Docker smoke
```

Loop protocol: [agent-dev-loop.md](agent-dev-loop.md)

## Run for LAN UI testing

```bash
cd /home/playon/src/playon
export PLAYON_HOST=0.0.0.0
export PLAYON_RUNTIME=docker
export PLAYON_LLM_MODE=mock
export PLAYON_WEB_HOST=0.0.0.0
pnpm --filter @playon/api dev &
pnpm --filter @playon/web dev &
```

Then open `http://172.16.0.155:5173` from a machine on the LAN.
