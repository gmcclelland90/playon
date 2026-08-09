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

A skill is `ok` only when `port_open` passes (TCP listen, or UDP + process/query). Static green alone is not enough.

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
4. On failure: classify (`skill_bug` / `platform_bug` / `platform_unsupported` / `allowed_skip` / `flake`). Port-not-open is a failure.
5. Launch a fix subagent with skill name, failed phase, ports expected vs observed, status tail. Patch → push → pull → `pnpm loop:verify` (add `:runtime` if Docker lifecycle) → `pnpm lab:matrix --skill <failed>`.
6. Continue cursor. Do not schedule matrix work on `playon-node-1`. Windows PE skills dual-place to `playon-win-1` when that node is online.

## Allowed skips

- Host-supplied binaries with no Steam/Docker install path (e.g. `games.unreal-tournament-99`, `games.quakeworld`)
- Host-supplied SCS convoy packages (`games.ats`, `games.ets2`) — SteamCMD installs the dedi, but `server_packages.sii`/`.dat` must come from a client `export_server_packages` → `host_supplied_packages`
- FOSS titles without packaged fetch automation → `no_automated_install` after a failed start
- SteamCMD `Invalid platform` on Linux Local → dual-place to `playon-win-1` when online; only `windows_only_depot` skip if Windows worker is off
- SteamCMD `No subscription` under anonymous login (paid/licensed depot; e.g. `games.arma3`, `games.assetto-corsa`) → `steamcmd_no_subscription`
- Skill `os` / PE binary needs Windows but dual-place is disabled or `playon-win-1` offline → `unsupported_host_os` / `windows_only_pe`

Everything else must pass E2E or be fixed.

## Relation to merge bar

Not part of `pnpm loop:verify`. Use after the merge bar is green when validating catalog skills.

## Standing cadence + GitHub intake

On playon-dev (24/7), install the systemd timer in [infra/lab/README.md](../infra/lab/README.md). Each tick: merge bar → `lab:matrix --continue-on-fail` → file Issues.

Failures also file immediately at the end of a matrix run via `scripts/lab-file-github-issues.mjs` (`source:lab`). See [testing-plan.md](testing-plan.md) and [sdlc.md](sdlc.md).
