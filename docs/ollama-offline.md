# Ollama offline profile

Use a local model when the LAN has no cloud API access.

## Setup

1. Install [Ollama](https://ollama.com) and pull a model, e.g. `ollama pull llama3.2`.
2. Confirm the OpenAI-compatible endpoint: `http://127.0.0.1:11434/v1`.
3. In PlayOn → **Settings → In-app agents (LLM provider)**:
   - Provider: **Ollama (offline)**
   - Base URL: `http://127.0.0.1:11434/v1` (editable if Ollama is on another LAN host)
   - Model: `llama3.2` (or your pull)
   - API key: leave empty unless your proxy requires one
4. Save, then open Map and send a chat to verify.

## Other providers

The same Settings form supports Venice, OpenAI, Anthropic, Gemini, OpenRouter, Groq, DeepSeek, NVIDIA, and a custom OpenAI-compatible base URL. Cloud presets need the host’s own API key — nothing is bundled.

## Dev defaults

```bash
export PLAYON_LLM_MODE=ollama
```

`pnpm loop:verify` on the lab host uses a real cloud key (Venice) + Docker — Ollama is never required for the merge bar.

## Notes

- Tool calling quality varies by model; prefer models with function-calling support.
- High-impact tools still require host Confirm in the UI regardless of model.
