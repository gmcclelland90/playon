# Unreal Tournament 99 (dedicated)

PlayOn creates a jailable server data directory. **You must supply UT99 server files** (typically an [OldUnreal](https://www.oldunreal.com/) 469d+ dedicated build). Place them under this server’s `game/` folder.

## Host checklist

1. Create the server from skill `games.unreal-tournament-99`.
2. Copy OldUnreal dedicated server files into `game/` (so `ucc` / `ucc-bin` or `UCC.exe` is present).
3. Start the server from PlayOn (native process). Default game port is **UDP 7777**.
4. **Required — player panel:** `panel_publish` with `join_info` + `client_setup` (Multiplayer → Open → `host:7777`). Only visible while the server is starting/running.

## Players — getting the right client

UT99 on modern PCs needs a patched client, not a random CD dump:

1. Own a legitimate UT99 copy (GOG / original).
2. Install **OldUnreal 469** (or newer) patch for your platform.
3. Optional but recommended for LAN: enable the community networking fixes from OldUnreal.
4. Join via Open → enter `host:7777` (or the address shown on the PlayOn player panel).

## LAN notes

- Allow UDP **7777** (game) and **7778** (query) through the host firewall for LAN peers.
- Advertise the LAN IP on the PlayOn `/play` panel — do not assume players can guess it.
- If the process will not start, confirm `UCC.exe` (Windows) or `ucc-bin` / `ucc` (Linux) exists under `game/`.
