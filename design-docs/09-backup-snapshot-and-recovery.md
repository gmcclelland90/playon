# 09 – Backup, Snapshot & Recovery

## Design Imperative

Everything is built on a stable, recoverable foundation.  
Agents make changes frequently; the system must make those changes safe.

## Snapshot System

- **Automatic pre-change snapshots** before high-impact agent actions (mod installs, major config changes, updates, etc.)
- Manual snapshots on demand
- Scheduled snapshots (configurable per server or globally)
- Snapshots capture the relevant server folder state (worlds, configs, mods, etc.) efficiently

## Backup Strategies

- Local snapshots as the fast, primary safety net
- Optional off-node or external backup targets
- Retention policies (count-based, time-based, or hybrid)
- Clear differentiation between “quick snapshot” and “durable backup”

## Restore Workflows

- Agent-assisted restore: host can say “roll back the Valheim server to before the last mod install”
- Ability to restore individual components (world only, configs only, etc.) where feasible
- Verification after restore

## Integration Points

- Skills can declare what constitutes a “safe snapshot point”
- Monitor agents can trigger protective snapshots on detecting trouble
- Migration utility should create an initial baseline snapshot after import

## Goals

- Make “undo” feel cheap and reliable
- Prevent the classic “we lost the world” LAN party disaster
- Keep snapshot overhead acceptable even on larger servers
