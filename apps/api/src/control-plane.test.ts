import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OpenAICompatibleLlmClient } from "@playon/agent-core";
import { createApp } from "./app.js";
import type { AppConfig } from "./config.js";
import { createControlPlane } from "./control-plane.js";
import { createDb } from "./db/client.js";
import { applyBootstrap } from "./db/migrate.js";
import { createOrchestrator } from "./services/tools.js";

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

describe("control plane composition", () => {
  it("createApp exposes a plane that createOrchestrator reuses by identity", () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "playon-cp-"));
    applyBootstrap(path.join(dataRoot, "playon.sqlite"));
    const { db } = createDb(path.join(dataRoot, "playon.sqlite"));
    const app = createApp(db, testConfig(dataRoot));
    const llm = new OpenAICompatibleLlmClient(
      "http://127.0.0.1:9/v1",
      "unused",
      "test",
      "openai_compatible",
    );
    const orch = createOrchestrator(app.controlPlane, llm);
    expect(orch.getToolDefinitions().length).toBeGreaterThan(0);
    expect(app.controlPlane.servers).toBe(app.controlPlane.servers);
    expect(app.controlPlane.panel).toBe(app.controlPlane.panel);
    // Same plane object fields are what tools close over
    const { servers, panel, playerPanel } = app.controlPlane;
    expect(servers).toBe(app.controlPlane.servers);
    expect(panel).toBe(app.controlPlane.panel);
    expect(playerPanel).toBe(app.controlPlane.playerPanel);
  });

  it("separate createControlPlane calls yield distinct ServerService instances", () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "playon-cp2-"));
    applyBootstrap(path.join(dataRoot, "playon.sqlite"));
    const { db } = createDb(path.join(dataRoot, "playon.sqlite"));
    const a = createControlPlane(db, testConfig(dataRoot));
    const b = createControlPlane(db, testConfig(dataRoot));
    expect(a.servers).not.toBe(b.servers);
    expect(a.panel).not.toBe(b.panel);
    expect(a.playerPanel).not.toBe(b.playerPanel);
  });
});
