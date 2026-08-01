# Ollama offline profile

Use a local model when the LAN has no cloud API access.

## Setup

1. Install [Ollama](https://ollama.com) and pull a model, e.g. `ollama pull llama3.2`.
2. Confirm the OpenAI-compatible endpoint: `http://127.0.0.1:11434/v1`.
3. In PlayOn → Settings → Model settings:
   - Provider: `ollama`
   - Base URL: `http://127.0.0.1:11434/v1`
   - Model: `llama3.2` (or your pull)
   - API key: leave empty unless your proxy requires one

## Dev defaults

```bash
export PLAYON_LLM_MODE=ollama
```

CI and `pnpm loop:verify` stay on **mock** — Ollama is never required for the autonomous merge bar.

## Notes

- Tool calling quality varies by model; prefer models with function-calling support.
- High-impact tools still require host Confirm in the UI regardless of model.
