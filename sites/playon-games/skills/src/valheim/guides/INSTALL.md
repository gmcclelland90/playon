# Valheim dedicated server (SteamCMD)

Depends on `platform.steamcmd` and `platform.native-process`.

## Install

1. Create a server from `games.valheim`.
2. `steamcmd_app_update` with **appId 896660** (anonymous) into the server jail.
3. Write `game/start.sh` (Linux) that launches `valheim_server.x86_64` with:
   - `SteamAppId=892970` in the environment (**game** id, not 896660)
   - `-nographics -batchmode -name … -port 2456 -world … -password … -public 0` for LAN
4. Password rules: **≥5 characters**, must not be contained in / identical to the server name.
5. Open **UDP 2456–2457** (2458 if using crossplay).
6. `servers_start`.
7. **Required — player panel:** `panel_publish` join_info + client_setup (Steam → Join IP → `host:2456`, password reminder without putting the password on the panel unless the host wants it). Visible only while starting/running.

## Join (LAN)

- Steam → Join IP → `advertiseHost:2456`
- Same Valheim branch as clients
- Keep `-public 0` unless you intentionally want community listing

## Docker note

Community image `lloesche/valheim-server` / `ghcr.io/lloesche/valheim-server` is a solid alternate path (needs config + data volumes). This skill’s first path is SteamCMD + `start.sh` so it matches the Rust/SteamCMD platform pattern. Prefer Docker only when the host already standardizes on that image.

## Capacity

Plan **≥4 GB RAM** (8 GB happier). Snapshot worlds before updates or wipes.

## Mods

Thunderstore / BepInEx later — keep first join vanilla.
