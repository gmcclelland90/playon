import { describe, expect, it } from "vitest";
import {
  CreateAccessTokenRequestSchema,
  FetchSettingsPutRequestSchema,
  LlmSettingsPutRequestSchema,
  NodeSettingsPutRequestSchema,
  OllamaInstallRequestSchema,
  OllamaPullRequestSchema,
  VultrOAuthCallbackRequestSchema,
} from "./settings.js";

describe("settings route request contracts", () => {
  it("accepts a preset or the legacy provider, but not neither", () => {
    expect(LlmSettingsPutRequestSchema.parse({ preset: "venice" }).preset).toBe("venice");
    expect(
      LlmSettingsPutRequestSchema.parse({ provider: "ollama", model: "llama3" }).provider,
    ).toBe("ollama");

    const result = LlmSettingsPutRequestSchema.safeParse({ model: "llama3" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("preset_or_provider_required");
  });

  it("keeps an empty apiKey, which is how a stored key is cleared", () => {
    expect(LlmSettingsPutRequestSchema.parse({ preset: "custom", apiKey: "" }).apiKey).toBe("");
  });

  it("rejects groq as an out-of-box preset while still accepting custom", () => {
    expect(LlmSettingsPutRequestSchema.safeParse({ preset: "groq" }).success).toBe(false);
    expect(LlmSettingsPutRequestSchema.parse({ preset: "custom" }).preset).toBe("custom");
    for (const preset of [
      "venice",
      "openai",
      "anthropic",
      "gemini",
      "openrouter",
      "deepseek",
      "nvidia",
      "ollama",
    ] as const) {
      expect(LlmSettingsPutRequestSchema.parse({ preset }).preset).toBe(preset);
    }
  });

  it("lets both Ollama jobs fall back to the stored base url", () => {
    expect(OllamaInstallRequestSchema.parse({})).toEqual({});
    expect(OllamaPullRequestSchema.safeParse({}).success).toBe(false);
    expect(OllamaPullRequestSchema.parse({ model: "llama3" })).toEqual({ model: "llama3" });
  });

  it("requires an explicit boolean for local compute", () => {
    expect(NodeSettingsPutRequestSchema.safeParse({ localComputeEnabled: "yes" }).success).toBe(
      false,
    );
    expect(NodeSettingsPutRequestSchema.parse({ localComputeEnabled: false })).toEqual({
      localComputeEnabled: false,
    });
  });

  it("accepts an empty or populated fetch_url LAN allowlist", () => {
    expect(FetchSettingsPutRequestSchema.parse({ lanAllowlist: [] })).toEqual({ lanAllowlist: [] });
    expect(
      FetchSettingsPutRequestSchema.parse({ lanAllowlist: ["192.168.1.50", "10.0.0.0/8"] }),
    ).toEqual({ lanAllowlist: ["192.168.1.50", "10.0.0.0/8"] });
    expect(FetchSettingsPutRequestSchema.safeParse({}).success).toBe(false);
    expect(
      FetchSettingsPutRequestSchema.safeParse({ lanAllowlist: ["x".repeat(81)] }).success,
    ).toBe(false);
  });

  it("names an access token when the caller does not", () => {
    expect(CreateAccessTokenRequestSchema.parse({}).name).toBe("MCP token");
    expect(CreateAccessTokenRequestSchema.safeParse({ name: "x".repeat(81) }).success).toBe(false);
  });

  it("requires both halves of the Vultr OAuth callback", () => {
    expect(VultrOAuthCallbackRequestSchema.safeParse({ state: "s" }).success).toBe(false);
    expect(VultrOAuthCallbackRequestSchema.parse({ state: "s", code: "c" })).toEqual({
      state: "s",
      code: "c",
    });
  });
});
