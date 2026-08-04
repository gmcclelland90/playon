# Deploy PlayOn

**Guiding principle:** flexible where games run, easy however the LAN host wants to install. Docker is a *node capability*, not a PlayOn prerequisite.

## Mental model

| Piece | Role |
|-------|------|
| **Home (control plane)** | Admin UI, agents, placement, SQLite — never needs the Docker socket |
| **Node** | Runs games (native / SteamCMD / optional Docker) |
| **playon.games** | Get PlayOn, skill catalog, Vultr OAuth relay |

Placement per server: **Local** (Home’s local node) · **Remote** (another LAN node) · **Cloud** (Vultr BYO → node + tunnel).

## Primary: one-line install (recommended)

Scripts are hosted on [playon.games](https://playon.games/get) (source: [`deploy/bootstrap/`](../deploy/bootstrap/)). They pull the latest Home release asset and start PlayOn.

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

Each Home archive includes **Node.js**, production dependencies, the API, web UI, local node-agent, and platform skills. Create Owner → Settings → pick an LLM provider (Venice, OpenAI, Ollama, …) and paste your own key if needed → start a game. Players use `/play`.

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

Use `PLAYON_RUNTIME=native` for SteamCMD-only hosts. If `/var/run/docker.sock` exists and you did not force native, Linux service install defaults to `docker` mode for container skills. SteamCMD auto-provisions when a Steam skill needs it (`PLAYON_STEAMCMD_AUTO`).

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
  - **Settings → Skill library → Install** — one click per skill
- Catalog URL defaults to `https://playon.games/skills/index.json` (`PLAYON_SKILLS_CATALOG_URL`). Hosts never download zip files by hand.
- Curated `games.*` live only in the sibling **playon-games** repo (`skills-src/` → `pnpm catalog` → `public/skills/`). Never present in Home or monorepo `skills/`.

## Cloud (Vultr)

1. Register PlayOn Vultr OAuth app; set `PLAYON_VULTR_CLIENT_ID` (and secret) on Home.
2. Settings → Cloud → Connect Vultr → browser via `connect.playon.games` relay.
3. Tokens stored encrypted on the control plane only.
4. Cloud placement provisions a tagged instance, cloud-init runs `install-node.sh`, tunnel plan is recorded (WireGuard/Tailscale gateway TBD).

## Lab / us

Prefer the same Home tarball customers get (`pnpm package:home`). Tag `v*` builds attach Windows + Linux artifacts via `.github/workflows/release-home.yml`. After changing bootstrap scripts, run `node scripts/sync-install-scripts.mjs` and deploy the sibling **playon-games** site. Dev remains `pnpm dev` + `pnpm loop:verify`.

Source zip (`pnpm package:mvp`) is a power-user fallback, not the primary Get PlayOn path.

## Related

- [lan-install.md](lan-install.md) — legacy systemd-from-checkout notes
- [linux-dev-host.md](linux-dev-host.md) — lab host
- [design-docs/14](../design-docs/14-cloud-backed-lan-mode.md) — placement + Vultr
- [design-docs/15](../design-docs/15-playon-games-site-and-skill-library.md) — site + catalog
- Sibling **playon-games** repo — Astro site + public skill catalog (playon.games); update `/get` to point at Releases when ready
