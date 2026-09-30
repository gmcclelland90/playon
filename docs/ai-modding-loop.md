# AI-authored mod loop

Host agents iteratively author game mods inside a per-server jail, then deploy with a snapshot gate.

Curated `games.*` skill content lives in sibling **playon-games** (not this repo). Keep host-facing onboarding on [playon.games](https://playon.games) in sync when the Mods panel / make-a-mod UX lands (#996+).

## Tools (maintain / full catalog)

| Tool | Role |
| ---- | ---- |
| `mods_scaffold` | Confirm-gated. Creates `mods-src/<modId>/` + dialect skeleton + `playon-mod.json`. |
| `mods_deploy` | Confirm-gated. `snapshot_create` first, then copies into the live dialect path (e.g. PZ `mods/`, Paper `plugins/`) and patches enable lists. Refuses Workshop cache paths. |
| `mods_workshop_prepare` | Confirm-gated. PZ dry-run zip under `workshop-out/<modId>/`. `livePublish` → `blocked_human` / `steam_credentials_human_gate` (no Steam upload). |
| `mods_assets_generate` | Confirm-gated. BYO fal image → `mods-src/<modId>/assets/` (see `docs/fal-assets.md`). |
| `mods_lua_check` | Read-only (PZ). Static B42 Lua API guard on `mods-src` before deploy. |
| `mods_errors` | Read-only. Parses dialect logs (PZ Lua, Paper) for mod name / file / line / message. |

## Loop

1. `mods_scaffold` with a stable `modId` (and display name).
2. Edit only under `mods-src/<modId>/` via `fs_*` (jailed).
3. `mods_lua_check` (PZ) — fix findings before deploy.
4. `mods_deploy` (host confirms) — never hand-patch live mod dirs when this tool exists.
4. `servers_restart` (or equivalent skill restart).
5. `mods_errors` — if dirty, fix sources in `mods-src` and redeploy.
6. Short host reply when clean (or when blocked on dialect/API limits).

## Safety

- Deploy always snapshots first; restore via `snapshot_restore` if a deploy breaks the world.
- Do not write Workshop workshop content dirs as an authoring target.
- Keep secrets (API keys, Steam) out of mod files and player panel payloads.
- PZ pre-deploy Lua API checks are a separate slice (#1001); still run `mods_errors` after restart.

## External guides

Workshop / game-specific install steps remain in skill `INSTALL.md` / `MODDING.md` from **playon-games**. This doc only covers the PlayOn AI author → deploy → verify loop.
