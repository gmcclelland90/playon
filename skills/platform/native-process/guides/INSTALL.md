# Native process supervisor

Use when a game cannot run in Docker (common on Windows for some dedicated servers).

## Tools

PlayOn's runtime exposes a process supervisor that:

1. Spawns a command with a jailed working directory under the server data path
2. Tracks PID / status
3. Stops the process cleanly

## Skill authors

Declare `containerSupport: none` and document the exact binary + args in this guide. Prefer absolute paths under the server data directory after install.
