# 12 – Security & Safety Model

## Core Principles

- Least privilege
- Strong scoping of agent capabilities
- Snapshots before risky changes
- Clear attribution of actions
- Defence in depth even on a trusted LAN

## Filesystem & Process Scoping

- Agents receive filesystem access only to the target server directory and the global skills store (read-mostly).
- Process and service control is limited to resources belonging to managed servers.
- No unconstrained root or host-wide access by default.

## Container & Node Isolation

- Prefer containers for workload isolation.
- Nodes should be treated as semi-trusted execution environments.
- Network exposure is deliberate and visible to the host.

## Secrets Handling

- RCON passwords, API keys, and similar secrets are stored securely and injected only when needed.
- Agents should avoid echoing secrets into logs or the player panel.

## Agent Guardrails

- High-impact actions (deletes, major version changes, restores, etc.) should trigger confirmation or rely on recent snapshots.
- Agents are expected to surface uncertainty instead of hallucinating critical operations.
- Tool results are the source of truth; agents reason over them rather than inventing state.

## Multi-User Considerations

- Permissions are enforced at the role level (see Identity document).
- Actions are attributed to the initiating user.

## Future Escape Hatch

For the rare games that truly require GUI interaction or proprietary launchers, a “computer-use” style agent operating inside a dedicated, isolated VM may be considered later.  
This is explicitly out of scope for early versions and must remain tightly controlled.

## Overall Stance

The system is designed for a high-trust LAN environment but should still follow good security hygiene so it can grow into more exposed deployments without a complete redesign.
