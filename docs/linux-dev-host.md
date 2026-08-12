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

### Node hosts (separate)

- **Linux (legacy):** `172.16.0.155` (hostname `playon-node-1`) — SSH aliases `playon-old`, `playon-node-1`
- **Windows 11 Pro lab worker:** `172.16.0.94` (hostname `PLAYON-DEV-NODE`, node id `playon-win-1`)
  - User: `playon-dev-node` (OpenSSH + WinRM)
  - Install root: `C:\playon-node` (data `C:\playon-node\data`)
  - Joins Home at `http://172.16.0.156:8787` with the same `PLAYON_NODE_TOKEN`
  - Set `nodes.join_host=172.16.0.94` so query/join target the Windows box (not Home’s advertiseHost)
  - Host deps for UE/Steam PE titles: VC++ 2010–2022 x64 redistributables + DirectX End-User Runtime (`d3dx9_43` / `XAudio2_7`)
  - Matrix: `pnpm lab:matrix --filter windows` (or `--skill games.*`) dual-places Windows-only skills here via live Home API/MCP

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
- SteamCMD (`~/steamcmd`, see `infra/control-plane/linux/install-steamcmd.sh`)
- X11 client libs for Unreal-based native dedications on headless hosts (ARK Evolved, etc.):

```bash
sudo apt-get install -y libx11-6 libxcursor1 libxinerama1 libxi6 libxrandr2 libxss1 libxxf86vm1 libxrender1
```

- Eco (`games.eco`) needs `libgdiplus` for `System.Drawing` on Linux:

```bash
sudo apt-get install -y libgdiplus
```

- Source/TF2 (`games.tf2` and similar) need i386 GnuTLS curl for `replay_srv.so`:

```bash
sudo apt-get install -y libcurl3t64-gnutls:i386
```

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
pnpm lab:matrix               # catalog E2E (see lab-matrix.md)
pnpm lab:join-path-canary     # published joinHost vs loopback (see lab-matrix.md)
pnpm lab:file-issues          # push lab failures into GitHub Issues (source:lab)
```

Standing daily cadence (verify → matrix → Issues): [infra/lab/README.md](../infra/lab/README.md).

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
