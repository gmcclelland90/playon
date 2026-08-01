# Windows native stub

Hermetic reference skill for the native process supervisor.

## Behaviour

1. Create a server from `games.windows-native-stub`.
2. On start (future native runtime wiring), PlayOn runs a short-lived stub process in the server data directory.
3. Until native start is fully wired for this skill, mock runtime still creates the directory layout and can publish panel blocks.

## Panel

Publish:

- `join_info` with port `9090`
- `server_status`
- `client_setup` noting this is a stub, not a real game
