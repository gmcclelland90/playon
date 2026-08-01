# SteamCMD platform skill

## Linux

1. Download SteamCMD into the server data directory (or a shared tools cache).
2. Run `steamcmd.sh +login anonymous +app_update <appid> validate +quit`.
3. Point the game skill at the installed dedicated server binary.

## Windows

1. Fetch `steamcmd.zip` into the server jail via `fetch_url`.
2. Extract and run `steamcmd.exe` with the same `+app_update` flow.
3. Prefer a fixed app build when hosting LAN nights for reproducibility.

This skill documents the path; game skills should call these steps explicitly.
