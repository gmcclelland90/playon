# Ollama offline profile

End-user setup lives on the public docs site:

**[playon.games/docs/providers/ollama](https://playon.games/docs/providers/ollama)**

## Dev / lab notes

```bash
export PLAYON_LLM_MODE=ollama
```

`pnpm loop:verify` on the lab host uses a real cloud key (Venice) + Docker — Ollama is never required for the merge bar.

When you change `@playon/shared` LLM presets, regenerate site facts:

```bash
pnpm sync:llm-presets
```
