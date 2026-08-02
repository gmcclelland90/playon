# Linux development host

Canonical automated build/test host for PlayOn (Docker + Node).

## Current lab host

- Address: `172.16.0.155`
- User: `playon`
- Workspace: `/home/playon/src/playon`
- Sync: **git** (`git pull --ff-only` from `origin`)

## Toolchain

- Git
- Node.js 22 via NodeSource
- pnpm 9.15.4 via Corepack
- Docker Engine (user in `docker` group)

## Sync from a Windows workstation

Canonical path (CI/CD-aligned):

```bash
# on the workstation
git push origin HEAD

# on the lab host
cd /home/playon/src/playon
git pull --ff-only
pnpm install
pnpm loop:verify              # merge bar (real Venice + Docker)
pnpm loop:verify:runtime      # + real Paper Docker smoke
```

Preserve durable state across checkouts: `apps/api/data` and host `.env` live outside git (or are gitignored). After a fresh clone, restore those paths before `pnpm start`.

**Disaster fallback only:** rsync/scp a tree when git auth is broken — then re-establish a tracking checkout. Do not treat rsync as the day-to-day sync path.

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
