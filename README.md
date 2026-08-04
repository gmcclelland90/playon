# PlayOn

AI-driven game server control plane for LAN parties.  
[playon.games](https://playon.games)

## Quick start

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
2. Create the **Owner** account, save a Venice API key under **Settings**, then ask to start a game.  
3. Players open `/play` on that host (shown in the UI).

No separate Node.js or pnpm install. Always-on: `PLAYON_SERVICE=1` (see **[docs/deploy.md](docs/deploy.md)**).

Manual zip / USB: [GitHub Releases](https://github.com/gmcclelland90/playon/releases) → `Start-PlayOn.ps1` / `./start-playon.sh`.

Maintainers / CI:

```bash
pnpm build && pnpm package:home
# → dist-home/playon-home-<version>-windows-x64.zip
# → dist-home/playon-home-<version>-linux-x64.tar.gz
node scripts/sync-install-scripts.mjs   # → playon-games/public (when sibling present)
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
