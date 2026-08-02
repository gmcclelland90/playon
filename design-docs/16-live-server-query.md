# 16 – Live Server Query

## Purpose

A GameQ-style query layer that returns **uniform live game stats** (players, map, mode, …) across different games, and lets agents **author a skill-local connector** when no built-in dialect exists.

This feeds the player panel Server Status block ([06](06-player-facing-panel-design.md)), health checks ([05](05-runtime-and-node-management.md)), and the monitor agent ([04](04-agent-system-design.md)).

## Separation from admin protocols

| Layer | Role | Examples |
|-------|------|----------|
| **Query** | Read-only discovery; no secrets required | Minecraft status ping, A2S, Unreal query, skill modules |
| **Admin** | Authenticated commands | `mc_rcon`, `source_rcon`, `rust_web_rcon`, `http_rest`, `stdin` |

Skills declare both `queryDialect` and `adminDialect`. Do not put RCON passwords on the player panel.

## Uniform result: `LiveServerState`

Core fields (omit when unknown):

- `online`, `queryMs`
- `name`, `game`, `map`, `mode`
- `players`, `maxPlayers`, `playerList[]` (`name`, optional `score` / `time` / `raw`)
- `version`, `passwordProtected`, `uptimeSeconds`
- `extras` — game-specific bag (rounds, tags, …)
- `error` — when offline / connector failure (for agents; keep panel clean)

Connectors must not invent missing data.

## Built-in dialects

| `queryDialect` | Typical games | Notes |
|----------------|---------------|-------|
| `minecraft_status` | Paper / Java | TCP status ping |
| `a2s` | Rust and other Valve query | Often game UDP port |
| `valheim` | Valheim | Prefer skill `query` port |
| `unreal` | UT99 | Prefer skill `query` port |
| `terraria` | Terraria | GameDig-class |
| `factorio` | Factorio | UDP query |
| `skill_module` | Agent-authored | Load `query/connector.mjs` from the skill |
| `none` | No live query | Lifecycle / TCP health only |

Optional metadata: `queryPortName` (default `query`, else `game`), `queryConnector` (default `query/connector.mjs`).

## Skill-module connectors

When no built-in fits, agents draft a skill with:

```text
metadata.yaml          # queryDialect: skill_module
query/connector.mjs    # default export async function query(ctx)
guides/QUERY.md        # protocol notes
```

`ctx` exposes only jail-scoped helpers (`udp` / `tcp` / `http` to the target host and declared ports). Modules run in a worker with a hard timeout; the host validates the return value with `LiveServerStateSchema`.

Workflow: research → write connector → `servers_query_test` → iterate → promote skill (copies `query/`). Prefer a built-in dialect when one matches.

See skill guide `platform.server-query` / `AUTHORING_CONNECTORS.md`.

## Control plane

- Tool `servers_query` — live state for a server id
- Tool `servers_query_test` — exercise a draft connector against host:port
- Health check type `query_responding`
- Poller refreshes panel `server_status` while servers are running
- **Owned live fields** on `server_status.body` (`online`, `players`, `maxPlayers`, `map`, `mode`, `serverName`, `version`, `uptimeSeconds`, `playerList`): merged on start/restart and every `panel_publish`. Fresh online query wins; otherwise prior live metrics are retained so agents cannot wipe player counts. Extend `LIVE_PANEL_STATUS_KEYS` when adding uniform fields.

## Related docs

- [03 Skills](03-skills-system-design.md) — drafts and package layout
- [06 Player panel](06-player-facing-panel-design.md) — status content
- [12 Security](12-security-and-safety-model.md) — scoping / secrets
