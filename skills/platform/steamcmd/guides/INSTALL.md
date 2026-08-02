# SteamCMD platform skill

PlayOn exposes the agent tool `steamcmd_app_update` which runs a real host SteamCMD binary into the server jail (`+login anonymous +app_update <appId> validate +quit`).

If SteamCMD is missing, the tool fails with `steamcmd_not_found` (set `PLAYON_STEAMCMD` to the binary path, or install SteamCMD on PATH).

## Linux

1. Install SteamCMD system-wide, or download into a known path and export `PLAYON_STEAMCMD=/path/to/steamcmd.sh`.
2. From chat / tools: `steamcmd_app_update` with `serverId` + `appId`.
3. Point the game skill at the installed dedicated server binary under `game/`.

## Windows

1. Install SteamCMD (or set `PLAYON_STEAMCMD` to `steamcmd.exe`).
2. Same `steamcmd_app_update` tool flow.
3. Prefer a fixed app build when hosting LAN nights for reproducibility.
