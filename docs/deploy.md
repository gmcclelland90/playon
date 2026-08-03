# Deploy PlayOn

**Guiding principle:** flexible where games run, easy however the LAN host wants to install. Docker is a *node capability*, not a PlayOn prerequisite.

## Mental model

| Piece | Role |
|-------|------|
| **Home (control plane)** | Admin UI, agents, placement, SQLite — never needs the Docker socket |
| **Node** | Runs games (native / SteamCMD / optional Docker) |
| **playon.games** | Get PlayOn, skill catalog, Vultr OAuth relay |

Placement per server: **Local** (Home’s local node) · **Remote** (another LAN node) · **Cloud** (Vultr BYO → node + tunnel).

## Primary: native Home (no Docker)

### Linux

```bash
pnpm build && pnpm package:home   # maintainers / CI
# or download playon-home-*.tar.gz from releases / playon.games

tar -xzf playon-home-*.tar.gz
cd playon
export PLAYON_ADVERTISE_HOST=192.168.1.50   # optional; auto-detected
sudo -E bash deploy/install.sh
```

Opens `http://$PLAYON_ADVERTISE_HOST:8787`. Creates systemd units `playon` + `playon-node`.

Use `PLAYON_RUNTIME=native` for SteamCMD-only hosts. If `/var/run/docker.sock` exists and you did not force native, install defaults to `docker` mode for container skills.

### Windows

Extract the Home zip, elevated PowerShell:

```powershell
.\deploy\windows\install.ps1 -AdvertiseHost 192.168.1.50
```

Scheduled tasks start the API and local node-agent. SteamCMD auto-provisions when a Steam skill needs it (`PLAYON_STEAMCMD_AUTO`).

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

Prefer the same Home tarball customers get (`pnpm package:home` + `deploy/install.sh`). Dev remains `pnpm dev` + `pnpm loop:verify`.

Source zip (`pnpm package:mvp`) is a power-user fallback, not the primary Get PlayOn path.

## Related

- [lan-install.md](lan-install.md) — legacy systemd-from-checkout notes
- [linux-dev-host.md](linux-dev-host.md) — lab host
- [design-docs/14](../design-docs/14-cloud-backed-lan-mode.md) — placement + Vultr
- [design-docs/15](../design-docs/15-playon-games-site-and-skill-library.md) — site + catalog
- Sibling **playon-games** repo — Astro site + public skill catalog (playon.games)
