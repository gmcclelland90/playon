import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OpenAICompatibleLlmClient } from "@playon/agent-core";
import type { AppConfig } from "../config.js";
import { createControlPlane } from "../control-plane.js";
import { createDb } from "../db/client.js";
import { applyBootstrap } from "../db/migrate.js";
import { createOrchestrator, createPlayOnToolRegistry } from "./tools.js";

function testConfig(dataRoot: string): AppConfig {
  return {
    port: 0,
    advertiseHost: "127.0.0.1",
    dataRoot,
    dbPath: path.join(dataRoot, "playon.sqlite"),
    sessionSecret: "test-session-secret-at-least-32-chars!!",
    skillsRoots: [path.join(process.cwd(), "skills")],
    llmMode: "openai_compatible",
    runtimeMode: "docker",
  };
}

describe("tool registry parity (Venice/Ollama/MCP)", () => {
  it("orchestrator and MCP registry expose identical tool fingerprints", () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "playon-parity-"));
    applyBootstrap(path.join(dataRoot, "playon.sqlite"));
    const config = testConfig(dataRoot);
    const { db } = createDb(config.dbPath);
    const plane = createControlPlane(db, config);

    const registry = createPlayOnToolRegistry(plane, {});
    const llm = new OpenAICompatibleLlmClient(
      "http://127.0.0.1:9/v1",
      "unused",
      "test",
      "openai_compatible",
    );
    const orch = createOrchestrator(plane, llm, {});

    const fromRegistry = registry.parityFingerprint();
    const fromOrch = orch
      .getToolDefinitions()
      .map((d) => ({ name: d.name, requiresConfirm: Boolean(d.requiresConfirm) }))
      .sort((a, b) => a.name.localeCompare(b.name));

    expect(fromRegistry.length).toBeGreaterThan(20);
    expect(fromOrch).toEqual(fromRegistry);
  });
});
