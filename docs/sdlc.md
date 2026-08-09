# PlayOn software development lifecycle

Solo-founder operating loop: **GitHub Issues** are the backlog, **agents** do most of the work, **verify bars** are the quality gate, and **you** only unblock true human decisions.

Sibling site/catalog work follows the same model in [`playon-games`](https://github.com/gmcclelland90/playon-games) with a thinner label set; platform bugs discovered there get cross-linked or transferred here.

## Loop

```text
Issue opened → triage → ready | blocked-human
       ↓ ready
Agent implements → verify bars → PR (Fixes #N) → merge
       ↓
Release (human approves tag) → CHANGELOG / close issues → evolve testing plan
```

Details:

- Triage rules: [issue-triage.md](issue-triage.md)
- Test tiers and DoD: [testing-plan.md](testing-plan.md)
- Lab merge protocol: [agent-dev-loop.md](agent-dev-loop.md)
- Ship path: [release.md](release.md)
- Cursor Automations to wire: [automations.md](automations.md)
- Live cockpit / notifications: [observability.md](observability.md)

## Operating rule: keep moving, nothing on fire

Every session (human or agent), in order:

1. **Fire** — open `P0`, `main` CI red, nightly / lab `loop:verify` red, OTA/release broken → fix or escalate `blocked-human`; no new feature work
2. **Unstick** — `blocked-human`, stuck `in-progress`, PRs waiting on review/decision
3. **Move the queue** — next `ready` by priority (`P1` then `P2`)
4. **Improve the system** — `test-debt`, triage, docs — only when 1–3 are quiet

**On fire (always interrupt):** open `P0`; CI on `main` failing; nightly or lab merge bar red with no owner issue; `latest.json` / installer path failing.

**Weeknight health check (~2 min):** saved search `label:P0 OR label:blocked-human` + latest nightly/lab status. If clear, kick one `ready` agent and stop.

## Issue state machine

| Label | Meaning |
|-------|---------|
| `needs-triage` | New or reopened; not classified yet |
| `ready` | Acceptance criteria clear; agent may start |
| `in-progress` | Agent or human actively working |
| `blocked-human` | Needs a product/spend/brand/irreversible decision |
| *(closed)* | Done |

Also apply **type** (`bug` / `feature` / `chore` / `skill`), **area**, **priority** (`P0`–`P3`), and risk (`safe-auto` / `needs-human`). See [issue-triage.md](issue-triage.md).

## Human gates

Agents stop and set `blocked-human` for:

- Product scope / “should we build this?”
- Venice spend beyond routine lab verify
- UI brand / first-viewport quality
- Irreversible host cleanup / production data risk
- Cutting a release tag (`v*`) — agent prepares CHANGELOG + checklist; human approves tag push

## WIP limits

- Max **3** `in-progress` issues across agents
- Max **1** release prep at a time
- User-facing behavior or spend changes stay `needs-human` until approved

## Part-time cadence

- **Weeknight (≤90 min):** fire + unstick; at most one `ready` kick
- **Weekend:** clear leftovers, one improve-the-system slice, lab/matrix only if that slice needs it
- **Release:** prepare CHANGELOG when green; tag only when you can sanity-check OTA

## Deferred intake (same hub later)

Future Discord and in-app “Report a problem” flows must create GitHub Issues with the same labels/schema (`source:discord` / `source:host`). Do not invent a second backlog.

## Orchestration searches

Useful GitHub issue filters on `playon`:

```text
label:P0 is:open
label:blocked-human is:open
label:ready is:open
label:test-debt is:open
```

Full cockpit (Project board, lab dash, CI, notify rules): [observability.md](observability.md).
