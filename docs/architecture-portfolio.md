# Architecture portfolio plan

Frozen after the multi-model architecture review + portfolio sequencing grill (2026-08-08).

Vocabulary: `module`, `interface`, `depth`, `seam`, `adapter`, `leverage`, `locality` (see codebase-design skill). Domain names from `CONTEXT.md`.

## Goal

Implement all kept deepenings from the joint review (J1–J8). Lab gate between slices: `pnpm loop:verify` on the Linux lab host.

## Dropped (do not re-propose as standalone goals)

- Extract TriggerMatcher from WatcherEngine
- Extract route controllers for file size alone
- Broad “extract durable web workflows” (superseded by AgentTurn)

## Waves

| Wave | Work | Parallel |
|------|------|----------|
| **W1** | **J2** Typed node command protocol | **W1b:** **J5** Tool Surface |
| **W2** | **J1** Server Runtime Handle | — |
| **W3** | **J3** Server File Store | — |
| **W4** | **J7** Server adoption | **W4b∥W4c:** **J4** Transport ∥ **J6** Control Plane lifecycle |
| **W5** | **J8** AgentTurn | — |

### Sequencing rules

- **W1 before any Handle design.** Protocol fully lands and stabilizes before W2 design/implementation.
- **W1b** is the only parallel architecture track during W1.
- **W4b/W4c** may start when W1 has been promoted to `main` (overlap W2). They must not edit Handle / File Store / node-agent job-body zones (`servers.ts` lifecycle, fs jail paths, `apps/node-agent/src/jobs.ts` kind implementations).
- **Spine after protocol:** Handle → File Store → Adoption.
- **AgentTurn last**, after Transport and Control Plane lifecycle.

### Slice grain

Vertical thin slices (e.g. one job-kind family: shared schemas + dispatch + node-agent + one caller). Temporary compatibility shim for unmigrated kinds during W1; delete shim at end of W1.

### Shared package zoning

Prefer new modules under `packages/shared` (e.g. node job contracts) over growing a mega-`api.ts`, so Transport can land response contracts without merge wars.

## Exclusive file zones

| Zone | Owners (typical paths) |
|------|------------------------|
| Node seam (W1) | Job contracts in shared, `node-jobs*`, `node-runtime*`, `apps/node-agent/src/jobs.ts` (+ tests) |
| Runtime Handle (W2) | `servers.ts`, `health.ts`, `server-console.ts`, `native-launch*`, runtime factory touchpoints |
| Tool Surface (W1b) | `tools.ts`, `packages/agent-core` tool-surface*, `mcp.ts` |
| Transport (W4b) | Route policy in `app.ts`, `apps/web/src/api.ts`, shared request/response contracts |
| Adoption (W4) | `import-*`, `manage-suggest*`, skill-marker write paths in create/import |

Two agents must not share a zone in the same wave.

## Git / agent workflow

- Feature branches: `arch/w1-protocol`, `arch/w1-tool-surface`, `arch/w2-runtime-handle`, …
- Worktrees: e.g. `../playon-arch-w1-protocol` matching branch names
- Per-wave integration: `arch/w1-integration`, `arch/w2-integration`, …
- Agents open PRs into the wave integration branch
- Facilitator serializes promotion to `main` after lab `pnpm loop:verify` is green
- If W1b finishes before protocol, it waits on `arch/w1-integration` until promote order is decided

## Candidate index (joint report)

| ID | Title |
|----|--------|
| J1 | Server Runtime Handle (four adapters) |
| J2 | Typed node command protocol |
| J3 | Server File Store |
| J4 | HTTP transport — policy, errors, shared contracts |
| J5 | Colocate Tool Surface; kill process-global install |
| J6 | Control Plane lifecycle |
| J7 | Unify Server adoption workflows |
| J8 | AgentTurn on the Control Plane |

## W1 design lock (typed node command protocol)

Frozen in W1 deep-grill:

- **Layout:** `packages/shared/src/node-jobs/{meta,fs,container,process,steamcmd,manage}.ts` + barrel/registry map (`{ kind, argsSchema, resultSchema }[]`)
- **Caller interface:** typed `dispatchNodeJob` (kind → args/result inferred); thin wrappers only for hottest fs/sync call sites after `fs_*` migrates
- **Validation:** both shores — CP before enqueue + after wait; agent on receive + before result POST; local `localHandler` results also `parseResult`
- **Errors:** typed stable codes (`unsupported_job_kind`, `timeout`, `validation_failed`, kind-specific)
- **Skew:** heartbeat advertises `jobKinds`; refuse enqueue when missing; typed unsupported fallback on race; after `node_self_update`, force heartbeat refresh before further jobs
- **Shim:** same `dispatchNodeJob` entry; unregistered kinds use legacy bag/`as T`; delete only when all 28 kinds contracted and call sites use inferred dispatch (lab green)
- **Slice order:** meta (`ping`, `runtime_caps`, `node_self_update`) → `fs_*` (read/list → write/ensure → mutate → archives) → container → process → steamcmd → manage fold-in from `import-probe.ts` → shim delete
- **Tests:** registry completeness + CP dispatch mocks + agent family tests + fixture round-trip for migrated kinds; lab `loop:verify` per slice

## W1b design lock (Tool Surface)

Frozen in W1b deep-grill:

- **Entry:** `ToolEntry = { def, surface (skill/confirm/activityVerb/xp), handler, workspacePolicy? }`
- **Layout:** `apps/api/src/services/tools/{domain}.ts` modules composed by thin `createPlayOnToolRegistry`
- **Factory interface:** returns `{ registry, surface }` — no `installToolSurface` process global; overlay import side-effect removed
- **Consumers:** Orchestrator, MCP, watchers all use the factory return value
- **agent-core:** keep merge/projection helpers only; `projectConfirm` / activity / XP take explicit `surface` and/or turn context (no ambient getter)
- **Overlay:** delete `TOOL_SURFACE_OVERLAY` as a separate table; metadata lives on each entry
- **Workspace policy:** enforced in invoke path from `ToolEntry.workspacePolicy` before handler runs
- **Slices:** vertical domains with shim — prove on `fs` + small meta → servers/lifecycle → skills/panel → remainder → delete shim/overlay/global
- **Parity tests:** structural completeness (every entry complete; names === surface keys; no global writes); factory smoke shared by chat/MCP
- **Done when:** all ~59 tools are entries; overlay + global gone; lab `loop:verify` green
- **Zone:** must not own `apps/node-agent/src/jobs.ts` or node-job contract files (may call `dispatchNodeJob`)

## W2 design lock (Server Runtime Handle)

Frozen in W2 deep-grill (after W1 on `main`):

- **Surface:** `ServerRuntimeHandle` — start / stop / restart / status / logs / stdin (console). Health may keep trusting DB `status` for this wave.
- **Factoring:** two mode adapters (docker | native) each taking a locality transport (local in-process | remote `dispatchNodeJob`) — four concrete combinations, not four unrelated classes.
- **Home:** `packages/runtime` next to `DockerAdapter` / `ProcessSupervisor`; those stay as internals of the mode half (node-agent job bodies keep using them).
- **Identity:** always re-resolve on the node (name/cwd or container name); drop durable CP in-memory process maps as call sites migrate.
- **Obtain:** pure `openServerRuntime(server, deps)` factory + `servers.runtime(serverId)` as the only production choke point.
- **Stop:** dual-fire process+container during migration; end state is mode-correct stop only.
- **Slices:** local docker start/stop/status (landed) → remote docker → local native → remote native → logs → stdin/console → delete duplicated `startRemote` / local branches.
- **Done when:** all four quadrants + logs + stdin through Handle; `startRemote` duplication gone; lab `loop:verify` green. Health.ts DB status OK to leave.
- **Tests:** unit with fake locality + mode stubs; int Paper docker path uses Handle; mocked remote-native unit — no full 4× int matrix.
- **Git:** `arch/w2-integration` + worktree `playon-arch-w2-runtime-handle`; PRs into integration; promote to `main` after lab green.
- **Parallel:** grill J4∥J6 (W4b/W4c) after this lock; implement them only after W2’s first prove slice is on `main`. Stay off Handle / File Store / node-agent job-body zones.
- **Zone:** `servers.ts`, `health.ts`, `server-console.ts`, `native-launch*`, runtime factory touchpoints — not Tool Surface or new node-job contracts.

## W4b design lock (HTTP Transport)

Frozen in W4b deep-grill (implement after W2 local-docker prove is on `main`):

- **Owns:** shared error envelope + `onError` middleware + route policy helpers (`requireSession`, `requireCan` / equivalent); web `api.ts` `request()` parses the envelope
- **Envelope:** `{ error: string, code?: string, details?: unknown }` — stable `code` for machine clients; human text in `error`
- **Contracts home:** new `packages/shared/src/http/` — do not grow mega-`api.ts`
- **Slices:** `http/errors` + `onError` → helpers on session + servers list/detail + one mutating server route → migrate remaining routes → web `request()`
- **Zone:** `app.ts` route wiring, new `http-policy.ts` (name flexible), `packages/shared/src/http/*`, `apps/web/src/api.ts` choke point — not `servers.ts` lifecycle / fs jail / node-agent job bodies
- **Git:** worktree `arch/w4-transport` → PRs into shared `arch/w4-integration`

## W4c design lock (Control Plane lifecycle)

Frozen in W4c deep-grill (implement after W2 local-docker prove is on `main`):

- **Interface:** `startControlPlane` / `stopControlPlane` — listen, scheduler start/stop, graceful SIGTERM
- **Stop must cover:** HTTP server close + Snapshot/LiveQuery/Watcher schedulers + in-flight `waitFor` job waiters (best-effort) + node WebSocket drain with a short grace period
- **Home:** new `apps/api/src/control-plane-lifecycle.ts` (or similar); thin `index.ts` calls it. `ControlPlane` stays the service graph.
- **Clash rule:** may construct/wire `ServerService` via `control-plane.ts`; must not edit lifecycle methods inside `servers.ts` (Handle zone)
- **Tests:** unit start/stop ordering with fake listen + fake schedulers; lab `loop:verify` green
- **Zone:** `index.ts` + lifecycle module only for process shell — no route edits in `app.ts`
- **Git:** worktree `arch/w4-cp-lifecycle` → PRs into shared `arch/w4-integration`

## W4 shared process

- Shared integration branch `arch/w4-integration`; facilitator serializes merges
- Freeze briefs / open worktrees after lock confirm; **first code PR only after W2 local-docker prove is on `main`**
- File split: W4b ↔ routes/policy/http; W4c ↔ process shell — no shared `app.ts` edits from W4c

## Process after this doc

1. Confirm W4b/W4c locks → keep W2 prove landing on `arch/w2-integration` → `main`
2. After W2 prove on `main`: spawn W4b∥W4c implementation on `arch/w4-integration`
3. Continue W2 remaining Handle slices (remote docker → natives → logs → console)
4. Re-open portfolio ranking only if a wave invalidates a later candidate
