# Issue triage playbook

Agents triage every new or `needs-triage` issue on `playon` (and the thinner model on `playon-games`). Goal: clear work becomes `ready` + `safe-auto`; anything needing Glenn becomes a one-screen `blocked-human` decision.

See [sdlc.md](sdlc.md) for the state machine and operating rule.

## Labels

**Type:** `bug` | `feature` | `chore` | `skill`  
**Area:** `api` | `web` | `node-agent` | `runtime` | `agent-core` | `skills` | `docs` | `release` | `lab`  
**Priority:** `P0` | `P1` | `P2` | `P3`  
**State:** `needs-triage` → `ready` → `in-progress` → `blocked-human` (or close)  
**Risk:** `safe-auto` | `needs-human`  
**Meta:** `test-debt` (coverage gap), `source:lab` / `source:discord` / `source:host` (when known)

## Priority guide

| Priority | Use when |
|----------|----------|
| `P0` | Breaks install, OTA, login, data loss, or merge/nightly bar with no workaround |
| `P1` | Major feature broken or skill/catalog failure affecting many hosts; workaround painful |
| `P2` | Real bug or feature with workaround; normal queue |
| `P3` | Nice-to-have, polish, speculative |

## Triage steps

1. Read title + body; ask for missing repro only if blocked without it (comment once, leave `needs-triage` if still empty).
2. Dedupe: search open issues for same symptom/skill; comment and close as duplicate if clear match.
3. Assign type, area, priority.
4. Decide risk:

### `safe-auto` → `ready`

Clear bug with repro, test gap, docs fix, skill install/start failure with logs, CI/lab red with actionable tail. Comment must include:

- Acceptance criteria (checklist)
- Required verify bar (fast / merge / runtime / matrix skill / e2e)
- Suspected package(s)

Then remove `needs-triage`, add `ready` + `safe-auto`.

### `needs-human` → `blocked-human`

Product scope, UX/brand judgment, new spend, irreversible host ops, ambiguous “should we?”, or conflicting requirements. Comment **one screen only**, and **@gmcclelland90** so notifications fire ([observability.md](observability.md)):

```markdown
@gmcclelland90
## Decision needed
**Context:** …
**Options:**
1. …
2. …
**Recommendation:** …
**If approved, next:** label ready + …
```

Remove `needs-triage`, add `blocked-human` + `needs-human`. Do not start implementation.

Same `@gmcclelland90` ping when applying or escalating **`P0`**.

## Lab / matrix failures

Align with [lab-matrix.md](lab-matrix.md) classification:

| Class | Issue handling |
|-------|----------------|
| `skill_bug` | `skill` + area `skills`; usually `safe-auto` |
| `platform_bug` | `bug` + area (`api` / `runtime` / …); usually `safe-auto` |
| `steamcmd_timeout` | `bug` + `runtime` + `P1`; SteamCMD exceeded timeout (not a skill P2) |
| `steamcmd_empty_depot` | `chore` + `runtime` + `P3`; publisher-empty depot (often already an allowed skip) |
| `steamcmd_no_subscription` | `chore` + `runtime` + `P3`; anonymous SteamCMD has no entitlement (often already an allowed skip) |
| `platform_unsupported` | `chore` or `skill`; often `needs-human` if product should document/skip |
| `allowed_skip` | No issue (or close as won't fix with reason) |
| `flake` | `chore` + `test-debt`; quarantine only with issue link |

Prefer structured body fields: skill id, failed phase, expected vs observed ports, link/tail from `tmp/lab-matrix-issues.jsonl`.

## playon-games cross-link

On the sibling repo, if the root cause is control-plane / runtime / node-agent:

1. Open or find the `playon` issue
2. Cross-link both ways
3. Keep site-only docs/catalog content bugs on `playon-games`

## After human reply

- **Approved** → remove `blocked-human` / `needs-human`, add `ready` + `safe-auto`, restates acceptance criteria
- **Rejected / defer** → close or leave `P3` with note; do not implement
- **Need more info** → stay `blocked-human` with the question

## Execution handoff

When an agent picks `ready`:

1. Set `in-progress`
2. Follow [agent-dev-loop.md](agent-dev-loop.md) and [testing-plan.md](testing-plan.md)
3. Open PR with `Fixes #N`
4. If a human gate appears mid-flight → `blocked-human` and stop
5. On merge/close → ensure labels clean; file `test-debt` if a `P0`/`P1` bug shipped without a regression test
