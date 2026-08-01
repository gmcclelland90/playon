# Minecraft Paper

## Happy path (Docker)

Preferred image: `itzg/minecraft-server` with `TYPE=PAPER`.

1. Create server from skill `games.minecraft-paper`.
2. Ensure Docker is available on the node (`PLAYON_RUNTIME=docker`).
3. Start the server — expose TCP **25565**.
4. Publish player panel:
   - `join_info` with address `lan-host:25565` (or the host LAN IP)
   - `server_status` with status `running`
   - `client_setup` noting vanilla/Paper clients of matching version

## Mock / offline

With `PLAYON_RUNTIME=mock`, PlayOn still creates the server directory and can publish panel blocks. No real Minecraft process runs until Docker mode is enabled.

## Defaults

- Port: 25565/tcp
- EULA must be accepted for real containers (`EULA=TRUE` env on itzg image)
- Start with a modest player slot count for LAN nights

## Troubleshooting

- If players time out: check Windows firewall / bind address `0.0.0.0`
- If image pull fails: verify Docker daemon and network
- Prefer a fixed `VERSION` env for reproducible LAN nights
