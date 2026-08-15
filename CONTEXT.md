# PlayOn domain glossary

Terms used by architecture and product docs. Prefer these names over file-local jargon.

## Control Plane

The in-process service graph shared by HTTP routes, agent tools, and background schedulers. Constructed once via `createControlPlane` — one `ServerService`, one `PanelService`, one event hub, etc. Agents and REST must not each build a parallel graph.

## Server

A managed game-server instance with its own data directory, package marker (`skill.json`), runtime handle, and player panel blocks.

## Game / Platform package

Versioned knowledge package (metadata, guides, optional query connector) identified by `games.*` or `platform.*`. **Games** (e.g. `games.minecraft-paper`) are player-facing; **Platform packages** (e.g. `platform.docker-basics`) provide common host capabilities. Installed servers pin a package via the Package Marker. Together, these share the **Package** umbrella (same `.skill.zip` format, marker, and import/export protocol).

Distinct from **agent skills** — XP tracks like Install, Monitor, Config, Fix, Backup, Panel, Mod, Lead that classify tool surfaces, not installable packages.

**HTTP API routes**: Both `/api/skills/*` (legacy) and `/api/packages/*` (player-facing alias) serve the same handlers. `/api/games/*` filters to `games.*` packages only. All three route families remain supported for backward compatibility.

**Repository layout**: Platform packages and test fixtures live under `catalog/` (not `packages/` — that's the pnpm workspace glob for npm libs).

## Package Marker

Per-server `skill.json` under the server data path. Single read/write/validate contract (`apps/api/src/services/skill-marker.ts`) for provision, import, panel join, query dialect, and runtime start. Create and import both write the full marker from package metadata; import may add `importedFrom` / `importedAt`.

## Player Panel

Agent-pushed, player-facing surface: join info, status, guides, votes. Owned by the `PlayerPanel` service on the Control Plane (publish for status / from agent, list for players, theme). Only live while the server is starting/running for public visibility of join blocks.

## Mineflayer bot

A Java-edition protocol client that can join a PlayOn Minecraft server the same way a player does. Not a PlayOn agent or skill. Reference implementation: [gmcclelland90/grokbot-mineflayer](https://github.com/gmcclelland90/grokbot-mineflayer). Other Grok bots should fork that repo. See [docs/mineflayer.md](docs/mineflayer.md).

## Tool Surface

Canonical catalog of agent tools. A **Tool Entry** colocates the LLM definition, surface metadata (skill, confirmAction, activityVerb, XP), workspace policy, and handler; domain modules under `apps/api/src/services/tools/` are composed by `createPlayOnToolRegistry`, which returns `{ registry, surface }`. Chat, MCP, and watchers share that factory and read projections (agent-skill XP, confirm copy, activity verbs) from the returned surface. The factory is the only source of the catalog: there is no overlay table and no process-wide surface, so a tool that no domain module composes does not exist.

## Query Dialect

Read-only live discovery protocol for a Game or Platform package (`minecraft_status`, `a2s`, `skill_module`, …). Owned by the Connector registry (`DialectDescriptor` + `builtInDialectIds`); distinct from admin/RCON dialects. Built-ins carry `portPreference` (`game` | `query`); `none` and `skill_module` stay outside the built-in set.

## Live Server State

Uniform result of a Query Dialect connector (online, players, map, …). Projected once via `liveStateToPanelBody` into player panel `server_status` fields.

## Runtime Selection

How a Server starts: Docker container vs OS process. Host `PLAYON_RUNTIME` (`docker` | `native`) is authoritative for adapter construction and mode labels on Linux. Package `containerSupport` is colocated with that host capability:

- `containerSupport=none` → process supervisor
- `containerSupport=full` (or `partial`) → Docker when the target node has a matching-OS engine
- Linux `PLAYON_RUNTIME=native` → process only, even for container-capable packages
- Windows nodes default to `PLAYON_RUNTIME=native` (PE / SteamCMD) but still report `docker` and run containers when Docker Engine is in **Windows container mode**. Linux images stay on the WSL sibling (`{nodeId}-wsl`).

See [docs/adr/0002-real-runtime-and-llm.md](docs/adr/0002-real-runtime-and-llm.md).
