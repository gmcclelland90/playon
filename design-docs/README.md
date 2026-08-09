# PlayOn Design Documents

**Product:** PlayOn · [playon.games](https://playon.games)

This pack contains the high-level software design documents for an AI-powered, agent-driven game server hosting panel.

The system is designed primarily for LAN parties and rapid multiplayer setup, with a conversation-first admin experience, a rich player-facing panel, strong preference for containerisation, robust backups, offline LLM support, and heavy gamification.

## Document Index

| # | Document | Description |
|---|----------|-------------|
| 01 | [Product Vision & Goals](01-product-vision-and-goals.md) | North-star vision, host/player personas, success metrics, non-goals |
| 02 | [System Architecture Overview](02-system-architecture-overview.md) | High-level components, topology, data isolation |
| 03 | [Skills System Design](03-skills-system-design.md) | Global vs server game skills, package structure, lifecycle |
| 04 | [Agent System Design](04-agent-system-design.md) | Single agent, tools, conversation model, agent-skill XP |
| 05 | [Runtime & Node Management](05-runtime-and-node-management.md) | Docker-first, native fallback, multi-node, IaC |
| 06 | [Player-Facing Panel Design](06-player-facing-panel-design.md) | Agent-pushed content model for players |
| 07 | [Admin Interface & Gamification](07-admin-interface-and-gamification.md) | Map + chat UX, one agent sprite, skill bars |
| 08 | [Identity, Roles & Access Control](08-identity-roles-and-access-control.md) | Multi-user roles, permissions, audit |
| 09 | [Backup, Snapshot & Recovery](09-backup-snapshot-and-recovery.md) | Data safety, snapshots, restore flows |
| 10 | [Migration & Import Utility](10-migration-and-import-utility.md) | Bringing existing servers under management |
| 11 | [LLM Backend & Offline Support](11-llm-backend-and-offline-support.md) | Cloud + local (Ollama) backends |
| 12 | [Security & Safety Model](12-security-and-safety-model.md) | Scoping, isolation, guardrails |
| 13 | [Extensibility & Roadmap](13-extensibility-and-roadmap.md) | Future ideas and parking lot |
| 14 | [Per-Server Compute Placement](14-cloud-backed-lan-mode.md) | Add-node (LAN + cloud BYO), WireGuard + Home LAN gateway; vendor Connect deferred |
| 15 | [playon.games site & skill library](15-playon-games-site-and-skill-library.md) | Sibling `playon-games` owns all games.*; monorepo/Home are platform-only |
| 16 | [Live Server Query](16-live-server-query.md) | Uniform live stats (GameQ-style), built-in dialects, agent-authored skill connectors |
| 17 | [MCP & External Agents](17-mcp-and-external-agents.md) | Same tool registry via Venice, Ollama, or MCP; PATs for external agents |
| 18 | [Watchers](18-watchers.md) | Scheduled / event-driven automations that wake Monitor tools or agent turns |
| 19 | [Windows WSL2 Linux runtime](19-wsl-linux-runtime.md) | Optional WSL-backed `local-wsl` node so Windows Home can run linux-only skills |

## How to Use

These documents are intentionally high-level starting points.  
Open them in Cursor (or any editor) and iterate, expand schemas, add sequence diagrams, refine interfaces, etc.

Suggested reading / expansion order:
1. Vision
2. Architecture
3. Skills + Agents
4. Runtime
5. Player Panel + Admin UX
6. The rest as needed

---

*Generated as a design pack – ready for further planning and implementation.*
