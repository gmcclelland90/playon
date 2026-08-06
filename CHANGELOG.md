# Changelog

All notable changes to PlayOn Home (root `package.json` version) are listed here.

## [0.1.7] — 2026-08-06

### Fixed

- **In-app Update & restart** — Home OTA now applies the downloaded package instead of rebooting onto the old build. Staging runs outside the install tree, Linux swaps before process exit (avoids systemd cgroup kill), nested data roots like `apps/api/data` are preserved, and pnpm workspace symlinks are copied correctly.

### Changed

- systemd unit templates set `KillMode=process` so future apply helpers can outlive the main process during self-update.

### Notes

- Hosts stuck on broken 0.1.5/0.1.6 OTA need a one-time non-OTA upgrade (re-run the install one-liner, or `git pull` + build on lab). After **0.1.7**, Update & restart works for later releases.

## [0.1.6] — 2026-08-06

### Added

- **Skills admin page** — dedicated `/skills` nav with Platform / Installed / Catalog / Drafts tabs, detail panel, catalog install, zip import/export, draft promote, and uninstall (with in-use server warning).
- **Skill management APIs** — `GET /api/skills/:name`, enriched list with `source`, drafts list/promote REST, `DELETE /api/skills/:name`.
- **Resilient catalog fetch** — invalid catalog rows are skipped with `warnings` instead of failing the whole library.

### Changed

- Skill library removed from Settings; local skills panel removed from Dashboard (use **Skills**).
- Host docs point at **Skills → Catalog** for installs.

### Notes

- playon.games catalog metadata fixed (`containerSupport` / theme enums) so catalog browse works on older Homes too; this release is the UI/API overhaul.

## [0.1.5] — 2026-08-06

### Added

- **In-app OTA updates** — Home polls `https://playon.games/home/latest.json` for a newer release. Owners see a dismissible banner and **Settings → About / Updates** with **Update & restart** (download → sha256 verify → swap keeping `data/`/`env/` → restart).
- **Per-node updates** — after Home is current, remote LAN/cloud nodes that report an older `agentVersion` show **Update** under Settings → Nodes (control plane enqueues `node_self_update`; never accepts client-supplied download URLs).
- **Node release packages** — `playon-node-<version>-{linux,windows}-x64` artifacts on GitHub Releases; `pnpm package:node` + release workflow.
- **Update manifest** — `scripts/publish-home-manifest.mjs` writes `playon.games/home/latest.json` with asset URLs + sha256 (override with `PLAYON_UPDATE_MANIFEST_URL`).
- **install-node from manifest** — when curl’d without a local package tree, Linux/Windows install-node downloads the node asset from `latest.json`.

### Notes

- First install or jump from ≤0.1.4 still uses the one-liner / archive. From **0.1.5** onward, Owners can update Home and then each remote node from the UI.
- Local node updates with Home (same bundle). No silent auto-apply in this release.

## [0.1.4] — 2026-08-05

### Added

- **Docker on Linux nodes** — `deploy/lib/ensure-docker.sh` provisions Docker Engine during Home service install and install-node (opt out with `PLAYON_INSTALL_DOCKER=0`).
- **Settings → Nodes → Install Docker** — when a Linux node heartbeats without Docker: Install via SSH or a short-lived sudo one-liner; waits for the next heartbeat.
- Published `https://playon.games/install-node` and `https://playon.games/ensure-docker` via sync-install-scripts.
- Host guide: [playon.games/docs/docker](https://playon.games/docs/docker).

### Changed

- `docker_unavailable` failures point hosts at Settings → Nodes → Install Docker.
- platform.docker-basics INSTALL guide no longer mentions mock runtime.

### Notes

- Windows nodes stay guidance-only (Docker Desktop). Silent Engine install is Linux/root paths only.

## [0.1.3] — 2026-08-05

### Added

- **Ollama in Settings** — when the provider is **Ollama (offline)**, Home probes the configured Base URL, lists installed models, and can pull suggested models (`llama3.2`, `qwen2.5`, `mistral`, …).
- **One-click Ollama install** — on localhost, if Docker is available, **Install Ollama** starts a `playon-ollama` container (`ollama/ollama` on port 11434). No silent install during bootstrap; admin click only.
- Manual install fallback when Docker is missing (copyable official Linux / Windows one-liner).
- Model chooser for installed tags, with a custom model name escape hatch.

### Notes

- One-click install targets the Home control plane host only (loopback). Remote/LAN Ollama URLs still work for probe, pull, and chat — install those yourself on that machine.
- Public guide: [playon.games/docs/providers/ollama](https://playon.games/docs/providers/ollama).

## [0.1.2] — 2026-08-05

### Added

- **Unified Add-a-node** — Settings → Nodes: add LAN or cloud compute via SSH or a short-lived console one-liner.
- **Cloud WireGuard overlay** — PlayOn configures WireGuard on the VPS and Home; hosts do not manage peers by hand.
- **Home LAN gateway** — TCP/UDP port forward so cloud-placed servers still advertise LAN join addresses on `/play`.
- **Local compute toggle** — Home can be control-plane-only (no Local placement) or also host games.
- Node kinds / placement badges: `Local` · `Remote · name` · `Cloud · name`.
- Relocate syncs server data to the target node (archive jobs) before rebinding.
- Agent tools: `nodes_add`, `nodes_remove`.

### Changed

- Relocate is stop → snapshot → **copy** → rebind → restart (not metadata-only).
- Design doc 14 and deploy notes: BYO + WireGuard first; vendor Connect (Vultr OAuth) deferred.

### Notes

- Cloud nodes require WireGuard tools on Home (`wireguard-tools` or WireGuard for Windows).
- Install-node bootstrap still prefers `https://playon.games/install-node` when reachable.

## [0.1.1] — previous

- Portable Home packages, one-line installers, multi-provider LLM presets, MCP surface.
