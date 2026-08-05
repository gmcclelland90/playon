/** Curated OpenAI-compatible LLM presets for Settings. */

export const LLM_PRESET_IDS = [
  "venice",
  "openai",
  "anthropic",
  "gemini",
  "openrouter",
  "groq",
  "deepseek",
  "nvidia",
  "ollama",
  "custom",
] as const;

export type LlmPresetId = (typeof LLM_PRESET_IDS)[number];

export type LlmTransport = "openai_compatible" | "ollama";

export type LlmPreset = {
  id: LlmPresetId;
  label: string;
  transport: LlmTransport;
  /** Empty for custom (user must supply). */
  baseUrl: string;
  defaultModel: string;
  suggestedModels: string[];
  requiresApiKey: boolean;
  apiKeyLabel: string;
  /** Base URL is editable in the UI (custom + local Ollama). */
  baseUrlEditable: boolean;
  docsHint?: string;
  /** Public setup guide on playon.games */
  docsPath?: string;
};

export const LLM_PRESETS: Record<LlmPresetId, LlmPreset> = {
  venice: {
    id: "venice",
    label: "Venice",
    transport: "openai_compatible",
    baseUrl: "https://api.venice.ai/api/v1",
    defaultModel: "llama-3.3-70b",
    suggestedModels: [
      "llama-3.3-70b",
      "qwen3-235b-a22b-instruct-2507",
      "venice-uncensored-1-2",
    ],
    requiresApiKey: true,
    apiKeyLabel: "Venice API key",
    baseUrlEditable: false,
    docsPath: "/docs/providers/venice",
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    transport: "openai_compatible",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4.1",
    suggestedModels: ["gpt-4.1", "gpt-4.1-mini", "gpt-4o"],
    requiresApiKey: true,
    apiKeyLabel: "OpenAI API key",
    baseUrlEditable: false,
    docsPath: "/docs/providers/openai",
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    transport: "openai_compatible",
    baseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-5",
    suggestedModels: ["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5"],
    requiresApiKey: true,
    apiKeyLabel: "Anthropic API key",
    baseUrlEditable: false,
    docsHint: "Uses Anthropic’s OpenAI-compatible endpoint",
    docsPath: "/docs/providers/anthropic",
  },
  gemini: {
    id: "gemini",
    label: "Google Gemini",
    transport: "openai_compatible",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-2.5-flash",
    suggestedModels: ["gemini-2.5-flash", "gemini-2.5-pro"],
    requiresApiKey: true,
    apiKeyLabel: "Google AI API key",
    baseUrlEditable: false,
    docsPath: "/docs/providers/gemini",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    transport: "openai_compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "anthropic/claude-sonnet-5",
    suggestedModels: [
      "anthropic/claude-sonnet-5",
      "openai/gpt-4.1",
      "google/gemini-2.5-flash",
    ],
    requiresApiKey: true,
    apiKeyLabel: "OpenRouter API key",
    baseUrlEditable: false,
    docsPath: "/docs/providers/openrouter",
  },
  groq: {
    id: "groq",
    label: "Groq",
    transport: "openai_compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "openai/gpt-oss-120b",
    suggestedModels: [
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b",
      "qwen/qwen3.6-27b",
    ],
    requiresApiKey: true,
    apiKeyLabel: "Groq API key",
    baseUrlEditable: false,
    docsPath: "/docs/providers/groq",
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    transport: "openai_compatible",
    baseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-chat",
    suggestedModels: ["deepseek-chat", "deepseek-reasoner"],
    requiresApiKey: true,
    apiKeyLabel: "DeepSeek API key",
    baseUrlEditable: false,
    docsPath: "/docs/providers/deepseek",
  },
  nvidia: {
    id: "nvidia",
    label: "NVIDIA",
    transport: "openai_compatible",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    defaultModel: "meta/llama-3.3-70b-instruct",
    suggestedModels: [
      "meta/llama-3.3-70b-instruct",
      "nvidia/llama-3.3-nemotron-super-49b-v1.5",
      "meta/llama-3.1-8b-instruct",
    ],
    requiresApiKey: true,
    apiKeyLabel: "NVIDIA API key",
    baseUrlEditable: false,
    docsPath: "/docs/providers/nvidia",
  },
  ollama: {
    id: "ollama",
    label: "Ollama (offline)",
    transport: "ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    defaultModel: "llama3.2",
    suggestedModels: ["llama3.2", "qwen2.5", "mistral"],
    requiresApiKey: false,
    apiKeyLabel: "API key (optional)",
    baseUrlEditable: true,
    docsHint: "Settings can detect Ollama, install it via Docker on this host, and pull models.",
    docsPath: "/docs/providers/ollama",
  },
  custom: {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    transport: "openai_compatible",
    baseUrl: "",
    defaultModel: "",
    suggestedModels: [],
    requiresApiKey: true,
    apiKeyLabel: "API key",
    baseUrlEditable: true,
    docsPath: "/docs/providers/custom",
  },
};

export const LLM_PRESET_LIST: LlmPreset[] = LLM_PRESET_IDS.map((id) => LLM_PRESETS[id]);

export function isLlmPresetId(value: string): value is LlmPresetId {
  return (LLM_PRESET_IDS as readonly string[]).includes(value);
}

export function getLlmPreset(id: LlmPresetId): LlmPreset {
  return LLM_PRESETS[id];
}

/**
 * Infer preset when settings were saved before presets existed.
 * - ollama transport → ollama
 * - venice host / empty base → venice
 * - known preset base URL match → that preset
 * - else → custom
 */
export function inferLlmPreset(input: {
  provider?: string | null;
  preset?: string | null;
  baseUrl?: string | null;
}): LlmPresetId {
  if (input.preset && isLlmPresetId(input.preset)) {
    return input.preset;
  }
  if (input.provider === "ollama") {
    return "ollama";
  }
  const base = (input.baseUrl ?? "").trim().replace(/\/$/, "");
  if (!base || base.includes("venice.ai")) {
    return "venice";
  }
  for (const preset of LLM_PRESET_LIST) {
    if (preset.id === "custom" || preset.id === "ollama" || !preset.baseUrl) continue;
    const presetBase = preset.baseUrl.replace(/\/$/, "");
    if (base === presetBase || base.startsWith(`${presetBase}/`)) {
      return preset.id;
    }
  }
  return "custom";
}
