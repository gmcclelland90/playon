# 18 – Watchers

## Purpose

Watchers are persisted automations that **wake** the Monitor workflow without a host chat turn. They fire on a schedule or on platform/game hooks, then run either a deterministic tool script or a scoped agent prompt.

Chat and MCP stay pull-based. Watchers are the push layer.

## Model

A watcher is bound to a server and has:

1. **Trigger** — when to evaluate  
2. **Action** — `tools` (ordered allowlisted calls) or `agent` (Orchestrator turn)  
3. **Guards** — enabled, cooldown, debounce, concurrency limits  

Skill metadata may declare `watchers[]` templates. On `servers_create_from_skill` (HTTP or tool), templates are seeded with `source: skill_template`. Create-from-skill and managed servers also get an enabled platform **Health monitor** (`source: platform`) unless a health+restart watcher already exists: advertised host-local game ports fail → one clean `servers_health_check` remediate restart (reap leftover first). Not an agent turn. Existing create-from-skill / managed rows (no health+restart watcher) are migrated on Home boot and watcher list/get. Import/friend trees (`importedFrom` without `managedFrom`) are skipped. `workshop_update` is notify-only and must never auto-restart.

## Triggers (v1)

| Kind | Source |
|------|--------|
| `schedule` | Interval (+ optional 5-field cron); engine tick every 5s |
| `server_status` | EventHub `server.status` |
| `log_pattern` | EventHub `server.log` regex match |
| `health` | Polled `HealthService` for servers that have health watchers |
| `query` | Polled live query predicates (`players_*`, `map_eq`) |
| `panel_input` | EventHub `panel.input` (vote / readiness) |

## Actions

- **tools** — allowlisted registry tools only (`servers_health_check`, start/stop/restart, logs, query, snapshot, panel, RCON, net/fs read). Auto-confirm with actor `watcher:{id}`; audited in `watcher_runs`.
- **agent** — `createOrchestrator` with `confirmPolicy: "auto"`, workspace bound to the server, optional status/health/query/log context injected into the prompt. Activity published as `agent.activity` (Monitor skill).

## Safety

- Destructive chat confirms still apply to interactive turns; watcher runs auto-approve and log.
- Hosts disable or delete watchers; there is no per-run confirm UI in v1.
- Max one run per server at a time; global cap of three concurrent agent turns.
- Cooldown / debounce prevent flapping on log storms.

## Surfaces

- HTTP: `/api/watchers`, `/api/servers/:id/watchers`, run + runs
- MCP / Canvas tools: `watchers_*`
- Admin UI: Dashboard + Settings → Watchers
- Events: `watcher.fired`, `watcher.run`, `panel.input`

## Related

- [04 – Agent System Design](04-agent-system-design.md) (Monitor workflow)
- [05 – Runtime & Node Management](05-runtime-and-node-management.md) (health checks)
- [16 – Live Server Query](16-live-server-query.md)
- [17 – MCP & External Agents](17-mcp-and-external-agents.md)
