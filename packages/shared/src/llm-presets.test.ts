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
    expect(LLM_PRESET_IDS).toContain("venice");
    expect(LLM_PRESET_IDS).toContain("nvidia");
    expect(LLM_PRESET_IDS).toContain("openrouter");
    expect(LLM_PRESET_IDS).toContain("ollama");
    expect(LLM_PRESET_IDS).toContain("custom");
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
  });

  it("honors an explicit stored preset", () => {
    expect(
      inferLlmPreset({
        provider: "openai_compatible",
        preset: "groq",
        baseUrl: "https://api.openai.com/v1",
      }),
    ).toBe("groq");
  });

  it("validates preset ids", () => {
    expect(isLlmPresetId("deepseek")).toBe(true);
    expect(isLlmPresetId("not-a-provider")).toBe(false);
    expect(getLlmPreset("venice").baseUrl).toBe(LLM_PRESETS.venice.baseUrl);
  });
});
