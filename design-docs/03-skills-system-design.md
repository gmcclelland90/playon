# 03 – Skills System Design

## Purpose

Skills are the encoded knowledge and capabilities that let agents manage specific games and common hosting tasks reliably.

## Two Tiers

### Global Skills
Shared across the installation:
- General server lifecycle management
- Container patterns and best practices
- Common modding workflows
- Monitoring, networking, RCON helpers
- Backup/snapshot orchestration helpers
- Cross-game utilities

### Server / Game-Specific Skills
Live inside the individual server folder (or a dedicated skills subfolder):
- Exact install & update procedures for that game
- Preferred runtime (Docker image, compose file, systemd unit, etc.)
- Config templates and validation rules
- Mod installation conventions and dependency handling
- Health checks and known failure modes
- RCON / admin command reference
- Templates for player-facing content

## Skill Package Structure (Draft)

A skill is a directory/package containing:

1. **metadata.yaml** (or .json)  
   - name, version, game, supported versions, os/arch requirements  
   - container support level (full / partial / none)  
   - required tools, ports, dependencies  
   - description and tags

2. **guides/**  
   Markdown (or similar) documents that agents read for reasoning:  
   - INSTALL.md, MODDING.md, TROUBLESHOOTING.md, PLAYER_SETUP.md, etc.

3. **scripts/**  
   Deterministic executable helpers (bash, Python, PowerShell…) that agents can invoke.

4. **templates/**  
   Config file templates, Dockerfiles, compose files, systemd units, etc.

5. **tests/** (optional but recommended)  
   Simple validation steps the agent can run after making changes.

6. **tools.md** or equivalent  
   Declares which tools this skill expects the agent to have available.

## Lifecycle

- Install / update skill (global or per-server)
- Override global skill behaviour at server level
- Promote a well-tested server skill to global
- Versioning and basic dependency declaration between skills

## Auto-Drafting Policy

Agents *can* research and draft new skills when a game is missing.  
This capability should **not** be overly aggressive:

- Prefer explicit user trigger (“research and draft a skill for Game X”)
- Drafts are clearly marked and require human review before becoming permanent
- Drafts can be used immediately in a temporary capacity with clear warnings

## Design Goals for Skills

- Readable by both humans and agents
- Mix of declarative metadata + procedural knowledge + executable scripts
- Easy to version, share, and improve over time
- Encourage community contribution later
