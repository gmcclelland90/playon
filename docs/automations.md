# Cursor Automations (intake)

Wire these in the Cursor Automations editor when ready. Until then, triage can be run manually with `gh` + an agent following [issue-triage.md](issue-triage.md).

## 1. Triage on new issue

| Field | Value |
|-------|--------|
| Name | PlayOn issue triage |
| Trigger | GitHub issue opened (repo `gmcclelland90/playon`) |
| Goal | Classify and either mark `ready` + `safe-auto` or `blocked-human` + one-screen decision |
| Instructions | Follow `docs/issue-triage.md`, `docs/sdlc.md`, and `docs/observability.md`. Dedupe. Never implement in this automation — labels and comments only. Features without prior approval stay `needs-human`. `@gmcclelland90` on every `P0` / `blocked-human`. Set PlayOn Ops Project Status to match (`Fire` / `Needs you` / `Ready`). |
| Tools | GitHub issue read/write (labels, comments); PlayOn Ops project item status |

Mirror later for `gmcclelland90/playon-games` with the thinner label set.

## 2. Execute ready queue (optional second automation)

| Field | Value |
|-------|--------|
| Name | PlayOn ready executor |
| Trigger | Issue labeled `ready` **or** weekday evening / weekend cron |
| Goal | Pick highest-priority `ready` under WIP limit (max 10 `in-progress`; skill work clustered to 1–2 engine families, rest of budget for platform P1s), implement, verify per `docs/testing-plan.md`, open PR with `Fixes #N` |
| Instructions | Obey fire-first rule and WIP clustering in `docs/sdlc.md`. Keep cockpit updates per `docs/observability.md` (progress comments, Project Status → `In progress` / `Done`). Stop and set `blocked-human` + `@gmcclelland90` on human gates. Lab verify on Linux host when merge bar required. |
| Tools | GitHub + repo checkout; PlayOn Ops project; lab access as configured |

## 3. Polish canaries (Playon Ops)

Cursor workflow `playon-polish-canary` ([#835](https://github.com/gmcclelland90/playon/issues/835)). These cover gaps the skill matrix does not: overnight soak, managed-install / `PLAYON_MANAGED_FROM`, Home OTA + lab node bumps, playon.games catalog/OTA manifest, WSL Phase 2 join. **Fixture-only** — never NewZombieLand3 / friend live servers. Extra unit CI is out of scope (verify + packaging/image + nightly-docker stay as-is).

Live ledger: Cursor Automations → `playon-polish-canary`. Red run → file a product issue; do not add GitHub Actions jobs from a canary miss.

### Standing checks

| Canary | Cadence (Sydney) | Routine / notes |
|--------|------------------|-----------------|
| Soak morning | Weekdays 08:54 | Disposable `lab-*` / fixture servers survived the night. Never NZL. |
| Managed-install | Weekdays 10:54 | Fixture overlay that needs `PLAYON_MANAGED_FROM`. Never friend worlds. |
| Home OTA + node agents | Weekdays 11:54 | Lab hosts only (`playon-dev` Local, `playon-win-1`). **Skip friend-hosting nodes** unless Glenn approves a window. |
| Site / catalog (playon.games) | Mon/Thu 12:54 | Public site + OTA manifest + catalog index. |
| WSL Phase 2 smoke | Mon/Thu 14:54 | Join-host / publish on `playon-win-1` ([wsl-phase2-smoke-checklist.md](wsl-phase2-smoke-checklist.md)). Full client join from another LAN device stays the checklist. |
| Join-path (`resolveJoinAddress`, not `127.0.0.1`) | With polish / lab | `pnpm build && pnpm lab:join-path-canary` ([#843](https://github.com/gmcclelland90/playon/issues/843)). Ready-gate probes the advertised host from Home; remote loopback diagnosis is `net_tcp_connect` on that node (never Home soak). Optional `--live-docker` on the lab host. WSL sibling + Windows PE live TCP stay lab-only (see [lab-matrix.md](lab-matrix.md)). Do **not** change matrix `port_open`. |
| LLM model (`llm-model-compat`) | Mon/Thu | `pnpm lab:llm-canary --home` ([#836](https://github.com/gmcclelland90/playon/issues/836) / [#845](https://github.com/gmcclelland90/playon/issues/845)). Home Settings+Chat on disposable `lab-llm-canary` with crash-safe restore + teardown (see [llm-model-compat.md](llm-model-compat.md)). In-process `pnpm lab:llm-canary` does not mutate Home. Ollama `reachable=false` does not fail Venice. Do not blocklist Gemma. File **product** Venice FAILs only (`pnpm lab:file-issues --from llm-canary`); skip `partial_trace` / disconnect flakes. |

### First green (recorded 2026-09-09)

Acceptance for [#835](https://github.com/gmcclelland90/playon/issues/835): routines exist **and** each standing canary has a green scheduled run on lab fixtures.

| Canary | First green | Evidence |
|--------|-------------|---------|
| Soak morning | Scheduled `playon-polish-canary` GREEN | Cursor workflow history (weekdays 08:54 Sydney). Fixture / `lab-*` only. |
| Managed-install | Scheduled `playon-polish-canary` GREEN | Same ledger (weekdays 10:54 Sydney). No NZL / friend target. |
| Home OTA + nodes | Scheduled `playon-polish-canary` GREEN | Same ledger (weekdays 11:54 Sydney). Lab nodes only. |
| Site / catalog | Scheduled GREEN + 2026-09-09 recheck | `https://playon.games/home/latest.json` → Home **0.2.13** (`updatedAt` 2026-08-28T16:18Z). `https://playon.games/packages/index.json` → `200` JSON (`updatedAt` 2026-08-28T16:18Z). Site recovered after [#947](https://github.com/gmcclelland90/playon/issues/947) DNS parking (closed 2026-09-08). |
| WSL Phase 2 | Scheduled `playon-polish-canary` GREEN | Same ledger (Mon/Thu 14:54 Sydney) on `playon-win-1`. Manual LAN-client join remains [wsl-phase2-smoke-checklist.md](wsl-phase2-smoke-checklist.md). |

Re-record later greens from the Cursor `playon-polish-canary` run list — do not invent GitHub Actions history for these routines.

### Lab node currency after Home 0.2.13

Published artifacts (2026-08-28): Home + node **0.2.13** on `https://playon.games/home/latest.json` (linux-x64 + windows-x64 home/node). CHANGELOG 0.2.13 asks hosts to Update Home, then **Settings → Nodes** so agents pick up the OTA keep-alive fix before the next hop.

| Host | Expectation |
|------|-------------|
| `playon-dev` Local | Lab Home / local agent — keep current enough for 0.2.13 (OTA keep-alive, join-path publish). |
| `playon-win-1` | Lab Windows worker — OTA+nodes canary may bump this host. |
| Friend zomboid / NewZombieLand3 / other friend-hosting nodes | **May lag. Do not bump.** OTA+nodes canary skips these unless Glenn approves a window. |

Do not treat a lagging friend host as a canary failure and do not cut a release from this checklist.

## Deferred funnels

Discord and in-app “Report a problem” should only **create Issues** (same templates/labels, plus `source:discord` / `source:host`). Reuse automation 1 for triage — do not add a second backlog.

