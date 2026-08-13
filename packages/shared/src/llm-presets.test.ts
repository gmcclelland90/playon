import { describe, expect, it } from "vitest";
import {
  getLlmPreset,
  inferLlmPreset,
  isLlmPresetId,
  LLM_PRESET_IDS,
  LLM_PRESETS,
} from "./llm-presets.js";

describe("llm presets", () => {
  it("includes the first-wave provider ids", () => {
    expect(LLM_PRESET_IDS).toEqual([
      "venice",
      "openai",
      "anthropic",
      "gemini",
      "openrouter",
      "deepseek",
      "nvidia",
      "ollama",
      "custom",
    ]);
    expect(LLM_PRESET_IDS).not.toContain("groq");
  });

  it("maps ollama transport to the ollama preset", () => {
    expect(inferLlmPreset({ provider: "ollama" })).toBe("ollama");
  });

  it("defaults missing / venice base URLs to venice", () => {
    expect(inferLlmPreset({ provider: "openai_compatible" })).toBe("venice");
    expect(
      inferLlmPreset({
        provider: "openai_compatible",
        baseUrl: "https://api.venice.ai/api/v1",
      }),
    ).toBe("venice");
  });

  it("matches known preset base URLs", () => {
    expect(
      inferLlmPreset({
        provider: "openai_compatible",
        baseUrl: "https://api.openai.com/v1",
      }),
    ).toBe("openai");
    expect(
      inferLlmPreset({
        provider: "openai_compatible",
        baseUrl: "https://integrate.api.nvidia.com/v1/",
      }),
    ).toBe("nvidia");
    expect(
      inferLlmPreset({
        provider: "openai_compatible",
        baseUrl: "https://api.anthropic.com/v1",
      }),
    ).toBe("anthropic");
  });

  it("falls back to custom for unknown hosts", () => {
    expect(
      inferLlmPreset({
        provider: "openai_compatible",
        baseUrl: "https://llm.example.internal/v1",
      }),
    ).toBe("custom");
    expect(
      inferLlmPreset({
        provider: "openai_compatible",
        baseUrl: "https://api.groq.com/openai/v1",
      }),
    ).toBe("custom");
  });

  it("honors an explicit stored preset", () => {
    expect(
      inferLlmPreset({
        provider: "openai_compatible",
        preset: "deepseek",
        baseUrl: "https://api.openai.com/v1",
      }),
    ).toBe("deepseek");
  });

  it("treats a retired groq stored preset as custom", () => {
    expect(isLlmPresetId("groq")).toBe(false);
    expect(
      inferLlmPreset({
        provider: "openai_compatible",
        preset: "groq",
        baseUrl: "https://api.groq.com/openai/v1",
      }),
    ).toBe("custom");
  });

  it("validates preset ids", () => {
    expect(isLlmPresetId("deepseek")).toBe(true);
    expect(isLlmPresetId("not-a-provider")).toBe(false);
    expect(getLlmPreset("venice").baseUrl).toBe(LLM_PRESETS.venice.baseUrl);
  });

  it("exposes docsPath for every preset", () => {
    for (const id of LLM_PRESET_IDS) {
      expect(LLM_PRESETS[id].docsPath).toBe(`/docs/providers/${id}`);
    }
  });

  it("keeps curated suggestions aligned with known-good current ids", () => {
    expect(LLM_PRESETS.venice.defaultModel).toBe("grok-4-5");
    expect(LLM_PRESETS.venice.suggestedModels).toEqual([
      "grok-4-5",
      "llama-3.3-70b",
      "qwen3-235b-a22b-instruct-2507",
      "venice-uncensored-1-2",
    ]);
    expect(LLM_PRESETS.venice.suggestedModels[0]).toBe(LLM_PRESETS.venice.defaultModel);
    expect(LLM_PRESETS.venice.suggestedModels).toContain("llama-3.3-70b");
    expect(LLM_PRESETS.anthropic.defaultModel).toBe("claude-sonnet-5");
    expect(LLM_PRESETS.nvidia.suggestedModels).toContain(
      "nvidia/llama-3.3-nemotron-super-49b-v1.5",
    );
    expect(LLM_PRESETS.nvidia.suggestedModels).not.toContain(
      "nvidia/llama-3.1-nemotron-70b-instruct",
    );
    expect(LLM_PRESETS.ollama.defaultModel).toBe("qwen2.5");
    expect(LLM_PRESETS.ollama.suggestedModels).toEqual(["qwen2.5", "llama3.2", "mistral"]);
    expect(LLM_PRESETS.ollama.suggestedModels[0]).toBe(LLM_PRESETS.ollama.defaultModel);
    // Native Gemini: do not invent a replacement id. 2.5-flash remains listed but is stale for new keys.
    expect(LLM_PRESETS.gemini.defaultModel).toBe("gemini-2.5-flash");
    expect(LLM_PRESETS.gemini.docsHint).toMatch(/404/);
    expect(LLM_PRESETS.gemini.docsHint).toMatch(/thought signature/i);
  });
});
