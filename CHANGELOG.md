# Changelog

All notable changes to PlayOn Home (root `package.json` version) are listed here.

## Unreleased

### Fixed

- **Managed instance liveness** — start never stacks a second process or container for the same server id. Leftovers under the server tree (including a JVM that chdir'd out of `game/` into `home/`) are reaped first; a healthy instance (alive and advertised game ports bound on the host) is reused. A process/container that is alive but has dropped those ports is dead: reap, mark `error`, never report running. Health treats host-local unbound advertised ports as failed (`onFail: restart`), not as a join-path publish gap (`#877`). New servers seed an enabled **Health monitor** watcher (tools `servers_health_check` + remediate — one clean restart, not an agent turn on managed hosts). `workshop_update` stays notify-only and cannot auto-restart. Existing / imported / friend servers are not migrated. Generic for native and docker — not PZ-specific (`#880`).

## [0.2.7] — 2026-08-14

### Fixed

- **WSL LAN join path** — after a WSL sibling start, the Windows parent publishes game/RCON/query ports on its advertised `join_host` (userspace `net_port_publish` → `127.0.0.1`, where WSL localhostForwarding already listens). Empty WSL `join_host` is synced from the parent. Ready / “up” / panel join_info still require that advertised host:port open from Home. `net_port_check` on localhost without `nodeId` returns `loopback_requires_nodeId` (Home soak Paper must not count). Placement skips a WSL sibling for LAN-joinable skills when the parent join host is loopback/empty or the Windows agent does not advertise `net_port_publish`, and falls back to a node that can publish (e.g. local docker / playon-dev). Does not ask hosts to run `netsh` portproxy. Update the Windows node agent so `net_port_publish` is advertised (`#877`).
- **Windows `package:node` tarball** — GitHub `windows-latest` uses bsdtar, which has no `--force-local`. Create the OTA `playon-node-*-windows-x64.tar.gz` from the output directory with a relative `-f` so the colon in `D:` is not treated as a remote host. Zip + Linux tarball unchanged; `latest.json` still prefers the Windows tar.gz (`#876`).

### Notes

- This is the actual Home ship after `v0.2.6` `release-home` failed on Windows tar `--force-local`. Do not move or delete the `v0.2.6` tag.
- Update Home via OTA, then Update Windows nodes from Settings → Nodes.
- playon-win-1 is still on agent 0.2.3; do not retry the 0.2.5 zip. After this tag, press Update on the Windows parent only (tarball).

## [0.2.6] — 2026-08-14

### Added

- **Windows container runtime** — a Windows node with Docker Engine in Windows container mode (Server Core or Desktop) reports `docker` for Windows isolation, can place `os: [windows]` + `containerSupport: full` skills, and starts those images with Windows bind destinations, daemon isolation, and TTY (`docker run -t`). Linux Docker and the WSL sibling path are unchanged (`#873` / `#874`).

### Fixed

- **Skill scan / Paper smoke** — `native.libraryPathRelative` stringifies finite YAML numbers (unquoted Steam app ids such as `376030` used as AMP-style dirs). One invalid skill no longer aborts `listSkills` / `createFromSkill` (`#871` / `#872`).
- **Windows node self-update extract** — `node_self_update` no longer unpacks the zip with `execFileSync("powershell.exe", Expand-Archive, { timeout: 60000 })` (`spawnSync powershell.exe ETIMEDOUT` on playon-win-1, `#868`). Extract is async `tar` (zip and tar.gz; `--force-local` on Windows) with a 10-minute cap and a PowerShell fallback that sets `$ProgressPreference = 'SilentlyContinue'`. Ships `playon-node-*-windows-x64.tar.gz` and prefers it in `latest.json` so 0.2.3/0.2.5 agents use their existing `tar -xzf` branch and skip Expand-Archive. Home Windows zip and Linux tarball paths unchanged (`#868` / `#869`).
- **Windows `package:node` tarball** — GitHub `windows-latest` uses bsdtar, which has no `--force-local`. Create the OTA `playon-node-*-windows-x64.tar.gz` from the output directory with a relative `-f` so the colon in `D:` is not treated as a remote host. Zip + Linux tarball unchanged; `latest.json` still prefers the Windows tar.gz.

### Notes

- Update Home via OTA, then Update Windows nodes from Settings → Nodes.
- playon-win-1 is still on agent 0.2.3; do not retry the 0.2.5 zip. After this tag, press Update on the Windows parent only (tarball).

## [0.2.5] — 2026-08-13

### Changed

- **Settings LLM presets** — Groq is no longer an out-of-the-box provider. Custom OpenAI-compatible endpoints still accept any base URL and key (`#866`).

### Fixed

- **Settings → Nodes row layout** — Windows parent rows with a WSL helper no longer wrap Update/Remove under the chips. Header stays name/chips | actions; helper copy sits below. Optional Docker Desktop is not a warn-scream **No Docker** chip when an online WSL sibling already has Docker (`#864`).
- **Node Update feedback** — queued / running / failed status shows on that node’s row. `node_self_update` jobs persist across a Home restart so Update is not a silent miss; pressing Update again reuses an in-flight job or re-queues if the job is gone. Windows parent Update still targets only that node (WSL sibling keeps its own button) (`#864`).
- **Windows node self-update** — `apply-self-update.ps1` disables PlayOnNodeAgent RestartCount and relaunches outside the agent Job (one-shot `PlayOnNodeAgentApplyUpdate` task, or `CREATE_BREAKAWAY_FROM_JOB`) so Task Scheduler cannot restart the old binary and kill the helper before the zip lands. Home no longer marks a running `node_self_update` `abandoned` when the agent calls `jobs/next` after the swap; a matching heartbeat completes the job. Linux tarball path unchanged (`#864`).

### Notes

- Update Home via OTA (**Settings → About / Updates → Update & restart**).
- Update Windows nodes from **Settings → Nodes** so the self-update helper no longer dies with the old agent PID.
- Groq remains reachable as a custom OpenAI-compatible URL; it is just not a preset.

## [0.2.4] — 2026-08-13

### Added

- **Join-path canary** — `pnpm lab:join-path-canary` probes published `joinHost:gamePort` from `resolveJoinAddress` / `nodes.join_host` (not `127.0.0.1`). Fails if loopback is open but join host is not. Linux `fixtures.lab-docker-server` in CI/unit; WSL sibling + Windows PE live TCP documented as lab-only. Does not relax matrix `port_open` (`#843`).
- **LLM canary v2** — `pnpm lab:llm-canary` asserts a two-step tool trace on a disposable `lab-*` fixture (Venice required; Ollama `llama3.2` / `qwen2.5` when reachable). Missing Ollama is `reachable=false` and does not fail the Venice path (`#845`).
- Canvas **degraded-mode** note when a model prints tool-shaped text instead of calling tools; MCP and manual Start/Stop still work. Gemma is not blocklisted.

### Changed

- **Scoped in-app tool catalog** — chat turns send an install/maintain subset instead of all ~64 tool defs (~25k tokens). A spin-up turn keeps create/start/health/stop/list/placement/panel; rcon, WSL, snapshots, watcher-delete, and skill promote stay off that surface. MCP and watcher scripts still get the full catalog (`#862`).
- **NVIDIA sequential tool calls** — NVIDIA / llama-3.1-8b backends set `parallel_tool_calls=false` and accept only one `tool_call` per completion; the orchestrator still loops. Venice/grok remain uncapped if the model emits a batch (`#862`).
- **In-session stop** — `servers_stop` of a server this chat created (inverse of `servers_create_from_skill` this turn/session) auto-approves. `watchers_delete` stays confirm-gated. Unbound `servers_list` does not leak live inventory; friend/live servers are not valid stop targets just because list returned them (`#862`).
- **Ollama Settings default** — suggested/default tag is `qwen2.5` (`llama3.2` has no native tools). Native Gemini default stays `gemini-2.5-flash` (stale 404 for new keys; a follow-up will pick a live id). Settings hint documents that; Gemini 3.x tool loops round-trip `thought_signature` (`#862`).

### Fixed

- **Windows UDP `port_open`** — lab-matrix no longer treats Home `status=running` as a listen. Windows UDP/no-TCP requires query-online or a node-side `net_udp_listen` check (`ss`/`netstat`). Linux `ss` path is unchanged (`#846`).
- **`fetch_url` destinations** — RFC1918 and localhost are blocked by default (no implicit loopback exception). Hosts opt in NAS/loopback IPs or CIDRs under Settings → Nodes. Link-local metadata cannot be allowlisted (`#861` / `#858`).
- **Watcher seed guard** — never seed `action.kind=agent` on managed or node-authoritative servers. Skill templates may still declare agent actions for lab/unmanaged hosts; `seedFromSkill` rewrites those to tools + notify so an auto-approved agent turn cannot restart or mutate a live world (`#860` / `#857`).
- **Native Gemini tool follow-ups** — OpenAI-compat client persists and echoes `tool_calls[].extra_content.google.thought_signature` so Gemini 3.x does not 400 `missing thought_signature` on the next functionCall. OpenRouter `google/gemini-*` is unchanged (already PASSed usage-bar) (`#862`).

### Notes

- Update Home via OTA (**Settings → About / Updates → Update & restart**).
- Venice default remains **grok-4-5**.
- Ollama suggested/default tag is now **qwen2.5**.
- Gemini Settings default `gemini-2.5-flash` still 404s for new Google keys — use a live 3.x model id or OpenRouter.

## [0.2.3] — 2026-08-12

### Added

- **WSL Phase 2: Networking & LAN join** — Detect mirrored (Win11 22H2+) vs NAT networking mode; join host resolution for WSL-placed servers uses parent Windows node's LAN IP; Settings warns when NAT requires manual portproxy (`#297` / `#831`).
- `workshop_update` watcher trigger — poll Steam Workshop publishedfile `time_updated` and fire when mods change (`#828` / `#829`).
- Docs: `docs/workshop-watcher.md` (notify-only default; schedule reboot rather than auto-restart).
- Smoke checklist: `docs/wsl-phase2-smoke-checklist.md`.

### Fixed

- **Managed native launches** — pass `PLAYON_MANAGED_FROM` from the skill marker into the process env so overlay `start.sh` can find binaries outside the jail (`#832`). Companion skill fix is playon-games#28.

### Notes

- Intended for hosts like NewZombieLand3 crowbar mod (workshop id `3579640010`).
- No automatic server restart from this trigger unless the watcher action explicitly includes restart tools.
- WSL Phase 3 (Docker Desktop integration) deferred.

## [0.2.2] — 2026-08-11

### Added

- **WSL Linux runtime on Windows nodes** — Settings → Nodes → **Enable Linux runtime** enrolls a sibling `local-wsl` / `{nodeId}-wsl` agent (Docker Engine inside `playon-linux`). Works when Home is on Linux; setup runs on the Windows host via the elevated node agent (no second UAC after `install-node.ps1`).

### Fixed

- WSL re-Enable no longer fights a running agent binary (`Text file busy`) or mislabels that failure as Docker.
- Windows parent agent keeps the WSL sibling awake (hold session + idle-timeout config) so refresh does not show a false “Enable” again.
- Int merge bar: SteamCMD auto-install spawn `ENOENT` maps to `SteamcmdNotFoundError`; Docker Paper tests clean up root-owned `game/.cache` (#779).

### Notes

- Update Home via OTA. Update Windows nodes so the agent includes WSL keepalive / ensure script improvements.
- First Enable may still reboot once for WSL platform features; then click Enable again.

## [0.2.1] — 2026-08-09

### Fixed

- **Remote node heartbeats after `:80` bind** — when Home prefers LAN `:80` (`playon.local`), also keep LAN `:8787` so existing node-agents with `PLAYON_API_URL=http://home:8787` stay online. 0.2.0 had left `:8787` on loopback only.

### Notes

- Update Home via OTA. Remote agents do not need a URL change for this fix; updating the agent stamp is optional.

## [0.2.0] — 2026-08-09

### Added

- **`http://playon.local`** — mDNS LAN panel URL (prefer bind `:80`, fallback `:8787`).
- **Discord-linked `https://<handle>.playon.games`** — optional LAN-only DNS + Let’s Encrypt; Settings → **Panel URL**.
- playon.games **home-dns** APIs for link + ACME (site already live).

### Changed

- Admin UI **Excellent** pass (Map, Dashboard, Skills, Files, Settings, Player) under the LAN control booth brand.
- Player `/play` — sticky join actions, clearer Live status, ready/vote undo, calmer multi-server layout.

### Notes

- Update Home via OTA (**Settings → About / Updates → Update & restart**). Update remote nodes from **Settings → Nodes** when the agent stamp matters.
- Game join addresses still use the LAN IP (`PLAYON_ADVERTISE_HOST`); panel URLs are for the web UI only.
- No Cloudflare tunnel / paid hostname in this cut — `playon.local` remains the default optics.

## [0.1.11] — 2026-08-09

### Added

- **Server Runtime Handle** — start/stop/restart/status/logs/stdin through one mode×locality surface (local/remote × docker/native).
- **Server File Store** — path-jailed server data I/O with Home vs node locality (`servers.files`).
- **Server Adoption** — unified create/import/manage provision spine.
- **AgentTurn** — shared chat + watcher agent runner (`plane.agentTurn.run`).
- Shared HTTP error envelope across session, MCP, and node-token routes.

### Changed

- Home native stop is **mode-correct** (no docker dual-fire after Handle stop).
- Live Home log follow goes through `ServerRuntimeHandle.followLogs` (remote still node-agent fan-in).
- Snapshots pull node-authoritative trees before create and push remote trees after restore.

### Fixed

- Int tests remove leftover `playon-*` Docker containers between cases so `:25565` is not stolen mid-suite.

### Notes

- Architecture portfolio spine (W1–W5) and W2 leftovers are on `main`. Update remote node-agents from **Settings → Nodes** when you want builds stamped **0.1.11**.

## [0.1.10] — 2026-08-08

### Added

- **Watchers** — scheduled and event-driven Monitor automation. Triggers: schedule (interval + optional cron), `server.status`, log patterns, health/query polls, and panel vote/readiness. Actions: allowlisted tool scripts or scoped agent turns (auto-confirm audited). HTTP + MCP `watchers_*` tools, Dashboard/Settings UI, skill metadata templates (lab fixture ships examples disabled by default).
- **Files editor (Monaco)** — browse and edit server configs and skill package files from the admin UI with syntax highlighting and path-jailed FS tools.
- **Map Terminal console bubble** — dialect-agnostic live console on the map (open by default when a server is selected): stream Docker/native/remote logs, resize with edge/corner handles, send admin commands (including Source RCON and Minecraft RCON).

### Fixed

- Native/remote log tails read from the end of `console.log`; Docker multiplex headers stripped from container log lines.
- Prevent stacked native game processes; pin Zomboid userdata into `PLAYON_HOME` for managed native starts.
- Resolve RCON against the live node for remote servers.

### Changed

- Chat renders markdown and adds a **Stop** control for in-flight agent turns.

### Notes

- Pre-release tag `v0.1.10-console` covered early Terminal work; this **0.1.10** Home release is the full ship (console + Files + Watchers).
- No new node-agent job kinds required for Watchers or Files (uses existing FS/console paths). Update remote nodes from **Settings → Nodes** when you want the latest agent build stamped **0.1.10**.

## [0.1.9] — 2026-08-07

### Fixed

- **LAN / node-authoritative thrash** — join, health, and live query now use the node’s `join_host` (not Home `advertiseHost` / `127.0.0.1`), so remote servers are not “healed” against the wrong host.
- **No invented Minecraft `:25565`** — skills without a TCP game port (UDP-only or portless drafts) no longer get a default TCP health probe that forces restart loops.
- **Map Manage binds catalog skills** — `manageFromNode` uses `import-hints` `suggestedSkillName` (e.g. `games.project-zomboid`) instead of always scaffolding an empty `drafts.managed-*`.
- **Node-authoritative `fs_*`** — list/read/write/delete/rename/copy route to the live node jail; node-agent gains `fs_read_text` (with archive fallback on older agents).

### Changed

- Agent prompts: Steam Workshop refresh path vs zip/URL mods; trust skill join metadata; resume finishes the stated task instead of blindly start + panel publish.
- Lab can mount sibling `playon-games` via `PLAYON_GAMES_SKILLS_ROOT` / auto sibling discovery.

### Notes

- Update remote node-agents from **Settings → Nodes** after Home is on **0.1.9** so they gain `fs_read_text` (and stop using the slower archive read fallback).
- Catalog skill `games.project-zomboid` **0.1.1** adds a Workshop `MODDING.md` runbook (ship via playon-games catalog).

## [0.1.8] — 2026-08-07

### Added

- **Map Scan → Manage cutover** — after seeding an existing install into the node jail, PlayOn sniffs systemd for launch args, copies hint-defined external world/config into a per-server `HOME`, and writes `start.sh` + `.playon-start.env` so Start works without hand repair.
- **Per-game manage hints** in `skills/import-hints.yaml` for Project Zomboid, Valheim, Terraria, Factorio, Rust, Minecraft, and UT99 (userdata paths + CLI flag forms including `+server.identity` / `--start-server`).

### Fixed

- Managed native skills no longer store `runtimeMode: docker`, which had made reconcile flip a successful process Start back to stopped.
- `manage_seed` copies asynchronously so the node-agent keeps heartbeating during large installs.
- Non-interactive `-adminpassword` for Zomboid-style first boots under the agent (no TTY).

### Changed

- Map Manage UI copy: install **and** known external world/config are copied on the host; original install is left in place; stop the old host unit before Start.

### Notes

- Manage never auto-stops the old systemd unit — follow-up includes `stop_host_unit:<name>` when detected.
- The node-agent user must be able to read the service user’s userdata (e.g. ACL on `~/Zomboid`) for external cutover copies.
- After Home is on **0.1.8**, update remote node-agents from **Settings → Nodes** so they gain `manage_cutover`.

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
