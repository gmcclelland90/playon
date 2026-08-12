# SteamCMD platform skill

PlayOn exposes the agent tool `steamcmd_app_update` which runs a real host SteamCMD binary into the server jail (`+login anonymous +app_update <appId> validate +quit`).

## Auto-provision (Linux)

If SteamCMD is missing, PlayOn downloads the official Linux archive into `~/steamcmd` (or `PLAYON_STEAMCMD_HOME`) and runs a bootstrap `+quit`. Set `PLAYON_STEAMCMD` to pin a specific binary. Disable with `PLAYON_STEAMCMD_AUTO=0`.

Party-box hosts should also run `infra/control-plane/linux/install-steamcmd.sh` once so the binary is warm before the first Rust/Steam game install.

Game skills that use SteamCMD (e.g. `games.rust`, app id **258550**) should list `platform.steamcmd` in `dependencies` and call `steamcmd_app_update` before native start.

## Linux (manual)

1. `curl -sqL https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz | tar -xzf - -C ~/steamcmd`
2. Export `PLAYON_STEAMCMD=$HOME/steamcmd/steamcmd.sh` (optional if using the default path).
3. Install 32-bit loader libs if needed: `sudo apt-get install -y lib32gcc-s1`.
4. From chat / tools: `steamcmd_app_update` with `serverId` + `appId`.

## Windows

1. Install SteamCMD (or set `PLAYON_STEAMCMD` to `steamcmd.exe`). Auto-download is not implemented on Windows yet.
2. Same `steamcmd_app_update` tool flow.
3. Prefer a fixed app build when hosting LAN nights for reproducibility.
