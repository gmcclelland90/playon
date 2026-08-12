# PlayOn testing plan

Living contract for what must be green, when, and how coverage grows. Agents extend this after releases and `P0`/`P1` incidents.

Companion docs: [agent-dev-loop.md](agent-dev-loop.md), [lab-matrix.md](lab-matrix.md), [sdlc.md](sdlc.md).

## Tiers

| Tier | Command | Gate | Cadence |
|------|---------|------|---------|
| Fast | `pnpm verify` | Every PR; GitHub Actions CI | Continuous |
| Merge | `pnpm loop:verify` | Before merge when touching API / agent / runtime; always before release | Linux lab + [nightly-docker](../.github/workflows/nightly-docker.yml) |
| Runtime | `pnpm loop:verify:runtime` | Docker lifecycle / Paper path changes | Lab + nightly |
| Catalog | `pnpm lab:matrix` | Skill / catalog changes; standing lab cadence | Lab timer ([infra/lab](../infra/lab/README.md)) |
| Join-path canary | `pnpm lab:join-path-canary` | Published `joinHost:gamePort` from `resolveJoinAddress` (not loopback) | Unit in `pnpm verify`; live Docker / WSL / Win PE lab-only ([#843](https://github.com/gmcclelland90/playon/issues/843), polish canary) |
| UI smoke | `pnpm test:e2e` | Auth / panel / UI flows | Weekly Actions (`e2e-weekly.yml`) |

CI ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) runs the **fast** bar plus packaging and image smoke on ubuntu + windows. Full merge bar stays on the lab host (real Venice + Docker) — see [linux-dev-host.md](linux-dev-host.md).

## Layer ownership

| Layer | Primary packages | Risk covered |
|-------|------------------|--------------|
| check | all | Type errors across the monorepo |
| unit | api, web, node-agent, shared, agent-core, runtime, server-query | Pure logic, adapters with fakes only where already established |
| contract | shared | Zod / protocol envelopes |
| int | api | SQLite, HTTP routes, Docker/RCON/SteamCMD honesty on lab |
| agent | agent-core | Live Venice tool loop |
| smoke:paper-docker | scripts + runtime | Paper create → start → port |
| lab:matrix | skills + playon-games catalog | Per-skill E2E install/start/port |
| lab:join-path-canary | api + shared | Probe `resolveJoinAddress` / `nodes.join_host`, not `127.0.0.1` |
| e2e | web + api | Browser smoke (setup → login → panel) |

## Definition of done (by change type)

| Change | Minimum bar |
|--------|-------------|
| Docs / labels / templates only | `pnpm check` (or no code) + review |
| Shared schema / contract | Fast bar (`pnpm verify`) |
| API / agent-core / runtime logic | Merge bar on lab |
| Docker lifecycle / Paper path | Runtime bar |
| Catalog `games.*` skill | Merge bar + `pnpm lab:matrix --skill <id>` |
| Admin / player UI flow | Fast bar; add or update e2e when touching auth/panel critical path |
| Release `v*` | Merge bar green, CHANGELOG section, no open `P0`; open `P1` empty or explicitly deferred |

Always: link the issue (`Fixes #N`), keep secrets out of logs/fixtures, isolated temp `PLAYON_DATA_ROOT` where applicable.

## Status artifacts

| File | Role |
|------|------|
| `tmp/agent-loop-status.json` | Last merge/fast/runtime bar result + failed layer tail |
| `tmp/lab-matrix-status.json` | Matrix resume cursor + per-skill phases |
| `tmp/lab-matrix-issues.jsonl` | Matrix failures for triage / fix agents |
| `tmp/lab-filed-issues.json` | Ledger of fingerprints already filed to GitHub |

Protocol: if `agent-loop-status.json` has `ok=false`, fix that layer before new feature work ([agent-dev-loop.md](agent-dev-loop.md)).

## Lab → GitHub loop

On failure, `scripts/lab-file-github-issues.mjs` opens or updates Issues labeled `needs-triage` + `source:lab` (deduped by fingerprint: **one matrix issue per skill**; phase transitions comment on that issue). PlayOn Ops auto-adds them; the triage automation classifies to `ready` / `blocked-human`.

| Source | When filed |
|--------|------------|
| `pnpm loop:verify` / `:runtime` | After red bar (lab host; nightly Actions on failure) |
| `pnpm lab:matrix` | After run with failures |
| Lab cadence timer | Daily on playon-dev — verify then matrix ([infra/lab](../infra/lab/README.md)) |
| Weekly e2e | `e2e-weekly.yml` on failure |

Disable: `PLAYON_LAB_FILE_ISSUES=0`. Manual: `pnpm lab:file-issues`. Matrix clones from the old phase-keyed fingerprint: `pnpm lab:file-issues --close-clones` (dry-run) then `--close-clones --apply`.

## Flake policy

- Never silently skip a failing assertion
- Quarantine only with an open issue labeled `chore` + `test-debt` describing reproduction and owner
- Retries in CI/lab runners are for infrastructure blips, not hiding product bugs

## Evolution rule

Every closed `P0` or `P1` **bug** must either:

1. Add or extend a regression test at the lowest tier that would have caught it, or
2. Open/update a `test-debt` issue explaining why not (cost, missing harness, flaky env) with a target tier

After each release, skim CHANGELOG **Fixed** entries and file `test-debt` for gaps.

## Known gaps

- Windows PE / Steam dual-place coverage still depends on `playon-win-1` online ([#46](https://github.com/gmcclelland90/playon/issues/46))
- Join-path live TCP on WSL sibling and Windows PE is lab-only (unit covers `resolveJoinAddress`; [lab-matrix.md](lab-matrix.md), [#843](https://github.com/gmcclelland90/playon/issues/843))
- Weekly e2e is scheduled but not yet in every-PR CI ([#44](https://github.com/gmcclelland90/playon/issues/44))
- Lab cadence timer must be installed once on playon-dev ([infra/lab](../infra/lab/README.md), [#45](https://github.com/gmcclelland90/playon/issues/45))

## Human gates for testing

- Venice spend beyond routine lab verify → `blocked-human`
- Destructive cleanup of durable Home inventory → never; matrix uses temp roots only ([lab-matrix.md](lab-matrix.md))
