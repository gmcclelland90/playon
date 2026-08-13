import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb, type Db } from "../db/client.js";
import { applyBootstrap } from "../db/migrate.js";
import type { AppConfig } from "../config.js";
import { encryptSecret } from "./secrets.js";
import {
  LLM_SETTINGS_KEY,
  llmSettingsFromPut,
  setSetting,
  toPublicLlmSettings,
  type LlmSettings,
} from "./settings.js";
import { createLlmClient } from "./tools.js";

const temps: Array<{ root: string; sqlite: Database.Database }> = [];

function tempEnv(): { db: Db; config: AppConfig } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-llm-"));
  const dbPath = path.join(root, "playon.db");
  applyBootstrap(dbPath);
  const config: AppConfig = {
    port: 0,
    dataRoot: root,
    dbPath,
    sessionSecret: "test-secret",
    llmMode: "openai_compatible",
    runtimeMode: "docker",
    advertiseHost: "127.0.0.1",
    skillsRoots: [path.join(root, "skills")],
  };
  const { db, sqlite } = createDb(dbPath);
  temps.push({ root, sqlite });
  return { db, config };
}

afterEach(() => {
  for (const entry of temps.splice(0)) {
    entry.sqlite.close();
    fs.rmSync(entry.root, { recursive: true, force: true });
  }
  delete process.env.PLAYON_VENICE_API_KEY;
  delete process.env.VENICE_API_KEY;
});

describe("llmSettingsFromPut", () => {
  it("derives transport and base URL from preset", () => {
    const next = llmSettingsFromPut({
      preset: "openai",
      model: "gpt-4.1-mini",
    });
    expect(next).toEqual({
      provider: "openai_compatible",
      preset: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
    });
  });

  it("keeps editable base URL for ollama and custom", () => {
    expect(
      llmSettingsFromPut({
        preset: "ollama",
        baseUrl: "http://10.0.0.5:11434/v1",
        model: "qwen2.5",
      }),
    ).toMatchObject({
      provider: "ollama",
      preset: "ollama",
      baseUrl: "http://10.0.0.5:11434/v1",
      model: "qwen2.5",
    });

    expect(
      llmSettingsFromPut({
        preset: "custom",
        baseUrl: "https://gateway.example/v1",
        model: "my-model",
      }),
    ).toMatchObject({
      provider: "openai_compatible",
      preset: "custom",
      baseUrl: "https://gateway.example/v1",
      model: "my-model",
    });

    expect(
      llmSettingsFromPut({
        preset: "custom",
        baseUrl: "https://api.groq.com/openai/v1",
        model: "openai/gpt-oss-120b",
      }),
    ).toMatchObject({
      provider: "openai_compatible",
      preset: "custom",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "openai/gpt-oss-120b",
    });
  });

  it("infers legacy openai_compatible + venice host as venice", () => {
    const publicLlm = toPublicLlmSettings({
      provider: "openai_compatible",
      baseUrl: "https://api.venice.ai/api/v1",
      model: "llama-3.3-70b",
    });
    expect(publicLlm.preset).toBe("venice");
  });

  it("maps a stored groq-shaped config to custom", () => {
    const publicLlm = toPublicLlmSettings({
      provider: "openai_compatible",
      preset: "groq" as LlmSettings["preset"],
      baseUrl: "https://api.groq.com/openai/v1",
      model: "openai/gpt-oss-120b",
    });
    expect(publicLlm.preset).toBe("custom");
    expect(publicLlm.baseUrl).toBe("https://api.groq.com/openai/v1");
  });

  it("rejects custom preset without a base URL", () => {
    expect(() =>
      llmSettingsFromPut({
        preset: "custom",
        model: "my-model",
      }),
    ).toThrow(/llm_base_url_required/);
  });
});

describe("createLlmClient", () => {
  it("builds an ollama client without an API key", async () => {
    const { db, config } = tempEnv();
    await setSetting<LlmSettings>(db, LLM_SETTINGS_KEY, {
      provider: "ollama",
      preset: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "llama3.2",
    });
    const llm = await createLlmClient(db, config);
    expect(llm.mode).toBe("ollama");
  });

  it("accepts Venice env key when preset is venice", async () => {
    const { db, config } = tempEnv();
    process.env.PLAYON_VENICE_API_KEY = "env-venice-key";
    await setSetting<LlmSettings>(db, LLM_SETTINGS_KEY, {
      provider: "openai_compatible",
      preset: "venice",
      model: "llama-3.3-70b",
    });
    const llm = await createLlmClient(db, config);
    expect(llm.mode).toBe("openai_compatible");
  });

  it("requires a settings key for non-venice cloud presets", async () => {
    const { db, config } = tempEnv();
    process.env.PLAYON_VENICE_API_KEY = "env-venice-key";
    await setSetting<LlmSettings>(db, LLM_SETTINGS_KEY, {
      provider: "openai_compatible",
      preset: "openai",
      model: "gpt-4.1",
    });
    await expect(createLlmClient(db, config)).rejects.toThrow(/llm_api_key_required/);
  });

  it("uses the encrypted settings key for nvidia", async () => {
    const { db, config } = tempEnv();
    await setSetting<LlmSettings>(db, LLM_SETTINGS_KEY, {
      provider: "openai_compatible",
      preset: "nvidia",
      model: "meta/llama-3.1-8b-instruct",
      apiKeyEncrypted: encryptSecret(config.sessionSecret, "nvapi-test"),
    });
    const llm = await createLlmClient(db, config);
    expect(llm.mode).toBe("openai_compatible");
    expect(llm.maxToolCallsPerCompletion).toBe(1);
  });

  it("does not cap Venice/grok to a single tool_call per completion", async () => {
    const { db, config } = tempEnv();
    process.env.PLAYON_VENICE_API_KEY = "env-venice-key";
    await setSetting<LlmSettings>(db, LLM_SETTINGS_KEY, {
      provider: "openai_compatible",
      preset: "venice",
      model: "grok-4-5",
    });
    const llm = await createLlmClient(db, config);
    expect(llm.maxToolCallsPerCompletion).toBeUndefined();
  });
});
