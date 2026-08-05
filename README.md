# PlayOn

AI-driven game server control plane for LAN parties.  
[playon.games](https://playon.games)

## Quick start

Host setup guides live on the site: **[playon.games/docs/quick-start](https://playon.games/docs/quick-start)** (providers, MCP for Cursor / Claude / OpenClaw / Hermes, players, skills).

### LAN host (recommended)

One line — fetches the latest Home release and starts PlayOn ([playon.games/get](https://playon.games/get)):

```powershell
# Windows (PowerShell)
irm https://playon.games/install.ps1 | iex
```

```bash
# Linux
curl -fsSL https://playon.games/install | bash
```

1. Browser opens the admin UI.  
2. Create the **Owner** account, then either paste an LLM key under **Settings** or connect an external agent via MCP ([docs](https://playon.games/docs/mcp)).  
3. Optional: **Settings → Nodes** — host games on this machine and/or **Add a node** (LAN spare or any cloud VPS; WireGuard is configured for you).  
4. Ask chat (or your MCP agent) to start a game; players open `/play` on that host.

No separate Node.js or pnpm install. Always-on: `PLAYON_SERVICE=1` (see **[docs/deploy.md](docs/deploy.md)**).

Manual zip / USB: [GitHub Releases](https://github.com/gmcclelland90/playon/releases) → `Start-PlayOn.ps1` / `./start-playon.sh`.

Maintainers / CI:

```bash
pnpm build && pnpm package:home
# → dist-home/playon-home-<version>-windows-x64.zip
# → dist-home/playon-home-<version>-linux-x64.tar.gz
node scripts/sync-install-scripts.mjs   # → playon-games/public (when sibling present)
pnpm sync:llm-presets                 # → playon-games docs preset facts (when sibling present)
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
2. Go to **Settings** → pick a provider (Venice, NVIDIA, OpenAI, Ollama, …), paste your API key if needed, set model, save — or mint an MCP token for an external agent.  
3. Optional: **Settings → Nodes** to add LAN/cloud capacity ([nodes guide](https://playon.games/docs/nodes)).  
4. Chat (or MCP): ask to spin up a game (Paper needs Docker; Rust/SteamCMD works with `PLAYON_RUNTIME=native`).  
5. Players use **/play** for join info.

End-user docs: [playon.games/docs](https://playon.games/docs). Ops/lab notes stay in [`docs/`](docs/).

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
