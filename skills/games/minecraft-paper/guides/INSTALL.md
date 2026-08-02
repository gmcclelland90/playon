# Minecraft Paper

## Happy path (Docker)

Preferred image: `itzg/minecraft-server` with `TYPE=PAPER`.

1. Create server from skill `games.minecraft-paper`.
2. Ensure Docker is available on the node (`PLAYON_RUNTIME=docker`).
3. Start the server — expose TCP **25565**.
4. **Required — player panel:** after start, publish so LAN players can join:
   - `join_info` (address/port filled by the control plane; use the advertise host, not `127.0.0.1`)
   - `client_setup` — Java Edition → Multiplayer → Direct Connection → `host:25565`
   - Optional: `server_status`, guides for mods/version pins
   - The public panel only shows these blocks while the server is **starting/running**

## Mock / offline

With `PLAYON_RUNTIME=mock`, PlayOn still creates the server directory and can publish panel blocks. No real Minecraft process runs until Docker mode is enabled.

## Defaults

- Port: 25565/tcp
- EULA must be accepted for real containers (`EULA=TRUE` env on itzg image)
- Start with a modest player slot count for LAN nights

## Live tweaks (RCON)

Modern Java/Paper (1.21.11+ / calendar versions like **26.x**) renamed gamerules to snake_case.

| Goal | RCON commands |
| --- | --- |
| Always daytime | `time set day` then `gamerule advance_time false` |
| Weather lock | `gamerule advance_weather false` |
| Keep inventory | `gamerule keep_inventory true` |

Do **not** use legacy names (`doDaylightCycle`, `doWeatherCycle`, `keepInventory`) on 26.x — they return `Incorrect argument for command`.

## Troubleshooting

- If players time out: check Windows firewall / bind address `0.0.0.0`
- If image pull fails: verify Docker daemon and network
- Prefer a fixed `VERSION` env for reproducible LAN nights
- If the agent says the panel was published but players see nothing: confirm `servers_start` left the server **running**
