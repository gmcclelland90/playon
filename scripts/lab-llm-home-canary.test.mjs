#!/usr/bin/env node
/**
 * Unit tests for Home LLM canary restore / teardown (#836).
 * Run: node scripts/lab-llm-home-canary.test.mjs
 */
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyHomeChatResult,
  leftoverLlmCanaryFixtures,
  loadPersistedRestore,
  restoreLlmSettings,
  runHomeLlmModelCanary,
  savePersistedRestore,
  teardownLlmCanaryFixtures,
} from "./lab-llm-home-canary.mjs";

const helpers = {
  LAB_CANARY_SERVER_ID: "lab-llm-canary",
  LAB_CANARY_SERVER_NAME: "lab-llm-canary",
  LAB_CANARY_SKILL: "fixtures.lab-docker-server",
  TWO_STEP_PROMPT: "list then get lab-llm-canary",
  DEFAULT_HOME_VENICE_CANARY_MODELS: ["llama-3.2-3b"],
  DEFAULT_OLLAMA_CANARY_MODELS: ["qwen2.5"],
  DEFAULT_HOME_RESTORE_PRESET: "venice",
  DEFAULT_HOME_RESTORE_MODEL: "grok-4-6",
  llmSettingsMatch(a, b) {
    return a?.preset === b?.preset && a?.provider === b?.provider && a?.model === b?.model;
  },
  restorePutBody(snapshot) {
    return { preset: snapshot.preset, model: snapshot.model };
  },
  resolveRestoreTarget({ current, persisted, healTo }) {
    if (persisted && (current?.model !== persisted.model)) {
      return { snapshot: persisted, healed: true, reason: "persisted_restore" };
    }
    if (current?.model === "llama-3.3-70b") {
      return {
        snapshot: healTo ?? { preset: "venice", provider: "openai_compatible", model: "grok-4-6" },
        healed: true,
        reason: "leftover_canary_model",
      };
    }
    return { snapshot: current, healed: false, reason: "current" };
  },
  isDisposableLlmCanaryFixture(server) {
    const id = String(server?.id ?? "");
    const name = String(server?.name ?? "");
    if (/newzombieland|\bnzl\b/i.test(id) || /newzombieland|\bnzl\b/i.test(name)) return false;
    return id.startsWith("lab-llm-canary") || name.startsWith("lab-llm-canary");
  },
  assertTwoStepToolTrace(trace) {
    const names = trace.map((t) => t.name);
    if (trace.length < 2) return { ok: false, degraded: true, reason: "need_two_tools", names };
    return { ok: true, degraded: false, names };
  },
  classifyLlmCanaryFailure(row) {
    if (row.ok) return "ok";
    if (row.degraded) return "degraded";
    return "product";
  },
  mapHomeChatFailure(err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/502/.test(message)) return { reason: "http_5xx", flake: true };
    if (/ECONNRESET|disconnect/i.test(message)) return { reason: "disconnect", flake: true };
    return { reason: message, flake: false };
  },
  ollamaModelInstalled() {
    return false;
  },
};

function fakeHome(state) {
  return {
    async rest(pathname, { method = "GET", body } = {}) {
      if (pathname === "/api/settings/llm" && method === "GET") {
        return { llm: { ...state.llm } };
      }
      if (pathname === "/api/settings/llm" && method === "PUT") {
        if (state.failRestoreTimes > 0) {
          state.failRestoreTimes -= 1;
          throw new Error("home_rest_502: /api/settings/llm");
        }
        state.llm = {
          preset: body.preset ?? state.llm.preset,
          provider: body.preset === "ollama" ? "ollama" : "openai_compatible",
          model: body.model ?? state.llm.model,
        };
        return { llm: { ...state.llm } };
      }
      if (pathname === "/api/servers" && method === "GET") {
        return { servers: [...state.servers] };
      }
      if (pathname === "/api/servers" && method === "POST") {
        const server = { id: "lab-llm-canary", name: body.serverName, skillName: body.skillName, status: "stopped" };
        state.servers.push(server);
        return { server };
      }
      if (pathname.startsWith("/api/servers/") && method === "DELETE") {
        const id = pathname.split("/")[3];
        const idx = state.servers.findIndex((s) => s.id === id);
        if (idx === -1) throw new Error(`home_rest_404: ${pathname}`);
        const removed = state.servers[idx];
        if (!helpers.isDisposableLlmCanaryFixture(removed)) {
          throw new Error(`refused_non_lab_delete: ${removed.name}`);
        }
        state.servers.splice(idx, 1);
        return { ok: true, removed };
      }
      if (pathname === "/api/chat" && method === "POST") {
        if (state.chatMode === "partial") {
          return { toolTrace: [{ name: "servers_list", arguments: {}, result: { servers: [] } }] };
        }
        if (state.chatMode === "disconnect") {
          throw new Error("fetch failed: ECONNRESET");
        }
        return {
          toolTrace: [
            { name: "servers_list", arguments: {}, result: { servers: [{ id: "lab-llm-canary" }] } },
            { name: "servers_get", arguments: { serverId: "lab-llm-canary" }, result: {} },
          ],
        };
      }
      throw new Error(`unexpected ${method} ${pathname}`);
    },
  };
}

const persistDir = mkdtempSync(join(tmpdir(), "playon-llm-canary-"));
const persistPath = join(persistDir, "restore.json");

{
  const state = {
    llm: { preset: "venice", provider: "openai_compatible", model: "grok-4-6" },
    servers: [{ id: "nzl", name: "NewZombieLand3", status: "running" }],
    failRestoreTimes: 0,
    chatMode: "ok",
  };
  const report = await runHomeLlmModelCanary({
    home: fakeHome(state),
    helpers,
    persistPath,
    veniceModels: ["mistral-small-3-2-24b-instruct"],
    ollama: { reachable: false, models: [], baseUrl: "http://127.0.0.1:11434" },
  });
  assert.equal(report.mode, "home");
  assert.equal(report.ok, true);
  assert.equal(report.restore.ok, true);
  assert.equal(report.teardown.ok, true);
  assert.equal(state.llm.model, "grok-4-6");
  assert.equal(state.servers.some((s) => s.name === "NewZombieLand3"), true);
  assert.equal(state.servers.some((s) => String(s.name).startsWith("lab-llm-canary")), false);
  assert.equal(existsSync(persistPath), false);
}

{
  const leftoverPersist = join(persistDir, "leftover.json");
  savePersistedRestore(leftoverPersist, {
    preset: "venice",
    provider: "openai_compatible",
    model: "grok-4-6",
  });
  const state = {
    llm: { preset: "venice", provider: "openai_compatible", model: "llama-3.3-70b" },
    servers: [{ id: "lab-llm-canary", name: "lab-llm-canary", status: "stopped" }],
    failRestoreTimes: 0,
    chatMode: "ok",
  };
  const report = await runHomeLlmModelCanary({
    home: fakeHome(state),
    helpers,
    persistPath: leftoverPersist,
    veniceModels: ["llama-3.2-3b"],
    ollama: { reachable: false, models: [], baseUrl: "http://127.0.0.1:11434" },
  });
  assert.equal(report.restore.healed, true);
  assert.equal(report.restore.ok, true);
  assert.equal(state.llm.model, "grok-4-6");
  assert.equal(report.teardown.ok, true);
  assert.deepEqual(report.teardown.remaining, []);
  assert.equal(existsSync(leftoverPersist), false);
}

{
  const retryPersist = join(persistDir, "retry.json");
  const state = {
    llm: { preset: "venice", provider: "openai_compatible", model: "grok-4-6" },
    servers: [],
    failRestoreTimes: 1,
    chatMode: "ok",
  };
  const restore = await restoreLlmSettings(
    fakeHome(state),
    { preset: "venice", provider: "openai_compatible", model: "grok-4-6" },
    helpers,
    { attempts: 3, delayMs: 1 },
  );
  assert.equal(restore.ok, true);
  assert.equal(restore.attempts, 2);
  savePersistedRestore(retryPersist, state.llm);
  assert.equal(loadPersistedRestore(retryPersist).model, "grok-4-6");
}

{
  const state = {
    llm: { preset: "venice", provider: "openai_compatible", model: "grok-4-6" },
    servers: [
      { id: "lab-llm-canary", name: "lab-llm-canary", status: "stopped" },
      { id: "nzl", name: "NewZombieLand3", status: "running" },
    ],
  };
  const teardown = await teardownLlmCanaryFixtures(fakeHome(state), helpers, { attempts: 2, delayMs: 1 });
  assert.equal(teardown.ok, true);
  assert.deepEqual(teardown.remaining, []);
  assert.equal(state.servers.length, 1);
  assert.equal(state.servers[0].name, "NewZombieLand3");
  assert.deepEqual(
    leftoverLlmCanaryFixtures(
      [{ id: "lab-matrix-paper", name: "lab-matrix-paper" }, { id: "x", name: "lab-llm-canary" }],
      helpers,
    ).map((s) => s.name),
    ["lab-llm-canary"],
  );
}

{
  const state = {
    llm: { preset: "venice", provider: "openai_compatible", model: "grok-4-6" },
    servers: [],
    failRestoreTimes: 0,
    chatMode: "partial",
  };
  const report = await runHomeLlmModelCanary({
    home: fakeHome(state),
    helpers,
    persistPath: join(persistDir, "partial.json"),
    veniceModels: ["llama-3.2-3b"],
    ollama: { reachable: false, models: [], baseUrl: "http://127.0.0.1:11434" },
  });
  assert.equal(report.models[0].reason, "partial_trace");
  assert.equal(report.models[0].failureClass, "degraded");
  assert.equal(report.veniceOk, true);
  assert.equal(report.ok, true);
  assert.equal(state.llm.model, "grok-4-6");
}

{
  const state = {
    llm: { preset: "venice", provider: "openai_compatible", model: "grok-4-6" },
    servers: [],
    failRestoreTimes: 0,
    chatMode: "disconnect",
  };
  const report = await runHomeLlmModelCanary({
    home: fakeHome(state),
    helpers,
    persistPath: join(persistDir, "disconnect.json"),
    veniceModels: ["llama-3.3-70b"],
    ollama: { reachable: false, models: [], baseUrl: "http://127.0.0.1:11434" },
  });
  assert.equal(report.models[0].reason, "disconnect");
  assert.equal(report.models[0].failureClass, "flake");
  assert.equal(report.veniceOk, true);
  assert.equal(report.restore.ok, true);
  assert.equal(state.llm.model, "grok-4-6");
}

{
  const empty = classifyHomeChatResult({ toolTrace: [] }, helpers);
  assert.equal(empty.reason, "empty_tool_trace");
  assert.equal(empty.failureClass, "flake");
}

{
  const body = helpers.restorePutBody({
    preset: "venice",
    provider: "openai_compatible",
    model: "grok-4-6",
    apiKey: "should-never-be-copied",
  });
  assert.equal("apiKey" in body, false);
}

console.log("ok", fileURLToPath(import.meta.url).split("/").pop());
