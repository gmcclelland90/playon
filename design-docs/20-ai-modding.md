# 20 – AI Modding

> **Status:** Draft — epic [#988](https://github.com/gmcclelland90/playon/issues/988), design slice [#989](https://github.com/gmcclelland90/playon/issues/989).  
> **Baseline:** `main` @ `58a3f55` (merged [#981](https://github.com/gmcclelland90/playon/pull/981) tool-catalog / orchestrator continue).  
> **Follow-on:** [#990](https://github.com/gmcclelland90/playon/issues/990) `mods_errors` · [#991](https://github.com/gmcclelland90/playon/issues/991) workspace + deploy · [#992](https://github.com/gmcclelland90/playon/issues/992) agent guidance.

## One-liner

A host asks the in-app or MCP agent to **make a mod that …** for a server PlayOn already hosts. The agent authors it in a jailed workspace, deploys it into that server’s dialect path, reads structured load errors, and iterates. Later the result can ship as a shareable `experiences.*` package.

## User story

**As a LAN host**, I say: *“On the Zomboid box, make a mod that lets players stash extra loot in a shared locker.”*

The agent (Canvas + Venice/Ollama, or an external MCP client) should:

1. Bind the existing server workspace (not fork a sibling).
2. Read the game skill’s `MODDING.md` / `INSTALL.md` via `skill_read`.
3. Scaffold a server-local mod in `mods-src/` inside that server’s jail.
4. Author files with `fs_*` (or a thin scaffold helper).
5. Ask me to confirm a **snapshot-then-deploy** into the game’s live mod/plugin location.
6. Restart, parse **mod** errors from logs, and fix until load is clean.
7. Tell players, via the panel, whether they need extra client files (`none` / `auto` / `manual`).

I never hand the agent a host-wide shell. I never want client injection or anti-cheat bypass. I do not want NZL / friend servers bounced as a side effect of lab work.

## How mods work in PlayOn today

PlayOn already **installs and refreshes** third-party mods. It does **not** yet author or iterate them.

| Surface | What exists | Gap |
|---------|-------------|-----|
| Agent skill **Mod** (`modder`) | XP track + confirm/activity metadata | Only `fetch_url` is tagged `modder` today |
| System prompt | Workshop: snapshot → write Workshop IDs → delete that workshop dir → restart. Zip/URL: snapshot → `fetch_url` → `archive_extract` → place → restart. Stay in jail. | No author → deploy → parse-errors loop |
| Content tools | `fetch_url` (confirm), `archive_extract` (confirm), `steamcmd_app_update` (confirm; whole app, not one Workshop item) | No scaffold / dialect deploy |
| Files | `fs_*` path-jailed to the bound server (`server_required`) | Agent must know game paths by reading skills |
| Logs | `servers_logs_tail` (troubleshooter; default 80 / max 200 lines) | Raw tail; no dialect error extract |
| Snapshots | `snapshot_create`; `withSnapshot` before restore | Deploy does not yet snapshot-then-copy |
| Skills | `guides/MODDING.md` is the convention ([03](03-skills-system-design.md)). Curated `games.*` live in sibling **playon-games** | No `modDialect` on skill metadata |
| Watchers | `workshop_update` polls Steam publishedfile IDs; **notify-only**, never auto-restart ([18](18-watchers.md), `#881`) | `log_pattern` can wake Monitor; no mod-error tool to call |
| Catalog stages ([#981](https://github.com/gmcclelland90/playon/pull/981)) | `install` / `maintain` / `full`. `servers_get` is on install+maintain. Jail writes live on **maintain** | New mod tools belong on maintain (+ `full` / MCP), not install |

There is no `mods-src/`, no `mods_*` registry entries, and no `experiences.*` package kind. Architecture 02’s generic `mods/` folder is illustrative; live games use dialect paths under the same jail.

## Non-goals

- Client injection, DLL hooks, EAC/BattlEye/VAC bypass, or shipping cracked clients.
- Authoring mods for servers PlayOn does not host (friend/live inventory is session-blocked).
- Auto-restart on Workshop updates or on every Lua stack (watchers stay notify- or host-scheduled).
- Curated `games.*` trees in this monorepo (playon-games owns those; note guide edits in #992).
- A second tool catalog, overlay table, or MCP-only fork ([17](17-mcp-and-external-agents.md)).
- Bouncing live NZL / friend lab servers to “try the loop.”
- Venice billing / credit P0s.
- Replacing `fetch_url` + Workshop ID refresh for **installing existing** Workshop/zip mods.

## Fit to existing architecture

AI modding is another **workflow flavor** of the single agent ([04](04-agent-system-design.md)), not a new actor.

| Constraint | How this feature obeys it |
|------------|---------------------------|
| One tool registry | New Tool Entries in `apps/api/src/services/tools/` (proposed `mods.ts`), composed only via `TOOL_MODULES` / `createPlayOnToolRegistry` |
| Path jail | Workspace and deploy destinations are relative paths inside the bound server data dir (Home jail or node-authoritative jail via File Store) |
| Confirm gates | Any tool that writes live game files or enable-lists is `requiresConfirm: true` with a `modder` `confirmAction` |
| Snapshots | Deploy wraps `withSnapshot` (same helper as restore) **before** copy/ini patch |
| Zod additive | Optional `modDialect` (and later `modPaths`) on `SkillMetadataSchema`; tool result schemas versioned if needed |
| Catalog stages | Register names in `MAINTAIN_EXTRA_TOOL_NAMES` only. Do **not** grow the install TPM set. MCP + watcher scripts keep `full` |
| Workspace binding | `server_required`; session `restrictTargets` still blocks friend/live ids |
| Skills vs tools | Dialects and error patterns live in platform code + Zod; per-title prose stays in playon-games `MODDING.md` |
| Watchers | May later call `mods_errors` from a `tools` script. Must not auto-approve `mods_deploy` in v1 |

### Sequencing with tip `58a3f55` / #981

[#981](https://github.com/gmcclelland90/playon/pull/981) taught mid-size Venice models to **continue** after an empty-after-tools turn or a numbered two-step that stopped at the first inspect, and added `servers_get` to the install/maintain catalog (no jail path).

The author → deploy → restart → `mods_errors` loop is inherently multi-step. Implementation must:

- Rely on the existing host loop (`LOOP_UNTIL_DONE_PROMPT`, `SEQUENTIAL_TOOLS_PROMPT`) rather than inventing a second orchestrator.
- Keep new tools off the **install** catalog so TPM stays small.
- Use `servers_get` + `skill_read` for inspect; do not re-add a parallel “get server for mods” tool.
- Echo `name` on tool result messages (already done in #981) so continue-after-partial can bind the next call.
- Treat watcher `confirmPolicy: "auto"` as **unsafe** for deploy; chat/MCP stay `gate`.

## Mod dialects

A **mod dialect** is the PlayOn analog of `queryDialect` ([16](16-live-server-query.md)): a built-in, read-mostly descriptor of *where mods live, how they are enabled, how load failures look in logs, and what clients need*.

Proposed additive skill field (default `none`):

```text
modDialect: none | project_zomboid | minecraft_paper | rust_oxide | rust_carbon
          | garrys_mod | terraria_tmod | factorio | skill_module
```

`none` means “use skill guides + `fs_*` only.” `skill_module` is reserved for a later jail-scoped descriptor (same spirit as query `connector.mjs`); first games use built-ins.

**Client need** (panel + agent copy, not a network protocol):

| Value | Meaning |
|-------|---------|
| `none` | Server-side only. Players join with the stock client. |
| `auto` | Clients pull content (Steam Workshop, Factorio sync, GMod workshop collection). Panel still explains that. |
| `manual` | Players must install matching files before join. Panel `client_setup` is mandatory. |

Built-ins below are the contract for tools. Exact bind-mount prefixes (`game/`, userdata home, Docker `/data`) stay in the **game skill**; the dialect gives *relative* targets the deploy tool resolves against the jail.

### First-wave dialects

#### `project_zomboid` (Lua + Workshop)

| | |
|--|--|
| **Live tree** | Server-local: `mods/<ModFolder>/` with `mod.info` + `media/lua/…`. Workshop cache is separate (`steamapps/workshop/content/108600/<id>/` or image-specific Workshop dir). |
| **Enable** | Server INI: `Mods=` (internal ids / folder names) and, for Workshop, `WorkshopItems=` (publishedfile ids). |
| **Load** | Dedicated reads INI, Steam downloads Workshop, then loads Lua. |
| **Error log** | Console / `console.txt` / runtime tail. Markers: `STACK TRACE`, `Exception thrown`, `Lua((MOD:<name>)).<fn>(<file>:<line>)`, `Object tried to call nil`. Fixture for #990: `Lua((MOD:PlayOn Nexus)).serializeInventory(Utils.lua:94)`. |
| **Client** | Workshop ids → **auto**. Server-local-only Lua that the client must also run → **manual**. Pure server Lua (no client scripts) → **none**. |
| **AI-authored default** | Write under `mods-src/<id>/`, deploy into server-local `mods/`, append `Mods=`. Do not invent Workshop ids. |

#### `minecraft_paper` (plugins)

| | |
|--|--|
| **Live tree** | `plugins/*.jar` plus optional `plugins/<PluginName>/` data. |
| **Enable** | Presence in `plugins/` (+ `plugin.yml` inside the jar). Soft-disable via Paper’s plugin manager / `plugins/*.jar.disabled` is out of v1. |
| **Load** | Paper PluginManager on start / reload. |
| **Error log** | `logs/latest.log` and runtime tail. Markers: `Error occurred while enabling`, `Could not load plugin`, `Exception` under `org.bukkit` / plugin main class. |
| **Client** | **none** for ordinary plugins. Resource-pack / datapack extras are panel notes, not this dialect. |
| **AI-authored default** | v1 authors **source + build notes** in `mods-src/` and deploys a jar *only if* a jail-safe build exists; otherwise document “host builds the jar” and place a prebuilt jar the host confirmed. Do not fetch random GitHub releases without confirm (`fetch_url`). |

Paper plugin compile (JDK in the jail or node) is an implementation detail for #991; the dialect must not assume a compiler is present.

#### `rust_oxide` / `rust_carbon`

| | Oxide | Carbon |
|--|-------|--------|
| **Live tree** | `oxide/plugins/*.cs` (plus `oxide/config/`, `oxide/lang/`) | `carbon/plugins/*.cs` (Carbon layout) |
| **Enable** | File present; optional `oxide.reload <name>` via RCON | File present; Carbon reload |
| **Load** | Compiler on drop / restart | Same idea, different compiler |
| **Error log** | `Failed to compile`, `Failed to initialize plugin`, C# compiler errors in Oxide/Carbon logs + runtime tail |
| **Client** | **none** (server plugins). Harmony/client assemblies are out of scope. |
| **AI-authored default** | C# plugin source in `mods-src/`, deploy into the matching plugins dir. Skill (or host) chooses Oxide vs Carbon; do not mix trees. |

No EAC bypass, no client-side Rust hooks.

#### `garrys_mod`

| | |
|--|--|
| **Live tree** | `garrysmod/addons/<addon>/` (`lua/`, `addon.json`) and/or Workshop collection via `+host_workshop_collection`. |
| **Enable** | Addon folder present, or collection id on the command line / config. |
| **Load** | Server Lua autorun. |
| **Error log** | `[ERROR]` Lua paths, `addons/<name>/…:<line>:`, stack dumps in console. |
| **Client** | Workshop collection → **auto**. FastDL / local addon Lua that clients must share → **manual**. Server-only Lua → **none**. |
| **AI-authored default** | Server-side Lua addon under `mods-src/`, deploy to `garrysmod/addons/<id>/`. Workshop collection management stays the existing Workshop refresh path. |

#### `terraria_tmod`

| | |
|--|--|
| **Live tree** | tModLoader `Mods/` (`.tmod` and/or extracted) + enable list (`enabled.json` / ModPack). |
| **Enable** | Enable-list + files in `Mods/`. |
| **Load** | tModLoader dedicated on start. |
| **Error log** | `An error occurred while loading`, tMod exceptions, missing dependency lines. |
| **Client** | **manual** (same mods on every player). Panel must list the pack. |
| **AI-authored default** | Source in `mods-src/`; deploy built `.tmod` or extracted mod folder + enable-list patch. Vanilla `games.terraria` is **not** this dialect (`modDialect: none`). |

#### `factorio`

| | |
|--|--|
| **Live tree** | `mods/<name>_<version>.zip` (or directory) + `mod-list.json` / `mod-settings.dat`. Headless may also use `~/.factorio/mods`. |
| **Enable** | `mod-list.json` enabled flags. |
| **Load** | Factorio reads the mods dir on start. |
| **Error log** | `Failed to load mod`, `Error while loading`, cycle/dependency errors in `factorio-current.log` / runtime tail. |
| **Client** | **auto** (Factorio syncs the server pack on join). |
| **AI-authored default** | `info.json` + Lua in `mods-src/`, zip or copy into `mods/`, enable in `mod-list.json`. |

### Dialect resolution

Same pattern as `resolveQueryDialect`: prefer explicit `metadata.modDialect`; else a small known-title map (`games.project-zomboid` → `project_zomboid`, `games.minecraft-paper` → `minecraft_paper`, …). Unmapped titles stay `none`. Overlay is additive and does not rewrite on-disk YAML.

## Jailed mod workspace

PlayOn-owned authoring root, **inside** the server jail:

```text
<server dataPath>/
  mods-src/                 # agent scratch; not loaded by the game
    <modId>/
      playon-mod.json       # dialect, display name, clientNeed, version
      … dialect sources …
  game/ | Zomboid/ | …      # live tree (skill-defined)
  logs/
  skill.json
```

Rules:

- `mods-src/` is never on the game’s load path. The game only sees files after **deploy**.
- All paths stay under the File Store jail (local or node-authoritative). No `..` escape.
- One folder per authored mod. Do not overwrite Workshop cache as the edit target.
- `playon-mod.json` is PlayOn metadata (Zod), not a substitute for `mod.info` / `plugin.yml` / `info.json`.
- Worlds, `db/`, and player saves are out of bounds for deploy copy.

## Proposed tools

All new tools: `workspacePolicy: "server_required"`, surface skill **`modder`**, composed in `TOOL_MODULES`. Add names to `MAINTAIN_EXTRA_TOOL_NAMES` (and therefore `full`). Omit from `INSTALL_TOOL_NAMES`.

### `mods_errors` — #990 (read-only, first slice)

Tails the same runtime log source as `servers_logs_tail` (and, when present, well-known relative files such as PZ `console.txt` / Paper `logs/latest.log`) and extracts **mod/plugin** failures using the resolved dialect’s pattern set.

| | |
|--|--|
| Confirm | No |
| Jail | Read-only |
| Args | `serverId`, optional `lines` / `since` (keep small; default covers a restart tail) |
| Result | `{ dialect, errors: [{ kind, mod, file, line, message, excerpt }], logSource }` — do not invent mods that are not in the text |
| v1 patterns | PZ: `STACK TRACE` / `Exception thrown` / `Lua((MOD:…))` / `Object tried to call nil`. Paper: plugin enable/load exceptions |
| Tests | Unit tests from realistic excerpts, including the PlayOn Nexus fixture |

Does not restart, does not write. Agents may still call `servers_logs_tail` for context.

### `mods_scaffold` — pairs with #991

Creates `mods-src/<modId>/` plus dialect skeleton (`mod.info` + Lua stub, `info.json`, Oxide `.cs` stub, `addon.json`, …) and `playon-mod.json`.

| | |
|--|--|
| Confirm | Yes — `confirmAction`: “create a mod workspace in this server folder” |
| Writes | `mods-src/` only |
| Args | `serverId`, `modId`, optional `displayName`, optional `dialect` override |

Idempotent: refuse to clobber a non-empty folder unless `overwrite` is confirmed.

### `mods_deploy` — #991

Confirm-gated: **snapshot first**, then copy `mods-src/<modId>/` (minus `playon-mod.json`) into the dialect live path and patch enable lists (`Mods=`, `mod-list.json`, tMod enable file). Does not start/stop the process; the agent calls `servers_restart` after the host confirms that separately (or in the same chat turn).

| | |
|--|--|
| Confirm | Yes — `confirmAction`: “snapshot this server and install the authored mod” |
| Snapshot label | e.g. `pre-mod-deploy` via `withSnapshot` |
| Args | `serverId`, `modId` |
| Result | `{ snapshotId, destPath, enablePatched, clientNeed, restartRequired: true }` |

Refuse when dialect is `none` or dest would escape the jail. Refuse Workshop-cache overwrite. Do not touch friend/live trees.

v1 dest map (resolved under the skill’s data root):

| Dialect | Copy dest | Enable patch |
|---------|-----------|--------------|
| `project_zomboid` | `mods/<ModFolder>/` | `Mods=` in server INI |
| `minecraft_paper` | `plugins/` (jar or documented drop) | presence |
| `rust_oxide` | `oxide/plugins/` | presence |
| `rust_carbon` | `carbon/plugins/` | presence |
| `garrys_mod` | `garrysmod/addons/<id>/` | presence |
| `terraria_tmod` | `Mods/` | enable list |
| `factorio` | `mods/` | `mod-list.json` |

### Intentionally not new tools (v1)

| Need | Existing tool |
|------|----------------|
| Inspect server | `servers_get` (#981) |
| Read guides | `skill_read` |
| Edit sources | `fs_write` / `fs_copy` (confirm) |
| Pull a zip | `fetch_url` + `archive_extract` |
| Restart | `servers_restart` (confirm) |
| Raw logs | `servers_logs_tail` |
| Workshop update notify | `watchers_*` + `workshop_update` |

Optional later: `mods_list` (workspace + live inventory). Not required for the first loop.

## Author → deploy → iterate loop

Guidance text lands in #992 (agent prompt / platform skill — **not** a curated `games.*` tree here). Intended sequence:

```text
skill_read (MODDING.md) → servers_get
  → mods_scaffold (confirm) → fs_write sources
  → mods_deploy (confirm + snapshot)
  → servers_restart (confirm)
  → mods_errors
  → fix in mods-src/ → deploy → restart → mods_errors
  → panel_upsert client_setup when clientNeed ≠ none
```

Self-heal stays one retry on the same failing call ([04](04-agent-system-design.md) prompt). After a clean `mods_errors`, short host reply + panel note.

Watchers may use `log_pattern` on PZ `STACK TRACE` or Paper enable errors to run **`mods_errors` only** (or a Monitor prompt). They must not chain `mods_deploy` + restart without a host.

## Publish lint

Before an authored mod is exported as an experience (later), a lint runs in-process (no extra network):

- Required dialect files exist (`mod.info`, `info.json`, `plugin.yml` / jar note, Oxide class file, …).
- `playon-mod.json` parses; `clientNeed` is set.
- No path escape; no files outside `mods-src/<modId>/`.
- No shipped anti-cheat bypass, injector, or unsigned native client hook (filename / extension denylist; fail closed).
- Secrets: no RCON passwords or API keys in the pack.
- Size cap (same order as `fetch_url` / archive limits).

Lint can be a function called from deploy (warn) and from experience export (hard fail). A dedicated `mods_lint` tool is optional; do not block #990–#991 on it.

## Optional asset generation

Out of v1. If added later:

- Confirm-gated, `modder` surface, writes **only** under `mods-src/<modId>/`.
- Provider is Settings-configured (same secret hygiene as Venice). Never echo keys into logs or the player panel.
- Host spend is a human gate (`blocked-human` if a new paid provider is introduced).
- Generated binaries still pass publish lint.

Do not bake a second image model into the orchestrator.

## Host UX (v1)

Per-server **Mods** panel (Controls dock) lists `mods-src/` workspaces (`authored` until `playon-deploy.json` exists, then `deployed`) and the same structured hits as `mods_errors`. Chat starter **Make a mod that…** prefills the composer; it does not send. Confirm gates stay on scaffold/deploy.

## `experiences.*` (v1 tools)

Agent tools `experiences_export` / `experiences_install` (confirm-gated) pack `playon-experience.json` + `mods/` + overlays + optional `seed/` + panel summary. Install targets an **existing** bound server only (snapshot first; never `servers_create_from_skill`). Catalog promotion remains playon-games / human.

## Later: `experiences.*` catalog

A shareable pack of an **authored** (or curated) server-side mod + panel copy, not a full game skill.

| | `games.*` | `experiences.*` (later) |
|--|-----------|-------------------------|
| Job | Install and run a title | Drop a PlayOn-authored (or library) mod onto an existing server |
| Format | Existing `.skill.zip` | Same zip envelope if possible; `metadata.yaml` `name: experiences.<id>` |
| Install | `servers_create_from_skill` | Deploy into an **already bound** server jail + enable-list |
| Catalog | playon-games | playon-games later; none in this monorepo |

Export = lint + zip of `mods-src/<modId>/` + dialect + `clientNeed`. Import = confirm + snapshot + deploy path. Promotion to the public library is a human/catalog concern ([15](15-playon-games-site-and-skill-library.md)).

## Implementation slices

| Issue | Slice | Verify |
|-------|-------|--------|
| #989 | This document | Docs PR |
| #990 | `mods_errors` + PZ/Paper fixtures, `modder`, maintain catalog | `pnpm verify` |
| #991 | `mods-src/` + `mods_scaffold` + `mods_deploy` (PZ + Paper dests first; other dialects can stub `unsupported_dialect`) | `pnpm verify` |
| #992 | Prompt / platform guide for the loop; list playon-games `MODDING.md` edits | Docs + prompt tests if present |

Lab: do not restart NZL / friend servers. Isolated `PLAYON_DATA_ROOT` only.

## Success

- Host can complete “make a mod that …” on a PlayOn-hosted PZ or Paper server without leaving the jail or skipping confirm/snapshot.
- `mods_errors` returns the PlayOn Nexus-style Lua nil call as a structured hit.
- Mid-size Venice models can run the multi-step loop using #981 continue behavior and the maintain catalog.
- MCP and Canvas see the same tool names and gates.

## Related

- [03 – Skills](03-skills-system-design.md) — `MODDING.md`, drafts
- [04 – Agent system](04-agent-system-design.md) — Mod workflow, one agent
- [09 – Snapshots](09-backup-snapshot-and-recovery.md) — pre-change snapshots
- [12 – Security](12-security-and-safety-model.md) — jail, confirm, no unconstrained FS
- [13 – Extensibility](13-extensibility-and-roadmap.md)
- [15 – playon.games catalog](15-playon-games-site-and-skill-library.md)
- [16 – Live query dialects](16-live-server-query.md) — dialect pattern this copies
- [17 – MCP](17-mcp-and-external-agents.md) — same registry
- [18 – Watchers](18-watchers.md) — `workshop_update` notify-only; `log_pattern`
- `docs/workshop-watcher.md`
