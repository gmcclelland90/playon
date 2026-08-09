# Observability cockpit

How Glenn (and agents) see the SDLC loop **as it runs**. Companion: [sdlc.md](sdlc.md), [issue-triage.md](issue-triage.md), [automations.md](automations.md).

## Always-open tabs

1. **[PlayOn Ops](https://github.com/users/gmcclelland90/projects/1)** — work queue (Fire / Needs you / Ready / …)
2. **Lab now** — [#52](https://github.com/gmcclelland90/playon/issues/52) (`lab-status`) short live card  
3. **Lab detail** — Actions job summary + `lab-report` HTML artifact (nightly / e2e); cadence ticks also leave a history comment on #52

**PlayOn Ops** project (linked to `gmcclelland90/playon`) is the mission-control board.

| Column / Status | Maps from issue labels | Meaning |
|-----------------|------------------------|---------|
| Fire | `P0` | Drop everything |
| Needs you | `blocked-human` | Decision comment waiting |
| Ready | `ready` | Agent may start |
| In progress | `in-progress` | Active work |
| Done | closed | Shipped / resolved |

Board URL (after create/link): see [Project link](#project-link) below.

Agents **must** keep Issues honest so the board stays live:

- On pick-up: `ready` → `in-progress` (and Project status if set)
- On human gate: → `blocked-human` + one-screen decision comment ([issue-triage.md](issue-triage.md))
- On PR: link `Fixes #N`; comment the PR URL on the issue
- On merge/close: close the issue; leave a short “verify bar used” note when non-obvious

## Live surfaces (as it happens)

| Surface | When to watch | URL / command |
|---------|---------------|---------------|
| **PlayOn Ops** Project | Always / weeknight scan | GitHub Projects → PlayOn Ops |
| **Issue** comments + labels | While an agent triages or executes | Issue thread |
| **PR** + Checks | While CI runs | PR “Checks” tab |
| **Actions** | Nightly / release | https://github.com/gmcclelland90/playon/actions |
| **Cursor** agent / Automation run | That session’s tool stream | Cursor UI |
| **Lab now (#52)** | Short live verify/matrix card | [`lab-status` issue](https://github.com/gmcclelland90/playon/issues/52) |
| **Lab report** | Full skill table + HTML | Actions Summary / artifact `lab-report-*`; cadence comments on #52 |
| **Lab → Issues** | After red verify/matrix/e2e | New/updated Issues with `source:lab` (auto-add to PlayOn Ops) |
| **Lab cadence timer** | Daily tick on playon-dev | `systemctl list-timers playon-lab-cadence.timer` |
| **Lab status JSON** | Agent/local debug on lab host | `tmp/agent-loop-status.json`, `tmp/lab-matrix-status.json` |

Generate locally: `pnpm lab:report` → `tmp/lab-report.html`.

## Weeknight scan (~2 minutes)

1. Project: any cards in **Fire** or **Needs you**?
2. Saved searches (bookmark these):

```text
https://github.com/gmcclelland90/playon/issues?q=is%3Aopen+label%3AP0
https://github.com/gmcclelland90/playon/issues?q=is%3Aopen+label%3Ablocked-human
https://github.com/gmcclelland90/playon/issues?q=is%3Aopen+label%3Aready
https://github.com/gmcclelland90/playon/pulls
```

3. Actions → latest **nightly-docker** (and **ci** on `main` if anything merged today)
4. If matrix is running: open the lab dash

If Fire/Needs you are empty and nightly is green → kick at most one `ready` item and stop.

## Notifications (interrupt only)

Goal: noise-free, but **never miss fire**.

### GitHub (recommended now)

1. GitHub → Settings → Notifications → **Watching**
2. For `gmcclelland90/playon`: use **Custom** (or Participating + watch selectively)
3. Ensure you get notified for:
   - **Issues** — at least when you’re **@mentioned** (agents must `@gmcclelland90` on every `blocked-human` decision comment)
   - **CI** — failed workflows on default branch (Actions → workflow → ⋯ → “Subscribe” / account notification prefs for Actions)
4. Mobile GitHub app: enable for Participating + Mentions

**Agent rule:** every `blocked-human` and every new `P0` comment starts with `@gmcclelland90` so it pages you without watching the whole repo.

### Later (Discord)

When Discord exists: webhook or bot only for `P0` and `blocked-human` — not every triage comment. Same Issue remains system of record ([sdlc.md](sdlc.md) deferred intake).

## Agent reporting contract

So you can “see it happening” without joining every session:

| Event | Issue update |
|-------|----------------|
| Triage complete | Labels set; short plan comment (acceptance + verify bar) |
| Started work | `in-progress` + first progress comment |
| Verify running | Comment: which bar (`verify` / `loop:verify` / matrix skill) and where (CI / lab) |
| Verify red | Comment failed layer + link/tail; stay `in-progress` or `blocked-human` if stuck |
| PR opened | Comment PR URL; keep issue open until merge |
| Needs decision | `blocked-human` + `@gmcclelland90` one-screen options |
| Done | Close with `Fixes` / comment verify bar used |

Do **not** dump huge logs into Issues — paste the failed layer tail or a gist link; keep secrets out.

## CI / CD visibility

| Pipeline | Where | “On fire” if |
|----------|--------|----------------|
| PR / `main` CI | Actions → **ci** | Red on `main` |
| Nightly merge+runtime | Actions → **nightly-docker** | Red with no owner issue |
| Release / OTA | Actions → **release-home** + `https://playon.games/home/latest.json` | Tag job failed or manifest wrong version |

Release checklist: [release.md](release.md).

## Project link

After `gh project` setup:

- Owner: `@gmcclelland90` (user project) or org if moved later
- Title: **PlayOn Ops**
- Linked repo: `gmcclelland90/playon`
- Seed: open `P0` / `blocked-human` / `ready` / `in-progress` issues + the three `test-debt` bootstrap issues

Live board: **[PlayOn Ops](https://github.com/users/gmcclelland90/projects/1)**

New issues are auto-added by [`.github/workflows/issue-to-project.yml`](../.github/workflows/issue-to-project.yml) when the `PROJECT_TOKEN` repo secret is set (PAT with `project` + `repo`). You can also enable the Project UI ⋯ → Workflows → **Auto-add** as a backup. Agents still set **Status** to match labels (`Fire` / `Needs you` / `Ready` / `In progress` / `Done`).
