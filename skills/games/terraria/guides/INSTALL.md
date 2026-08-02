# Terraria (Docker)

Depends on `platform.docker-basics`.

## Start

1. Create a server from `games.terraria`.
2. `servers_start` pulls `ryshe/terraria:latest` and mounts `game/` → world path.
3. First boot: set `WORLD_FILENAME` (default `world.wld`) or let the image autocreate per its docs.
4. Firewall: **TCP 7777** (also allow UDP 7777 if your network path needs it).
5. **Required — player panel:** `panel_publish` with `join_info` + `client_setup` (Terraria → Multiplayer → Join via IP → `host:7777`). Only visible while starting/running.

## Join

- Terraria → Multiplayer → Join via IP → `advertiseHost:7777`

## Notes

- Image is TShock-oriented; keep the first LAN night simple (one world, few players).
- **tModLoader** is a follow-up skill/sibling — do not mix loaders in the same `game/` tree without a wipe plan.
- Snapshot before world deletes or major version jumps.
- `minRamMb` ~1.5 GB for small/medium worlds.
