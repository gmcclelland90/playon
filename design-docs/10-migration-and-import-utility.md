# 10 – Migration & Import Utility

## Purpose

Remove the biggest adoption friction: people already have servers.  
They should be able to bring those servers under AgentHost management with minimal pain.

## Core Flow

1. Host points the agent at an existing source (FTP/SFTP, local path, rsync target, etc.).
2. System performs a carbon-copy import into a new (or specified) server folder.
3. Game type is detected where possible.
4. An initial server-specific skill is scaffolded (or an existing matching skill is attached).
5. Baseline snapshot is taken.
6. Agent verifies the imported server can be started and managed.
7. Host is given a clear report of what was imported and any manual follow-up needed.

## Capabilities

- Support for common transfer methods
- Handling of both stopped and (carefully) running servers
- Preservation of worlds, configs, and mods
- Generation of initial metadata and skill stubs
- Post-import health check and agent takeover

## Design Goals

- Make the import feel like a first-class, reliable feature rather than a hacky script
- Reduce the “I already have this working, I don’t want to start over” objection
- Produce a clean, manageable server at the end of the process

## Future Enhancements

- Incremental / sync-style imports
- Import from other popular game hosting panels
- Bulk import of multiple servers
