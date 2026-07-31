# 08 – Identity, Roles & Access Control

## Context

While the primary persona is a single LAN host, real events frequently involve multiple organisers.  
The system therefore supports multiple administrative users with clear roles.

## Roles (Initial Set)

| Role       | Capabilities |
|------------|--------------|
| **Owner**  | Full control. Manage users, nodes, global skills, system settings, billing/backend config if any. |
| **Admin**  | Create and manage servers, talk to agents, push to player panel, manage backups for their servers. |
| **Operator** | Limited operational control: start/stop, view logs, basic status, restricted mod actions. |
| **Player** | Access only to the player-facing panel. No admin chat or server controls. |

Roles should be extensible later.

## Authentication

- Local accounts as the baseline
- Optional external identity providers / SSO in later iterations
- Session management appropriate for a trusted LAN environment (with the ability to tighten for more exposed deployments)

## Permissions & Scoping

- Actions are authorised against the user’s role
- Agents executing on behalf of a user inherit that user’s effective permissions
- Server ownership / visibility can be refined (e.g. Admins see all vs only servers they created)

## Auditability

Every significant agent action should be attributable to a user (or to “system”).  
Logs should support answering “who asked for this change?”

## Design Notes

- Keep the model simple for v1
- Favour explicit roles over complex ACL graphs initially
- Player role is intentionally very limited — the player panel is the entire surface
