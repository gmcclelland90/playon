import { describe, expect, it } from "vitest";
import {
  CreateAccessTokenRequestSchema,
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
