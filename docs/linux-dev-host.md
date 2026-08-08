# Linux development host

Canonical automated build/test host for PlayOn (Docker + Node).

## Current lab / Home host

- Address: `172.16.0.156` (hostname `playon-dev`)
- User: `playon`
- Workspace (git for `loop:verify`): `/home/playon/src/playon-git`
- Deploy/runtime tree (systemd): `/home/playon/src/playon` — keep durable `apps/api/data` here; do not treat it as the merge-bar checkout
- Sync: **git** (`git pull --ff-only` from `origin` in `playon-git`)
- Remote: `git@github.com:gmcclelland90/playon.git` (read-only deploy key `~/.ssh/playon_deploy`)
- Env: `/etc/playon/playon.env` (systemd `EnvironmentFile` + lab verify)

### Node host (separate)

- Address: `172.16.0.155` (hostname `playon-node-1`)
- SSH aliases: `playon-old`, `playon-node-1`
- Env: `/etc/playon/node.env` → Home at `http://172.16.0.156:8787`

### SSH from the Windows workstation

```bash
ssh playon-lab
```

Host alias in `~/.ssh/config` → `playon@172.16.0.156`, identity `~/.ssh/playon_dev`. Non-interactive:

```bash
ssh -o BatchMode=yes playon-lab 'hostname && cd /home/playon/src/playon-git && git rev-parse --short HEAD'
```

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
cd /home/playon/src/playon-git
git pull --ff-only
pnpm install
set -a && . /etc/playon/playon.env && set +a   # Venice key + runtime (systemd EnvironmentFile)
pnpm loop:verify              # merge bar (real Venice + Docker)
pnpm loop:verify:runtime      # + real Paper Docker smoke
```

Preserve durable state across checkouts: Home data lives under `/home/playon/src/playon/apps/api/data` (outside the verify clone). After a fresh Home deploy, restore those paths before `pnpm start` / systemd.

**Disaster fallback only:** rsync/scp a tree when git auth is broken — then re-establish a tracking checkout. Do not treat rsync as the day-to-day sync path.

Loop protocol: [agent-dev-loop.md](agent-dev-loop.md)

## Production-like start (recommended for LAN UI)

Prefer systemd (`playon` + node agent on the node host) — see [lan-install.md](lan-install.md) and `infra/control-plane/`.

```bash
cd /home/playon/src/playon
pnpm build
# /etc/playon/playon.env already sets HOST/ADVERTISE/RUNTIME/VENICE/etc.
sudo systemctl restart playon
```

Open `http://172.16.0.156:8787`. Without a connected node-agent, remote placement stays offline; Local can still run when the CP has Docker.

## Developer hot reload (optional)

```bash
cd /home/playon/src/playon-git
export PLAYON_HOST=0.0.0.0
export PLAYON_RUNTIME=docker
set -a && . /etc/playon/playon.env && set +a
pnpm dev
```
