# LLM model compatibility matrix

Standing evidence that the in-app agent still tool-calls on cheaper Venice models and on Ollama when present. Parent tracker: [#836](https://github.com/gmcclelland90/playon/issues/836). Two-step canary: [#845](https://github.com/gmcclelland90/playon/issues/845).

Companion: [testing-plan.md](testing-plan.md), [automations.md](automations.md), [ollama-offline.md](ollama-offline.md).

## How the canary runs

| Mode | Command | Mutates Home? | Role |
|------|---------|---------------|------|
| In-process | `pnpm lab:llm-canary` | No | Merge-bar / agent verify. Disposable orchestrator tools only. |
| Home API | `pnpm lab:llm-canary --home` | Yes, temporarily | Playon Ops `llm-model-compat` (Mon/Thu). `PUT /api/settings/llm` → `POST /api/chat` on `lab-llm-canary`. |
| Heal leftovers | `pnpm lab:llm-canary --restore-only` / `--teardown-only` | Restore / delete only | Ops remediation if a prior run crashed. |

Home path rules:

- Snapshot Settings **before** the first model PUT. Persist to `tmp/lab-llm-canary-restore.json` (crash-safe).
- Restore in `finally` with retry + GET verify (`preset` + `provider` + `model`). Never send `apiKey`.
- If persist exists and Home differs, restore persist first (heal a crashed run).
- If persist is missing and Home is still on a probe leftover (`llama-3.3-70b`, cheap/mid matrix, Gemma, …), heal to `venice` / `grok-4-6` (`PLAYON_LLM_CANARY_RESTORE_*`). This does **not** change the Settings preset default in code.
- Teardown deletes only `lab-llm-canary*` (name or id). 404 is success. Friend / NZL / Hub / Frontier names are refused.
- Ollama `reachable=false` does not fail Venice.
- Do not blocklist Gemma ([#838](https://github.com/gmcclelland90/playon/issues/838) / [#840](https://github.com/gmcclelland90/playon/issues/840)).
- Never friend live servers.

Default Home Venice matrix (skips production `grok-4-6`): `llama-3.2-3b`, `qwen3-5-9b`, `mistral-small-3-2-24b-instruct`, `llama-3.3-70b`.

## Filing policy

`pnpm lab:file-issues --from llm-canary` files **product** tool-call failures only:

| Class | Examples | File issue? |
|-------|----------|-------------|
| product | `mutating_tool`, `friend_server`, `non_lab_target`, fake tool JSON as text, empty function name | Yes |
| degraded | `partial_trace` / `need_two_tools` on cheap models | No — document here |
| flake | `disconnect`, empty `toolTrace`, HTTP 5xx, timeout, restore/teardown infra | No — fail the canary process if restore/teardown broke; do not open a model bug |

## Recorded matrix

Production Home default during these runs: Venice `grok-4-5` (through 2026-08-13) then `grok-4-6` (from 2026-08-27). NZL / Hub / Frontier were never targeted.

### 2026-08-12 — first popular-models smoke (Home API)

| Model | Result | Notes |
|-------|--------|-------|
| grok-4-5 | PASS | baseline |
| llama-3.2-3b | PASS | ~3B tool-call OK |
| qwen3-5-9b | PASS | ~9B OK |
| mistral-small-3-2-24b-instruct | PASS | |
| llama-3.3-70b | SOFT FAIL | tools ran; 1× `servers_query` error; answer still correct |
| qwen3-6-27b | PASS | slower (~21s) |
| google-gemma-3-27b-it | FAIL | fake tool JSON as text → [#838](https://github.com/gmcclelland90/playon/issues/838) |
| deepseek-v4-flash | PASS | |
| openai-gpt-4o-mini-2024-07-18 | PASS | |
| qwen3-next-80b | PASS | |
| kimi-k2-5 | PASS | |
| zai-org-glm-4.7-flash | PASS | |

Ollama: `reachable=false` (Docker available, not installed on Home).

### 2026-08-13 — Thu canary + Ollama lab

Home API (in-app fallback). Restored `venice` / `grok-4-5`. `lab-llm-canary` torn down.

- llama-3.2-3b / qwen3-5-9b: native `servers_list`, no two-step (degraded, not filed)
- google-gemma-3-27b-it: no native function-calling (see #838)
- llama-3.3-70b: two-step PASS
- Ollama on playon-dev: `llama3.2` 3B fail (no native tools); `qwen2.5` 7B two-step PASS

### 2026-08-27 — Thu canary (skipped default grok-4-6)

| Model | Result | Notes |
|-------|--------|-------|
| llama-3.2-3b | PASS | toolTrace 2, `servers_list` ×2 |
| qwen3-5-9b | PASS | toolTrace 2, `servers_list` ×2 |
| mistral-small-3-2-24b-instruct | FAIL | HTTP 502; Venice 400 empty function name (later recovered) |
| llama-3.3-70b | PASS | toolTrace 5, `servers_list` → `servers_get` |

Ollama: `reachable=false`. Home restored to `venice` / `grok-4-6`. Fixture torn down.

### 2026-09-07 — Mon canary (restore/teardown incident)

| Model | Result | Class | Notes |
|-------|--------|-------|-------|
| mistral-small-3-2-24b-instruct | PASS | ok | Mid-size Venice recovered vs 2026-08-27 |
| llama-3.2-3b | FAIL | degraded | `partial_trace` — cheap model skipped the follow-up (same class as 2026-08-13) |
| qwen3-5-9b | FAIL | degraded | `partial_trace` — not filed |
| llama-3.3-70b | FAIL | flake | disconnect / empty `toolTrace` — transport, not a prompt bug |

Ollama: `reachable=false` (does not fail Venice).

**Infra:** restore verify false-positive left Home on `venice` / `llama-3.3-70b`; teardown false-positive left `lab-llm-canary` fixtures. Ops remediates back to `venice` / `grok-4-6`. The `--home` runner now persists the snapshot, GET-verifies restore, treats 404 as teardown success, and heals leftover probe models.

## Product follow-ups

| Symptom | Issue | Notes |
|---------|-------|-------|
| Gemma emits fake tool JSON as text | [#838](https://github.com/gmcclelland90/playon/issues/838) | Do not blocklist; recover text-tool emission ([#840](https://github.com/gmcclelland90/playon/issues/840)) |
| Cheap Venice sometimes one-step only | none | Documented degraded; do not file per-run |
| llama-3.3-70b disconnect / empty trace | none | Canary flake; retry / next Mon/Thu |
| Missing Ollama on Home | none | `reachable=false` is expected until installed |

Prefer a capable local tag (`qwen2.5`) when Ollama is present ([#945](https://github.com/gmcclelland90/playon/issues/945)).
