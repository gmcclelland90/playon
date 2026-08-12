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

Windows (elevated PowerShell): `.\deploy\windows\install-node.ps1 -ApiUrl http://... -Token ...`

The Windows node agent registers as the **installing admin user** with RunLevel Highest and LogonType **S4U** (`PlayOnNodeAgent`, at-startup). That stays up without a desktop session, avoids a second UAC for **Enable Linux runtime**, and can own that user’s WSL distros. Do **not** run the agent as SYSTEM — WSL returns `WSL_E_LOCAL_SYSTEM_NOT_SUPPORTED`.

Existing non-elevated / SYSTEM / Interactive-only Windows nodes: run once (elevated)  
`.\deploy\windows\elevate-node-agent.ps1`

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
- Catalog URL defaults to `https://playon.games/packages/index.json` (`PLAYON_SKILLS_CATALOG_URL`). Hosts never download zip files by hand.
- Curated `games.*` live only in the sibling **playon-games** repo (`packages-src/` → `pnpm catalog` → `public/packages/`). Never present in Home or monorepo `packages/`.

## Nodes (LAN + cloud BYO)

1. Settings → **Nodes**: choose whether Home also hosts game servers (Local), or control-plane-only.
2. **Add node** via SSH (preferred) or console one-liner:
   - **LAN** — install-node against Home’s LAN API URL; no tunnel.
   - **Cloud** — any VPS you can SSH to; PlayOn installs WireGuard + node-agent; Home is the roaming WG peer; game ports publish through the Home LAN gateway.
3. Install `wireguard-tools` (Linux) or WireGuard for Windows on Home before adding cloud nodes.
4. Vendor Connect (Vultr OAuth, etc.) is **deferred** — scaffold remains under `apps/api/src/services/cloud/` but is not the product path.

## Linux runtime (WSL) — Windows nodes

Any **Windows node** can host a sibling Linux compute node via WSL2. Home may run on Linux or Windows — WSL setup always runs on the Windows host.

**Enable (Settings → Nodes → Windows node row → Enable Linux runtime):**

1. Click **Enable Linux runtime** on the Windows node (agent must be elevated — default after `install-node.ps1`).
2. PlayOn runs `wsl_ensure` on that node with no UAC when the agent is an elevated admin user (default after `install-node.ps1`).
3. Fallback: if the agent is still non-elevated, Home shows an elevated PowerShell one-liner (or run `elevate-node-agent.ps1` once).
4. After reboot (if prompted), click Enable again. PlayOn creates the `playon-linux` distro, installs Docker Engine inside it, and starts the sibling node-agent.
5. Once the sibling heartbeats, placement considers it for `os: [linux]` skills.

**Sibling node ids:** `local` → `local-wsl`; any other Windows node `N` → `N-wsl`.

**Technical details:**

- Distro: `playon-linux` (Ubuntu-based, imported via `wsl --import`)
- Runtime: Docker Engine inside WSL (not Docker Desktop)
- Durability: ensure writes `%UserProfile%\.wslconfig` with `vmIdleTimeout=-1`. The Windows parent node-agent holds an open `wsl` session and restarts the sibling agent every 15s (`PLAYON_WSL_KEEPALIVE=0` to disable).
- Sibling agent heartbeats to the same Home as the Windows node (`-ApiUrl` / `-NodeToken` / `-NodeId`)
- APIs: `/api/nodes/:nodeId/wsl/{status,enable,repair,token}` (legacy `/api/wsl/*` targets `local`)

**Manual / CLI:**

```powershell
# Check status
.\deploy\windows\ensure-wsl-runtime.ps1 -StatusOnly -NodeId local-wsl

# Enable against a remote Home (requires elevation)
Start-Process powershell -Verb RunAs -ArgumentList '-File', '.\deploy\windows\ensure-wsl-runtime.ps1',
  '-ApiUrl', 'http://HOME:8787', '-NodeToken', '<token>', '-NodeId', 'win-1-wsl'

# Repair
Start-Process powershell -Verb RunAs -ArgumentList '-File', '.\deploy\windows\ensure-wsl-runtime.ps1',
  '-ApiUrl', 'http://HOME:8787', '-NodeToken', '<token>', '-NodeId', 'win-1-wsl', '-Repair'
```

**Errors:**

| Code | Error | Remedy |
|------|-------|--------|
| 10 | `wsl_reboot_required` | Reboot Windows, then run Enable again |
| 11 | `wsl_virt_disabled` | Enable Intel VT-x / AMD-V in BIOS |
| 12 | `wsl_user_cancelled_uac` | Elevate the node agent (`elevate-node-agent.ps1`) or accept UAC / one-liner |
| 13 | `wsl_distro_failed` | Check disk space; remove stale WSL distro manually |
| 14 | `wsl_docker_failed` | Run Repair; check WSL distro logs |
| 15 | `wsl_agent_failed` | Run Repair; verify PLAYON_NODE_TOKEN matches Home |

**Related:** [design-docs/19](../design-docs/19-wsl-linux-runtime.md)

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
