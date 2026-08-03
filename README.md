# PlayOn

AI-driven game server control plane for LAN parties.  
[playon.games](https://playon.games)

## Quick start

### LAN host (production)

See **[docs/deploy.md](docs/deploy.md)** — native Home install (no Docker required), optional Docker panel, LAN nodes, Vultr.

```bash
pnpm build && pnpm package:home
# Linux: extract dist-home/playon + sudo bash deploy/install.sh
```

### Developers

Needs Node.js 22+ and pnpm 9+.

```bash
pnpm install
pnpm verify
pnpm dev
```

| Surface | URL |
|---------|-----|
| Web UI | http://127.0.0.1:5173 |
| API | http://127.0.0.1:8787 |
| Player panel | http://127.0.0.1:5173/play |

1. Open the UI and create the **Owner** account.  
2. Go to **Settings** → choose provider (`OpenAI-compatible` or `Ollama`), paste API key if needed, set model, save.  
3. Chat: ask to spin up a game (Paper needs Docker; Rust/SteamCMD works with `PLAYON_RUNTIME=native`).  
4. Players use **/play** for join info.

## Workspace

| Path | Role |
|------|------|
| `apps/web` | Admin chat, servers, settings, player panel |
| `apps/api` | Control plane |
| `apps/node-agent` | Host heartbeat / future tool executor |
| `packages/*` | Shared schemas, agent-core, runtime |
| `skills/` | Global + fixture skills |
| `design-docs/` | Product design |

See [AGENTS.md](AGENTS.md) for the coding-agent contract.
