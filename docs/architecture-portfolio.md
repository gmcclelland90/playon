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
| Runtime Handle (W2) | `servers.ts` lifecycle/runtime, `health.ts`, `server-console.ts`, `native-launch*`, runtime factory touchpoints |
| File Store (W3) | `server-file-store*`, `fs-tools*` (during rename), server `/fs` routes in `app.ts`, `tools/fs.ts`, FS helper extractions from `servers.ts`, fetch/archive path wiring |
| Tool Surface (W1b) | `tools.ts`, `packages/agent-core` tool-surface*, `mcp.ts` |
| Transport (W4b) | Route policy in `app.ts`, `apps/web/src/api.ts`, shared request/response contracts |
| Adoption (W4) | `server-adoption*`, `import-local*`, `import-sftp*`, `manage-suggest*`, skill-marker **write** paths used by adopt/create/import |
| AgentTurn (W5) | `agent-turn*`, thin wire-up in `app.ts` chat route, `watcher-actions.ts`, `control-plane.ts` |

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
- **Slices:** local docker start/stop/status (landed) → remote docker start/stop/restart/status (landed; `startRemote` docker duplication deleted) → local native start/stop/restart/status (landed; CP process map is remote-native only, `nativeProcessAlive` / `killNativeGameProcesses` deleted) → remote native start/stop/restart/status (landed; `startRemoteNative` and the last CP process map deleted, `process_status` re-resolves by name + cwd, remote stop is mode-correct) → logs (landed; `detail` / `tailLogs` tail through the handle in all four quadrants, the native console file is part of the process identity) → stdin/console (landed; `consoleCapability` and console writes go through the handle in all four quadrants, the local native supervisor keeps a real stdin pipe, remote native reports an unsupported console instead of a silent no-op).
- **Done when:** all four quadrants + logs + stdin through Handle; `startRemote` duplication gone; lab `loop:verify` green. Health.ts DB status OK to leave.
- **Tests:** unit with fake locality + mode stubs; int Paper docker path uses Handle; mocked remote-native unit — no full 4× int matrix.
- **Git:** `arch/w2-integration` + worktree `playon-arch-w2-runtime-handle`; PRs into integration; promote to `main` after lab green.
- **Parallel:** grill J4∥J6 (W4b/W4c) after this lock; implement them only after W2’s first prove slice is on `main`. Stay off Handle / File Store / node-agent job-body zones.
- **Zone:** `servers.ts`, `health.ts`, `server-console.ts`, `native-launch*`, runtime factory touchpoints — not Tool Surface or new node-job contracts.

## W3 design lock (Server File Store)

Frozen in W3 deep-grill (after W2 Handle + W4b/W4c on `main`):

- **Job:** Deep module for a **game server data dir** only — jail + I/O + locality. Out: `skill-fs`, node-global `node_fs_list`, snapshot/import/manage engines as owners.
- **Surface:** `list`, `readText`, `writeText`, `writeBytes`, `delete`, `rename`, `copy`, `ensureDir`. Archives/fetch **call** the store for path ops; do not absorb snapshot/import engines. (`writeBytes` is required so fetch/archive stay binary-safe on both localities.)
- **Home:** CP module under `apps/api` (`server-file-store*`, deepened from `ServerFsService`). Reuse `packages/runtime` `resolveInJail` + W1 `fs_*` contracts; **do not** edit node-agent job bodies or `packages/shared/src/node-jobs/fs.ts`.
- **Locality:** Two adapters — Home local disk vs `dispatchNodeJob`. Default routing uses node-authoritative marker rules (same as today’s `ServerFsService`). `ensureDir` on a remote `nodeId` always hits the node (provisioning before the marker exists). Callers that must sync a Home file onto a remote node pass `locality: "remote"`.
- **Obtain:** `openServerFileStore(server, deps)` + **`servers.files(serverId)`** as the only production choke (re-resolve server row / locality each call). Migrate off direct `plane.serverFs`.
- **Errors:** Typed store codes (`path_escape`, `not_found`, `is_directory`, `not_directory`, `already_exists`, `io_failed`, `node_unreachable`); map `PathJailError`; HTTP via envelope helpers.
- **HTTP:** W3 owns `/api/servers/:id/fs*` end-to-end (policy + envelope + store). Skill `/fs` untouched.
- **Node-aware:** Tool/HTTP CRUD + ensureDir + `fetch_url` / `archive_extract` go through the store. **Snapshots stay Home `cp` for W3.**
- **`servers.ts`:** Delete parallel `readNodeText` / `writeNodeText` / `listNodeDir` / private `nodeJailRel` / remote ensureDir duplication; RCON/config helpers become thin store callers. Lifecycle start/stop/logs/stdin stay Handle.
- **Slices:** lock + factory/`servers.files` + typed errors → ensureDir + kill `servers.ts` FS dupes → server FS HTTP envelope → tools + fetch/archive through store → cleanup/lab/promote.
- **Done when:** No parallel jail remapping; tools + server FS HTTP + former `servers.ts` FS helpers + fetch/archive path ops all through the store; skill FS / snapshots / import ownership unchanged; lab `loop:verify` green.
- **Git:** worktree `arch/w3-file-store` → PRs into `arch/w3-integration` → lab → promote to `main`.
- **Zone:** see File Store row in exclusive zones table. Out: skill-fs, node-job contracts/bodies, Handle lifecycle, snapshots/import/manage owners, `node-sync` as archive bulk owner.

## W4b design lock (HTTP Transport)

Frozen in W4b deep-grill (implement after W2 local-docker prove is on `main`):

- **Owns:** shared error envelope + `onError` middleware + route policy helpers (`requireSession`, `requireCan` / equivalent); web `api.ts` `request()` parses the envelope
- **Envelope:** `{ error: string, code?: string, details?: unknown }` — stable `code` for machine clients; human text in `error`
- **Contracts home:** new `packages/shared/src/http/` — do not grow mega-`api.ts`
- **Slices:** `http/errors` + `onError` → helpers on session + servers list/detail + one mutating server route → migrate remaining routes → web `request()`
- **Zone:** `app.ts` route wiring, new `http-policy.ts` (name flexible), `packages/shared/src/http/*`, `apps/web/src/api.ts` choke point — not `servers.ts` lifecycle / fs jail / node-agent job bodies
- **Git:** worktree `arch/w4-transport` → PRs into shared `arch/w4-integration`
- **Leftovers (landed):** `/mcp` + node-token protocol routes (heartbeat, logs, metrics, jobs/next, job result) and session-gated node job enqueue/status use the shared envelope + `requireNodeToken` / `requireCan` / `jsonBody`

## W4c design lock (Control Plane lifecycle)

Frozen in W4c deep-grill (implement after W2 local-docker prove is on `main`):

- **Interface:** `startControlPlane` / `stopControlPlane` — listen, scheduler start/stop, graceful SIGTERM
- **Stop must cover:** HTTP server close + Snapshot/LiveQuery/Watcher schedulers + in-flight `waitFor` job waiters (best-effort) + node WebSocket drain with a short grace period
- **Home:** new `apps/api/src/control-plane-lifecycle.ts` (or similar); thin `index.ts` calls it. `ControlPlane` stays the service graph.
- **Clash rule:** may construct/wire `ServerService` via `control-plane.ts`; must not edit lifecycle methods inside `servers.ts` (Handle zone)
- **Tests:** unit start/stop ordering with fake listen + fake schedulers; lab `loop:verify` green
- **Zone:** `index.ts` + lifecycle module only for process shell — no route edits in `app.ts`
- **Git:** worktree `arch/w4-cp-lifecycle` → PRs into shared `arch/w4-integration`

## W4 design lock (Server adoption)

Frozen after W3 File Store on `main`:

- **Job:** Deep shared pipeline for adopting a server onto PlayOn (create-from-skill, import-local, import-sftp, manage cutover). Owns tree materialization + skill marker + baseline snapshot orchestration. Does **not** own lifecycle (Handle) or raw path jail (File Store).
- **Surface:** `ServerAdoptionService` (name flexible) with shared steps used by all entry points:
  1. resolve skill + node + runtimeMode
  2. allocate server id + Home `dataPath`
  3. `servers.files(...).ensureDir("game")` (and any other dirs needed)
  4. stage/copy game content into the jail (local `fs.cp` only for bulk import of an external tree into Home jail is OK when source is outside the server dir; once inside the server jail, use File Store)
  5. write skill marker via existing `writeSkillMarkerFromSkill` / marker helpers
  6. optional node-authoritative marker + push/sync when manage cutover requires it (keep using `node-sync` / existing manage jobs — do not re-own archive bulk)
  7. baseline snapshot (call SnapshotService — do not rewrite snapshot engine)
  8. insert DB server row (coordinate with ServerService — prefer extracting shared helpers rather than duplicating createFromSkill)
- **Home:** new `apps/api/src/services/server-adoption.ts` (+ tests). Thin `import-local.ts` / `import-sftp.ts` / `manage-suggest.ts` become callers. `servers.createFromSkill` / reinstall should call the same pipeline for marker+dirs (lifecycle stays in servers.ts).
- **Obtain:** constructed on ControlPlane; entry points stay HTTP/tools but all go through adoption service.
- **Zone:** `server-adoption*`, `import-local*`, `import-sftp*`, `manage-suggest*`, skill-marker **write** paths used by adopt/create/import. May **call** `servers.files`, `servers.createFromSkill` internals via extracted helpers, SnapshotService. Must **not** edit Handle lifecycle methods, File Store internals, node-agent `jobs.ts`, or W1 contracts.
- **Slices (land in one PR if coherent, or 2):** (1) lock doc + `ServerAdoptionService` + wire `createFromSkill`/reinstall dir+marker through it; (2) import-local + import-sftp + manage-suggest call the pipeline; delete duplicated mkdir/marker sequences.
- **Done when:** create/import/manage no longer each reinvent ensureDir+marker+baseline; File Store used for server-jail ensures; lab-ready unit tests; `pnpm check` + `pnpm test:unit` + `pnpm test:contract` green in the worktree.
- **Git:** `arch/w4-adoption` → PR into `arch/w4-adoption-integration`

## W4 shared process

- Adoption integration branch: `arch/w4-adoption-integration` (PRs from `arch/w4-adoption`)
- Transport / CP-lifecycle historically shared `arch/w4-integration`; facilitator serializes promotion to `main`
- Freeze briefs / open worktrees after lock confirm; **first code PR only after W2 local-docker prove is on `main`**
- File split: W4b ↔ routes/policy/http; W4c ↔ process shell — no shared `app.ts` edits from W4c

## W5 design lock (AgentTurn)

Frozen after W4 Adoption on `main`:

- **Surface:** `AgentTurn.run(input) → AgentTurnResult` — conversation bind/load/persist, LLM+orchestrator run, activity stream, confirm wiring, tool audit, XP/celebrations, abort. Out: MCP single-tool invoke, tool handlers, LLM client internals, ConfirmService/EventHub implementations.
- **Home:** `apps/api/src/services/agent-turn.ts` (+ tests). Orchestrator stays in `packages/agent-core`.
- **Obtain:** `plane.agentTurn.run(...)` is the only production choke for Canvas chat + watcher `kind: "agent"`. `/api/chat` and watcher agent path become thin callers.
- **Zone:** `agent-turn*`, thin wire-up in `app.ts` chat route, `watcher-actions.ts`, `control-plane.ts`. Out: tool domain modules, MCP body, Handle/File Store, node-agent, orchestrator redesign.
- **Slices:** (1) extract chat shell from `app.ts` into `AgentTurn` + wire `plane.agentTurn` (2) fold watcher agent onto same `run` (3) delete duplicated activity/persist loops (4) unit tests prove chat+watcher share the runner.
- **Done when:** chat + watcher agent both use one CP turn runner; `/api/chat` has no inline orch/activity/XP loop; MCP still registry-only; check/unit/contract green.
- **Git:** `arch/w5-agent-turn` → PRs into `arch/w5-integration`

## Process after this doc

1. Confirm W4b/W4c locks → keep W2 prove landing on `arch/w2-integration` → `main`
2. After W2 prove on `main`: spawn W4b∥W4c implementation on `arch/w4-integration`
3. Continue W2 remaining Handle slices (remote docker → natives → logs → console)
4. After W3 File Store on `main`: implement W4 Adoption on `arch/w4-adoption-integration`
5. After W4 Adoption on `main`: implement W5 AgentTurn on `arch/w5-integration`
6. Re-open portfolio ranking only if a wave invalidates a later candidate
