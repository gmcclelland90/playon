# Deploy PlayOn

**Guiding principle:** flexible where games run, easy however the LAN host wants to install. Docker is a *node capability*, not a PlayOn prerequisite.

## Mental model

| Piece | Role |
|-------|------|
| **Home (control plane)** | Admin UI, agents, placement, SQLite — never needs the Docker socket |
| **Node** | Runs games (native / SteamCMD / optional Docker) — Local, LAN, or cloud BYO |
| **playon.games** | Get PlayOn, skill catalog, host docs |

Placement per server: **Local** (optional on Home) · **Remote** (LAN node via Add node) · **Cloud** (any VPS via Add node + WireGuard + Home LAN gateway). Vendor Connect is deferred.

## Primary: one-line install (recommended)

Scripts are hosted on [playon.games](https://playon.games/get) (source: [`deploy/bootstrap/`](../deploy/bootstrap/)). They pull the latest Home release asset and start PlayOn.

**In-app updates:** Home polls `https://playon.games/home/latest.json` (override with `PLAYON_UPDATE_MANIFEST_URL`). Owners get a banner + **Settings → About / Updates** to download, verify (sha256), and restart. After Home is current, remote nodes that report an older `agentVersion` show **Update** on Settings → Nodes (per-node job). Re-running the one-liner still works and keeps `data/` / `env/`.

```powershell
# Windows
irm https://playon.games/install.ps1 | iex
```

```bash
# Linux
curl -fsSL https://playon.games/install | bash
```

| | Windows | Linux |
|--|---------|--------|
| Default dir | `%LOCALAPPDATA%\PlayOn` | `~/playon` |
| Optional | `PLAYON_HOME`, `PLAYON_VERSION`, `PLAYON_START=0` | same |

Each Home archive includes **Node.js**, production dependencies, the API, web UI, local node-agent, and platform skills. Open **`http://playon.local`** (or the printed LAN IP fallback) → create Owner → Settings → pick an LLM provider (or MCP) → optionally **Settings → Panel URL** to link Discord for `https://<handle>.playon.games` → optionally **Settings → Nodes** to add capacity → start a game. Players use `/play` on either panel URL.

### Manual archive

From [GitHub Releases](https://github.com/gmcclelland90/playon/releases), or build on the matching OS:

```bash
pnpm build && pnpm package:home
# Windows → dist-home/playon-home-<version>-windows-x64.zip
# Linux   → dist-home/playon-home-<version>-linux-x64.tar.gz
```

- **Windows:** extract → `Start-PlayOn.ps1`
- **Linux:** `tar -xzf … && cd playon && ./start-playon.sh`

Optional: `export PLAYON_ADVERTISE_HOST=192.168.1.50` before start (otherwise LAN IP is auto-detected). Data/secrets: `./data` and `./env`.

## Optional: install as a service (always-on)

```powershell
# Windows — registers scheduled tasks
$env:PLAYON_SERVICE = "1"
irm https://playon.games/install.ps1 | iex
```

```bash
# Linux — systemd units playon + playon-node
curl -fsSL https://playon.games/install | PLAYON_SERVICE=1 bash
```

Or from an extracted tree: `sudo -E bash deploy/install.sh` / `.\deploy\windows\install.ps1`. Uses bundled Node when present; skips `pnpm install` when `node_modules` is vendored.

Use `PLAYON_RUNTIME=native` for SteamCMD-only hosts. Linux **service** install (`deploy/install.sh`) and **install-node** call `deploy/lib/ensure-docker.sh` to provision Docker Engine when missing (opt out with `PLAYON_INSTALL_DOCKER=0`). If the socket is present and you did not force native, runtime defaults to `docker` for container skills. Already-online Linux nodes without Docker: **Settings → Nodes → Install Docker** (SSH or one-liner). SteamCMD auto-provisions when a Steam skill needs it (`PLAYON_STEAMCMD_AUTO`).

## Add a LAN node

```bash
sudo bash deploy/install-node.sh \
  --api http://192.168.1.50:8787 \
  --token "$PLAYON_NODE_TOKEN"
```

Windows: `.\deploy\windows\install-node.ps1 -ApiUrl http://... -Token ...`

The node heartbeats capabilities (`docker`, `native`, `steamcmd`). Runtime jobs (process / container / SteamCMD / FS) execute on that host.

## Optional: Docker panel

For hosts who prefer Compose for the **panel only**:

```bash
cp deploy/.env.example .env   # set ADVERTISE_HOST + SESSION_SECRET
docker compose -f deploy/docker-compose.yml up -d
```

Still run a **host-native** `playon-node` (or install-node against `http://127.0.0.1:8787`) for SteamCMD/native games. Do not mount the Docker socket into the control-plane container for SteamCMD.

## Skills

- Home ships **platform core** only (`PLAYON_SKILLS_PROFILE=minimal`). Curated `games.*` skills are **not** bundled.
- Install games individually on demand:
  - **Chat** — ask to install / create a server (agent uses the playon.games catalog)
  - **Skills → Catalog → Install** — one click per skill
- Catalog URL defaults to `https://playon.games/skills/index.json` (`PLAYON_SKILLS_CATALOG_URL`). Hosts never download zip files by hand.
- Curated `games.*` live only in the sibling **playon-games** repo (`skills-src/` → `pnpm catalog` → `public/skills/`). Never present in Home or monorepo `skills/`.

## Nodes (LAN + cloud BYO)

1. Settings → **Nodes**: choose whether Home also hosts game servers (Local), or control-plane-only.
2. **Add node** via SSH (preferred) or console one-liner:
   - **LAN** — install-node against Home’s LAN API URL; no tunnel.
   - **Cloud** — any VPS you can SSH to; PlayOn installs WireGuard + node-agent; Home is the roaming WG peer; game ports publish through the Home LAN gateway.
3. Install `wireguard-tools` (Linux) or WireGuard for Windows on Home before adding cloud nodes.
4. Vendor Connect (Vultr OAuth, etc.) is **deferred** — scaffold remains under `apps/api/src/services/cloud/` but is not the product path.

## Lab / us

Prefer the same Home tarball customers get (`pnpm package:home`). Tag `v*` builds attach Windows + Linux artifacts via `.github/workflows/release-home.yml`, then sync OTA + deploy playon.games — see **[release.md](release.md)** for the standard CI/CD pipeline. After changing bootstrap scripts only, run `node scripts/sync-install-scripts.mjs` and push playon-games. Dev remains `pnpm dev` + `pnpm loop:verify`.

Source zip (`pnpm package:mvp`) is a power-user fallback, not the primary Get PlayOn path.

## Related

- [release.md](release.md) — Home tag → GitHub Release → `/home/latest.json` → Cloudflare Pages
- [lan-install.md](lan-install.md) — legacy systemd-from-checkout notes
- [linux-dev-host.md](linux-dev-host.md) — lab host
- [design-docs/14](../design-docs/14-cloud-backed-lan-mode.md) — placement + Add-node / WireGuard
- [design-docs/15](../design-docs/15-playon-games-site-and-skill-library.md) — site + catalog
- Sibling **playon-games** repo — Astro site + public skill catalog (playon.games)
