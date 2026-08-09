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
| Goal | Pick highest-priority `ready` under WIP limit (max 3 `in-progress`), implement, verify per `docs/testing-plan.md`, open PR with `Fixes #N` |
| Instructions | Obey fire-first rule in `docs/sdlc.md`. Keep cockpit updates per `docs/observability.md` (progress comments, Project Status → `In progress` / `Done`). Stop and set `blocked-human` + `@gmcclelland90` on human gates. Lab verify on Linux host when merge bar required. |
| Tools | GitHub + repo checkout; PlayOn Ops project; lab access as configured |

## Deferred funnels

Discord and in-app “Report a problem” should only **create Issues** (same templates/labels, plus `source:discord` / `source:host`). Reuse automation 1 for triage — do not add a second backlog.
