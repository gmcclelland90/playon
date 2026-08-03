# 01 – Product Vision & Goals

## Vision Statement

PlayOn is a self-hosted, AI-agent-driven control plane for dedicated game servers.  
It turns the traditionally painful process of installing, configuring, modding, and managing game servers into a conversational, reliable, and even fun experience — optimised for LAN parties and spontaneous multiplayer sessions.

Instead of fighting web panels or editing configs by hand, the host talks to a single agent that already knows how to run the game. Players get a clean, always up-to-date panel with join links, required files, guides, and more.

## Core Problem

- Setting up dedicated servers (especially modded or less-common games) is slow and error-prone.
- LAN parties waste valuable game time on configuration.
- Traditional game hosting panels still require significant manual work and knowledge.
- Players often struggle with client-side setup for more complex multiplayer games.

## Primary Personas

1. **LAN Host / Primary Admin**  
   The person organising the event. Wants maximum game time, minimum friction. Uses natural language to spin servers up and keep them healthy.

2. **Co-Organisers / Secondary Admins**  
   Friends helping run the LAN. Need appropriate access levels without full owner powers.

3. **Players**  
   Just want to join games quickly. Interact only with the player-facing panel.

## Key Differentiators

- **Conversation-first** management (Cursor-like experience for game servers)
- **Skills system** that encodes deep, game-specific knowledge
- **Agent-pushed Player-Facing Panel** that makes complicated multiplayer games accessible
- **Container-first** runtime with pragmatic native fallbacks
- **Strong offline / local LLM support**
- **Heavy gamification** of the management experience itself
- **Robust backup & snapshot** foundation
- Easy migration of existing servers

## Success Metrics (Examples)

- Time from “let’s play X” to joinable server (target: minutes, not hours)
- Percentage of common failure modes auto-resolved by agents
- Player join success rate / support questions reduced
- Host satisfaction / “this was actually fun to manage”

## Non-Goals (v1)

- Becoming a full commercial game hosting provider
- Supporting every obscure game on day one
- Replacing the need for any human oversight on critical production servers
- Building a general-purpose infrastructure platform unrelated to games

## Design Principles

1. Maximise actual game time
2. Conversation over configuration
3. Containerisation where possible, flexibility where necessary
4. Safety through scoping and snapshots
5. Make the serious work of server management feel playful
6. Offline-capable by design
7. Player experience is a first-class concern
