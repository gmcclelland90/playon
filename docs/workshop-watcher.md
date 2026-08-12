# Steam Workshop Update Watcher

The `workshop_update` trigger monitors Steam Workshop items for updates, enabling automated notifications and scheduled maintenance when mods are updated.

## Overview

This trigger periodically polls the Steam Web API to check if any configured workshop items have been updated. When an update is detected, the watcher fires with details about which items changed.

## Configuration

### Trigger Schema

```typescript
{
  kind: "workshop_update",
  workshopIds: ["3579640010"]  // Steam publishedfile IDs
}
```

### Example Watcher (NewZombieLand3 Config)

```json
{
  "name": "Workshop Update Notifier",
  "enabled": true,
  "trigger": {
    "kind": "workshop_update",
    "workshopIds": ["3579640010"]
  },
  "action": {
    "kind": "tools",
    "steps": [
      {
        "tool": "panel_publish",
        "args": {
          "title": "Workshop Mod Updated",
          "message": "ST Additions - Pry Open has been updated. Please schedule a server restart to apply changes."
        }
      }
    ]
  },
  "cooldownMs": 300000,
  "debounceMs": 60000
}
```

_Workshop ID 3579640010 is ST Additions - Pry Open (crowbar mod used in NewZombieLand3)._

## Behavior

- **Polling Interval**: Workshop items are checked every ~5 seconds (same as health/query watchers)
- **State Persistence**: Last-seen `time_updated` values are persisted in the settings table
- **First Run**: On first run, all configured workshop items are considered "new" and will not trigger (to avoid false positives on initial setup)
- **Batching**: All workshop IDs across all watchers are fetched in a single Steam API call per tick for efficiency
- **Error Handling**: Steam API failures are logged but do not crash the watcher scheduler

## Trigger Payload

When a workshop update is detected, the watcher fires with:

```typescript
{
  kind: "workshop_update",
  updated: [
    {
      workshopId: "3579640010",
      title: "ST Additions - Pry Open",
      timeUpdated: 1723456789
    }
  ]
}
```

## Recommended Actions

### Notify and Schedule Restart

The recommended pattern is to **notify** users about updates and ask them to schedule a restart, rather than auto-restarting:

```json
{
  "action": {
    "kind": "tools",
    "steps": [
      {
        "tool": "panel_publish",
        "args": {
          "title": "Workshop Mods Updated",
          "message": "One or more workshop mods have been updated. Please schedule a server restart to apply changes."
        }
      }
    ]
  }
}
```

### Agent-Assisted Planning

Use an agent action to prompt for human approval:

```json
{
  "action": {
    "kind": "agent",
    "prompt": "Workshop mods have been updated. Check if anyone is online and suggest a restart window to the admin."
  }
}
```

### Auto-Restart (Use with Caution)

If you want to auto-restart when mods update, use the `servers_restart` tool. **Ensure cooldown is high** to avoid restart loops:

```json
{
  "action": {
    "kind": "tools",
    "steps": [
      {
        "tool": "panel_publish",
        "args": {
          "message": "Mods updated. Restarting server..."
        }
      },
      {
        "tool": "servers_restart",
        "args": {}
      }
    ]
  },
  "cooldownMs": 7200000  // 2 hours minimum between restarts
}
```

## Steam Web API

This feature uses the public `ISteamRemoteStorage/GetPublishedFileDetails` endpoint, which does not require a Steam Web API key. If rate limiting becomes an issue, you can optionally provide a key via the `STEAM_WEB_API_KEY` environment variable.

## Limitations

- Workshop items must be public and not removed from the Steam Workshop
- The `time_updated` field from Steam may not always reflect content changes (metadata updates also increment it)
- No automatic detection of workshop items from server config (you must manually specify IDs)

## Future Enhancements

- Auto-detect workshop IDs from Project Zomboid `WorkshopItems` config
- Per-server Steam API key configuration
- Changelog/diff extraction from workshop updates
