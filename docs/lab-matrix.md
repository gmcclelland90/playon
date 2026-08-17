# Catalog lab matrix

Opt-in end-to-end stress for every `games.*` skill on the lab topology:

- **Linux / Docker / Steam-Linux** → playon-dev Local, isolated temp `PLAYON_DATA_ROOT` (never durable Home inventory or `playon-node-1`)
- **Windows-only / PE (`.exe`)** → `playon-win-1` (`172.16.0.94`) via live Home API/MCP (Windows agent only heartbeats durable Home)

Proves: create → install → start → declared game port open / query online → stop. Disposable names `lab-matrix-*`; cleaned up after each skill.

## Commands

```bash
# on playon-dev, in /home/playon/src/playon-git
pnpm build                    # dist required (same as paper smoke)
pnpm lab:matrix --tier static # schema/load preflight for all skills
pnpm lab:matrix               # full E2E catalog (serial; stops on first fail)
pnpm lab:matrix --filter docker --continue-on-fail
pnpm lab:matrix --filter windows --continue-on-fail
pnpm lab:matrix --skill games.minecraft-paper
pnpm lab:matrix --skill games.stormworks   # places on playon-win-1 when online
pnpm lab:matrix --resume      # continue after a failure
pnpm lab:matrix --from games.valheim
pnpm lab:matrix --tier tools  # deeper tools on archetype set only
```

Filters: `docker` | `steam` | `windows` | `native` | `other`. `steam` includes Windows-only / PE Steam titles (dual-placed on `playon-win-1` when online). `windows` is PE/windows-os only. Use `--continue-on-fail` for inventory sweeps; omit it when driving the fix-subagent loop.

Requires sibling `playon-games` (or `PLAYON_GAMES_SKILLS_ROOT`) and Docker when skills use images. SteamCMD auto-provisions on Linux when missing.

## Live visibility (GitHub)

- **Now card:** [#52](https://github.com/gmcclelland90/playon/issues/52) (`lab-status`) — short status during/after runs  
- **Detail:** `pnpm lab:report` → `tmp/lab-report.html`; Actions Summary + artifacts on nightly/e2e; cadence posts a history comment on #52  

```bash
pnpm lab:report
pnpm lab:publish-status --force --history-comment
```

## Artifacts

| File | Role |
|------|------|
| `tmp/lab-matrix-status.json` | Resume cursor + per-skill phases |
| `tmp/lab-matrix-issues.jsonl` | Failure log for fix subagents |

A skill is `ok` only when `port_open` passes:

- **TCP:** connect succeeds (Linux loopback / Windows `net_port_check` against `join_host`). Ready-gate / in-app “up” is the advertised join host from Home; a localhost check must run on the server’s node (`net_tcp_connect`), not the API host.
- **Linux UDP:** `ss -uln` shows the required bind (query port only when `queryPortName` is set — Steam-networking exception). `status=running` is not enough.
- **Windows UDP / no-TCP:** node-side listen (`net_port_check protocol=udp` → `net_udp_listen` job, Windows `netstat`) **or** query-online. Home `status=running` is not enough. Old agents that do not advertise `net_udp_listen` fall back to query; no dialect + no listen → `udp_listen_unproven`.

Static green alone is not enough. Do not loosen Linux to match Windows. Regression: `windowsUdpPortOpenVerdict` unit tests in `@playon/shared` plus a real UDP bind via `probeUdpListen` / `net_udp_listen` (no friend servers).

Linux `port_open` still probes **loopback** (`127.0.0.1`). That is intentional and must not be relaxed to shrink the skill queue. The published join path (`resolveJoinAddress` / `nodes.join_host`) is a **separate** fixture canary:

```bash
pnpm build
pnpm lab:join-path-canary              # address resolution + TCP split (CI-safe)
pnpm lab:join-path-canary --live-docker  # also start fixtures.lab-docker-server (lab)
```

| Topology | CI / unit | Lab live |
|----------|-----------|----------|
| Linux `fixtures.lab-docker-server` | `resolveJoinAddress` + TCP listener (fail if loopback open and join host closed) | `--live-docker` |
| WSL sibling | parent Windows `join_host` (not WSL-internal / `127.0.0.1`) | Manual: [wsl-phase2-smoke-checklist.md](wsl-phase2-smoke-checklist.md) on `playon-win-1` |
| Windows PE | same fixture as a TCP stand-in on `playon-win-1` `join_host` (no PE binary in this repo) | Disposable native TCP on `playon-win-1` only — never friend servers / NZL |

Wire the script into Playon Ops `playon-polish-canary` ([#835](https://github.com/gmcclelland90/playon/issues/835)). See [automations.md](automations.md).

## Isolation rules

- Linux path: always `mkdtemp` data root; refuse durable Home paths; `nodeId: "local"`
- Windows path: live Home + `nodeId: playon-win-1` only (set `PLAYON_MATRIX_WIN_NODE_ID=off` to force skips). Auth auto-mints into `tmp/lab-matrix-home-auth.json` against durable DB for MCP/session — does not mutate live game servers outside `lab-matrix-*`. Requires `playon-win-1` online with `join_host` set; SteamCMD marks the server node-authoritative so Home does not push-wipe the install
- Disposable names `lab-matrix-<slug>`; stop + remove + `docker rm` after each skill
- Do not schedule matrix work on `playon-node-1`
- Live Zomboid (or any) server under systemd Home is out of bounds; the **skill** `games.project-zomboid` is still E2E-tested in the temp root

## Agent turn protocol

1. Read `tmp/agent-loop-status.json` — fix merge bar first if red.
2. Read `tmp/lab-matrix-status.json` — if `ok=false`, resume that skill.
3. On playon-dev only: `git pull --ff-only` → `pnpm install` → `pnpm build` → `pnpm lab:matrix --resume`.
4. On failure: classify (`skill_bug` / `platform_bug` / `steamcmd_timeout` / `steamcmd_empty_depot` / `steamcmd_no_subscription` / `platform_unsupported` / `allowed_skip` / `flake`). Port-not-open is a failure. SteamCMD classes do not change skip vs fail.
5. Launch a fix subagent with skill name, failed phase, ports expected vs observed, status tail. Patch → push → pull → `pnpm loop:verify` (add `:runtime` if Docker lifecycle) → `pnpm lab:matrix --skill <failed>`.
6. Continue cursor. Do not schedule matrix work on `playon-node-1`. Windows PE skills dual-place to `playon-win-1` when that node is online.

## Allowed skips

- Host-supplied binaries with no Steam/Docker install path (e.g. `games.unreal-tournament-99`, `games.quakeworld`)
- Host-supplied SCS convoy packages (`games.ats`, `games.ets2`) — SteamCMD installs the dedi, but `server_packages.sii`/`.dat` must come from a client `export_server_packages` → `host_supplied_packages`
- FOSS titles without packaged fetch automation → `no_automated_install` after a failed start
- SteamCMD `Invalid platform` on Linux Local → dual-place to `playon-win-1` when online; only `windows_only_depot` skip if Windows worker is off
- SteamCMD `No subscription` under anonymous login (paid/licensed depot; e.g. `games.arma3`, `games.assetto-corsa`) → `steamcmd_no_subscription`
- SteamCMD exits 0 but ships `EmptySteamDepot` / `SizeOnDisk=0` (publisher emptied the public depot; e.g. `games.risk-of-rain-2` app 1180760 build 20243729) → `steamcmd_empty_depot`
- Skill `os` / PE binary needs Windows but dual-place is disabled or `playon-win-1` offline → `unsupported_host_os` / `windows_only_pe`

Everything else must pass E2E or be fixed.

## Relation to merge bar

Not part of `pnpm loop:verify`. Use after the merge bar is green when validating catalog skills.

## Standing cadence + GitHub intake

On playon-dev (24/7), the systemd timer in [infra/lab/README.md](../infra/lab/README.md) is the standing cadence (reinstall only after a host rebuild). Each tick: merge bar → `lab:matrix --continue-on-fail` → file Issues; ticks also leave history comments on [#52](https://github.com/gmcclelland90/playon/issues/52).

Failures also file immediately at the end of a matrix run via `scripts/lab-file-github-issues.mjs` (`source:lab`). Filing uses the **current** status file’s failures (not the full historical `issues.jsonl`), fingerprints **one issue per skill** (phase changes comment on that issue), and will not reopen a closed fingerprint unless `PLAYON_LAB_REFILE=1`. Detectable SteamCMD tails set `errorClass` to `steamcmd_timeout` / `steamcmd_empty_depot` / `steamcmd_no_subscription` (pass/fail is unchanged). See [testing-plan.md](testing-plan.md) and [sdlc.md](sdlc.md).

### One-time clone cleanup

Older filing keyed fingerprints by `skill:phase:errorClass`, which opened start / port_open / query clones for the same title. After fingerprint-by-skill, close extras as duplicate of the oldest open issue **only after a dry-run**:

```bash
pnpm lab:file-issues --close-clones           # print keep/close plan (no writes)
pnpm lab:file-issues --close-clones --apply   # close extras as duplicate of the oldest
```

`--close-clones` without `--apply` is always a dry-run. `--dry-run` wins over `--apply`. Do not run `--apply` from cadence.

### Cleanup

Each matrix run deletes its disposable Home `lab-matrix-*` server and removes its temp `dataRoot` in a `finally` (including SIGINT/SIGTERM). At start it also sweeps other `/tmp/playon-lab-matrix-*` trees older than 1h that no live matrix process still holds.

If agents were killed mid-run, reclaim leftovers explicitly:

```bash
pnpm lab:matrix-cleanup              # stale temps (>1h) + Home lab-matrix-* when idle
pnpm lab:matrix-cleanup --max-age-hours 0
pnpm lab:matrix-cleanup --dry-run
```
