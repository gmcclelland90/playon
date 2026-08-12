# Capacity (party box)

LAN hosts often run **more than one** game. Skills may declare `minRamMb` — treat it as a soft floor.

## Before `servers_start`

1. `servers_list` — note already running titles.
2. Sum rough RAM: use each skill’s `minRamMb` (from `skill_list`) plus ~2 GB for the OS/PlayOn.
3. If the host is tight, warn and ask which server to stop — do not silently OOM the party.

## Rough floors (guide, not law)

| Class | Typical minRamMb |
|-------|------------------|
| Lightweight (Terraria, Factorio early) | 1024–2048 |
| Minecraft Paper (small LAN) | 2048+ |
| Valheim | 4096+ |
| Rust / Palworld / Enshrouded | 8192–16384 |

## Disk

- SteamCMD games and Docker images are large — check free disk before `steamcmd_app_update` / first pull.
- Snapshots multiply world size; keep retention modest (`platform.snapshot-policy`).

## CPU

Most dedicated servers are **single-thread tick** heavy. More cores help run *multiple* servers, not one Minecraft tick.
