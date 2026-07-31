# 11 – LLM Backend & Offline Support

## Goals

- Work well with strong cloud models
- Remain fully usable offline or on air-gapped / low-connectivity LANs via local models
- Give the host clear control over which backend is used

## Supported Backends

- Major cloud providers and OpenAI-compatible endpoints
- Local runtimes, with first-class support for Ollama and similar tools
- Ability to configure different backends per installation or even per agent/role if desired

## Offline / Local Considerations

- Skills, prompts, and agent behaviour should degrade gracefully with smaller/weaker local models
- Critical deterministic work should prefer scripts and tools over pure LLM generation where reliability matters
- Clear UI indication of which backend is active and its approximate capability level

## Configuration

- Simple global default
- Optional overrides
- Easy testing of different models against the same skills

## Design Principle

Intelligence is pluggable.  
The rest of the system (skills, tools, snapshots, player panel) should not assume a particular model vendor or capability tier.
