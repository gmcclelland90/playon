# Ollama offline profile

End-user setup lives on the public docs site:

**[playon.games/docs/providers/ollama](https://playon.games/docs/providers/ollama)**

## Settings (recommended)

1. Open **Settings → In-app agents**, choose **Ollama (offline)**.
2. PlayOn probes the Base URL (default `http://127.0.0.1:11434/v1`).
3. If Ollama is not reachable on this Home host and Docker is available, click **Install Ollama** — that starts a `playon-ollama` container (`ollama/ollama` on port 11434).
4. If Docker is missing, copy the shown official one-liner, install manually, then **Recheck**.
5. Use the **Model** chooser for installed tags, or **Pull** a suggested model (`llama3.2`, `qwen2.5`, `mistral`, …).
6. **Save settings**, then open Map and send a chat to verify.

One-click install only targets **localhost** on the control plane host. Remote/LAN Ollama URLs can still be probed and used; install them on that machine yourself.

## Dev / lab notes

```bash
export PLAYON_LLM_MODE=ollama
```

`pnpm loop:verify` on the lab host uses a real cloud key (Venice) + Docker — Ollama is never required for the merge bar.

Standing LLM canary (`pnpm lab:llm-canary`, #845): if Ollama is reachable on Home, also two-step-canary `llama3.2` / `qwen2.5`. If not, the report is `reachable=false` and the Venice path still passes. Do not treat a missing Ollama install as a merge-bar failure.


When you change `@playon/shared` LLM presets, regenerate site facts:

```bash
pnpm sync:llm-presets
```
