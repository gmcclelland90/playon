# 17 – MCP & External Agents

## Intent

PlayOn offers one shared tool registry to every agent entry point:

1. **Canvas + Venice** (cloud OpenAI-compatible)
2. **Canvas + local Ollama**
3. **External agents via MCP** (Claude Code, Codex, Cursor, etc.)

Only the reasoner and transport change. Tool names, JSON schemas, handlers, path jail, workspace binding, and confirm gates must not fork per backend or per transport.

## Modes

| Entry | Who reasons | Credential on PlayOn | Tool path |
|-------|-------------|----------------------|-----------|
| Canvas + Venice | In-app orchestrator | Venice API key | LLM tool_calls → registry |
| Canvas + Ollama | In-app orchestrator | Ollama URL (no Venice key) | LLM tool_calls → same registry |
| MCP client | External agent | PlayOn access token (PAT) | MCP tools/call → same registry |

Operators do not need Venice configured to use Ollama or MCP.

## Surface

- HTTP MCP endpoint on the control plane: `/mcp` (Streamable HTTP)
- Optional stdio bridge (`playon-mcp`) for clients that only speak local stdio
- PATs minted in Settings; hashed at rest; optional `autoApproveConfirms`
- Confirm-gated tools default to the existing Canvas host confirm flow

## Non-goals

- Replacing Canvas / in-app personas
- A second tool catalog for MCP
- Player-facing MCP
- Multi-tenant public MCP hosting
