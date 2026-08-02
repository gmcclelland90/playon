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
pnpm loop:verify              # merge bar (real Venice + Docker)
pnpm loop:verify:runtime      # + real Paper Docker smoke
```

Loop protocol: [agent-dev-loop.md](agent-dev-loop.md)

## Production-like start (recommended for LAN UI)

```bash
cd /home/playon/src/playon
pnpm build
export PLAYON_ENV=production
export PLAYON_HOST=0.0.0.0
export PLAYON_ADVERTISE_HOST=172.16.0.155
export PLAYON_SESSION_SECRET=lab-change-me
export PLAYON_RUNTIME=docker
export PLAYON_LLM_MODE=openai_compatible
export PLAYON_VENICE_API_KEY= # or rely on Settings DB
pnpm start
```

Open `http://172.16.0.155:8787`. For systemd, see [lan-install.md](lan-install.md) and `infra/control-plane/`.

## Developer hot reload (optional)

```bash
cd /home/playon/src/playon
export PLAYON_HOST=0.0.0.0
export PLAYON_RUNTIME=docker
export PLAYON_LLM_MODE=openai_compatible
export PLAYON_WEB_HOST=0.0.0.0
pnpm --filter @playon/api dev &
pnpm --filter @playon/web dev &
```

Then open `http://172.16.0.155:5173` from a machine on the LAN.
