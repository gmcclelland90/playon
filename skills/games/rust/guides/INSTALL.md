# Rust dedicated server (SteamCMD)

This skill depends on `platform.steamcmd` and `platform.native-process`.

## Install

1. Create a server from `games.rust`.
2. Run `steamcmd_app_update` with `appId: 258550` (anonymous login) into the server jail.
3. Confirm `game/RustDedicated` (Linux) or `game/RustDedicated.exe` (Windows) exists.
4. Optional: agent-written `game/start.sh` is preferred on Linux when present.
5. `servers_start`.
6. **Required — player panel:** `panel_publish` with `join_info` + `client_setup` (F1 `client.connect host:28015`, Steam deep link when available). Panel is only visible while the server is starting/running.

## Defaults

- Game UDP **28015**, RCON TCP **28016** (`+rcon.web 1`)
- Default RCON password in the built-in launch args is a placeholder — change before any non-LAN exposure
- Identity `rust1`, world size `3000` — adjust in `start.sh` for real parties

## Capacity

Plan on **≥8 GB RAM** for a small friend group; more map size / players needs more RAM. Prefer not to co-locate with other heavy survival titles on a small party box.

## Player join

- Same Steam branch as the host
- In-game F1: `client.connect <advertiseHost>:28015`
- Panel may offer a `steam://run/252490//+connect%20…` deep link (client app 252490)

## Next steps (not required for first join)

- Oxide / Carbon plugins
- Wipe / seed / identity policy for recurring LAN nights
- Snapshot before map wipes
