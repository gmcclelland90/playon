# Factorio (Docker)

Depends on `platform.docker-basics`.

## Start

1. Create a server from `games.factorio`.
2. On Linux hosts, the image often runs as uid **845** — ensure `game/` is writable (`chown 845:845` if the container cannot write saves).
3. `servers_start` pulls `factoriotools/factorio:stable`, mounts `game/` → `/factorio`.
4. Default env creates save **playon** (`GENERATE_NEW_SAVE=true`). After the first successful night, prefer `LOAD_LATEST_SAVE=true` / disable generate so you do not clobber the factory.
5. Ports: **UDP 34197** (game), **TCP 27015** (RCON — do not put the password on the player panel).
6. **Required — player panel:** `panel_publish` with `join_info` + `client_setup` (Factorio → Multiplayer → Connect to address → `host:34197`). Only visible while the server is starting/running.

## Join

- Factorio → Multiplayer → Connect to address → `advertiseHost:34197`

## Version pins

Long-lived saves break across major Factorio versions. Pin the image tag for a campaign; snapshot before upgrades.

## Mods

Official mod portal needs factorio.com username/token in env for updates — store as host secrets (`platform.server-auth`), never on the panel.
