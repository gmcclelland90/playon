import { LLM_PRESETS } from "@playon/shared";
import { describe, expect, it } from "vitest";
import { OpenAICompatibleLlmClient } from "./llm.js";
import {
  DEFAULT_OLLAMA_CANARY_MODELS,
  ollamaModelInstalled,
  probeOllamaReachable,
  runTwoStepCanary,
} from "./llm-canary.js";

/**
 * Live Venice two-step tool-trace canary. Requires PLAYON_VENICE_API_KEY or VENICE_API_KEY.
 * Ollama is probed when present; unreachable Ollama must not fail this Venice path.
 * Model: PLAYON_VENICE_MODEL, else LLM_PRESETS.venice.defaultModel (grok-4-5).
 */
describe("agent live LLM canary v2", () => {
  it("completes a two-step lab tool trace on Venice", async () => {
    const apiKey =
      process.env.PLAYON_VENICE_API_KEY?.trim() || process.env.VENICE_API_KEY?.trim() || "";
    if (!apiKey) {
      throw new Error(
        "llm_api_key_required: set PLAYON_VENICE_API_KEY (or VENICE_API_KEY) for agent verify on the lab host",
      );
    }

    const llm = new OpenAICompatibleLlmClient(
      process.env.PLAYON_VENICE_BASE_URL?.trim() || "https://api.venice.ai/api/v1",
      apiKey,
      process.env.PLAYON_VENICE_MODEL?.trim() || LLM_PRESETS.venice.defaultModel,
      "openai_compatible",
    );

    const result = await runTwoStepCanary(llm);
    expect(result.ok, `${result.reason} names=${JSON.stringify(result.names)}`).toBe(true);
    expect(result.names.length).toBeGreaterThanOrEqual(2);
    expect(result.degraded).toBe(false);
  }, 120_000);

  it("reports Ollama reachable=false without failing the Venice path", async () => {
    const ollama = await probeOllamaReachable();
    if (!ollama.reachable) {
      expect(ollama.reachable).toBe(false);
      return;
    }

    const installed = DEFAULT_OLLAMA_CANARY_MODELS.filter((m) =>
      ollamaModelInstalled(ollama.models, m),
    );
    if (!installed.length) {
      expect(ollama.reachable).toBe(true);
      return;
    }

    const openaiBase = `${ollama.baseUrl.replace(/\/+$/, "")}/v1`;
    const result = await runTwoStepCanary(
      new OpenAICompatibleLlmClient(openaiBase, "", installed[0]!, "ollama"),
    );
    expect(result.ok, `${result.reason} names=${JSON.stringify(result.names)}`).toBe(true);
  }, 180_000);
});
