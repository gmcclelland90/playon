# 13 – Extensibility & Roadmap

## Near-Term Extensibility

- New games are added primarily by creating skills (seeded as library-ready `.skill.zip` packages)
- Platform skills stay in the core bundle; game skills are catalog/library content (see [15](15-playon-games-site-and-skill-library.md))
- Community skill sharing (export/import packages) as a natural next step; hosted library on playon.games is a separate site track
- New agent-skill XP tracks or map flair can extend gamification without splitting the chat agent
- New content block types for the player-facing panel

## Medium-Term Ideas

- Shared “LAN Party Mode” across multiple physical locations or more advanced node federation
- Richer AI Director / narrative systems for games that expose sufficient hooks
- Deeper integration with game-specific admin protocols beyond basic RCON
- Automated client-side helper tools or lightweight launchers coordinated via the player panel
- More sophisticated voting, matchmaking hints, and session orchestration

## Longer-Term / Exploratory

- “Computer use” agents inside isolated VMs for stubborn proprietary launchers
- Cross-game player identity / simple progression tracking for recurring LAN groups
- Public or semi-public skill registries
- Advanced analytics and historical insights across events

## Design Philosophy for Growth

- Keep the core (skills + scoped agents + snapshots + player panel) stable
- Prefer additive extension over breaking changes
- Let real LAN party usage drive prioritisation

## Parking Lot

Ideas that are interesting but explicitly not committed:

- Full commercial multi-tenant hosting product
- Mobile-native admin apps
- Deep OS-level integration beyond containers and services
- Real-time collaborative editing of skills by multiple admins
- **Per-server compute placement** — Local (install host) / Remote (LAN node) / Cloud (nearby VPS + LAN tunnel); mixed homes in one party (see [14](14-cloud-backed-lan-mode.md))

---

This document is intentionally a living parking lot.  
Update it as the project evolves.
