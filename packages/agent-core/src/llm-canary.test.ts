import { describe, expect, it, vi } from "vitest";
import type { LlmClient, LlmCompletion } from "./llm.js";
import {
  assertTwoStepToolTrace,
  classifyLlmCanaryFailure,
  collectStringValues,
  DEFAULT_HOME_RESTORE_MODEL,
  DEFAULT_HOME_VENICE_CANARY_MODELS,
  DEFAULT_OLLAMA_CANARY_MODELS,
  DEFAULT_VENICE_CANARY_MODELS,
  FRIEND_SERVER_RE,
  isDisposableLlmCanaryFixture,
  isHomeCanaryLeftoverModel,
  llmSettingsMatch,
  mapHomeChatFailure,
  ollamaModelInstalled,
  probeOllamaReachable,
  resolveRestoreTarget,
  restorePutBody,
  runLlmModelCanary,
  runTwoStepCanary,
  shouldFileLlmCanaryFailure,
} from "./llm-canary.js";
import type { ToolTraceEntry } from "./orchestrator.js";

function scriptedLlm(steps: LlmCompletion[]): LlmClient {
  let i = 0;
  return {
    mode: "openai_compatible",
    async complete() {
      return steps[Math.min(i++, steps.length - 1)]!;
    },
  };
}

const listThenGet: LlmCompletion[] = [
  {
    content: "",
    toolCalls: [{ id: "1", name: "servers_list", arguments: {} }],
  },
  {
    content: "",
    toolCalls: [{ id: "2", name: "servers_get", arguments: { serverId: "lab-llm-canary" } }],
  },
  { content: "lab-llm-canary is the disposable fixture." },
];

describe("assertTwoStepToolTrace", () => {
  it("passes servers_list then servers_get using the lab id", () => {
    const trace: ToolTraceEntry[] = [
      {
        name: "servers_list",
        arguments: {},
        result: { servers: [{ id: "lab-llm-canary", skillName: "fixtures.lab-docker-server" }] },
      },
      {
        name: "servers_get",
        arguments: { serverId: "lab-llm-canary" },
        result: { server: { id: "lab-llm-canary" } },
      },
    ];
    expect(assertTwoStepToolTrace(trace)).toMatchObject({ ok: true, degraded: false });
  });

  it("passes skill_list then a follow-up that uses a skill name from the result", () => {
    const trace: ToolTraceEntry[] = [
      {
        name: "skill_list",
        arguments: {},
        result: { skills: [{ name: "fixtures.lab-docker-server" }] },
      },
      {
        name: "servers_get",
        arguments: { skillName: "fixtures.lab-docker-server", serverId: "lab-llm-canary" },
        result: {},
      },
    ];
    expect(assertTwoStepToolTrace(trace).ok).toBe(true);
  });

  it("marks a single tool call as degraded, not a mutating fail", () => {
    const trace: ToolTraceEntry[] = [
      { name: "servers_list", arguments: {}, result: { servers: [{ id: "lab-llm-canary" }] } },
    ];
    expect(assertTwoStepToolTrace(trace)).toEqual({
      ok: false,
      degraded: true,
      reason: "need_two_tools",
      names: ["servers_list"],
    });
  });

  it("rejects a follow-up that ignores the first tool result", () => {
    const trace: ToolTraceEntry[] = [
      {
        name: "servers_list",
        arguments: {},
        result: { servers: [{ id: "lab-llm-canary" }] },
      },
      { name: "servers_get", arguments: { serverId: "unrelated" }, result: {} },
    ];
    expect(assertTwoStepToolTrace(trace).reason).toBe("followup_did_not_use_result");
  });

  it("rejects mutating tools and friend-server names", () => {
    expect(
      assertTwoStepToolTrace([
        { name: "servers_list", arguments: {}, result: { servers: [{ id: "lab-llm-canary" }] } },
        { name: "servers_start", arguments: { serverId: "lab-llm-canary" }, result: {} },
      ]).reason,
    ).toBe("mutating_tool");

    expect(
      assertTwoStepToolTrace([
        { name: "servers_list", arguments: {}, result: { servers: [{ id: "lab-llm-canary" }] } },
        { name: "servers_get", arguments: { serverId: "NewZombieLand3" }, result: {} },
      ]).reason,
    ).toBe("friend_server");
  });

  it("does not treat Gemma as a special-case skip", () => {
    expect(DEFAULT_VENICE_CANARY_MODELS).not.toContain("google-gemma-3-27b-it");
    expect(FRIEND_SERVER_RE.test("google-gemma-3-27b-it")).toBe(false);
    expect(collectStringValues({ model: "google-gemma-3-27b-it" })).toEqual([
      "google-gemma-3-27b-it",
    ]);
  });
});

describe("runTwoStepCanary", () => {
  it("accepts a scripted two-step lab trace", async () => {
    const result = await runTwoStepCanary(scriptedLlm(listThenGet));
    expect(result.ok).toBe(true);
    expect(result.names).toEqual(["servers_list", "servers_get"]);
    expect(result.degraded).toBe(false);
  });

  it("refuses a create/start follow-up even on a lab id", async () => {
    const llm = scriptedLlm([
      {
        content: "",
        toolCalls: [{ id: "1", name: "servers_list", arguments: {} }],
      },
      {
        content: "",
        toolCalls: [
          { id: "2", name: "servers_start", arguments: { serverId: "lab-llm-canary" } },
        ],
      },
      { content: "started" },
    ]);
    const orch = await runTwoStepCanary(llm);
    // servers_start is not registered, so the trace records unknown_tool — still not a valid two-step get.
    expect(orch.ok).toBe(false);
  });
});

describe("Ollama reachability", () => {
  it("prefers tool-capable Ollama canary tags first (qwen2.5 before llama3.2)", () => {
    expect(DEFAULT_OLLAMA_CANARY_MODELS[0]).toBe("qwen2.5");
    expect(DEFAULT_OLLAMA_CANARY_MODELS).toContain("llama3.2");
  });

  it("reports reachable=false without throwing when Ollama is down", async () => {
    const probe = await probeOllamaReachable("http://127.0.0.1:9", async () => {
      throw new Error("connect_refused");
    });
    expect(probe.reachable).toBe(false);
    expect(probe.models).toEqual([]);
  });

  it("lists installed tags when /api/tags succeeds", async () => {
    const probe = await probeOllamaReachable("http://127.0.0.1:11434/v1", async () => {
      return new Response(JSON.stringify({ models: [{ name: "llama3.2:latest" }] }), {
        status: 200,
      });
    });
    expect(probe.reachable).toBe(true);
    expect(ollamaModelInstalled(probe.models, "llama3.2")).toBe(true);
    expect(ollamaModelInstalled(probe.models, "qwen2.5")).toBe(false);
  });

  it("skips Ollama when unreachable without failing a passing Venice path", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("down");
    });
    const report = await runLlmModelCanary({
      venice: {
        models: ["llama-3.2-3b"],
        clientForModel: () => scriptedLlm(listThenGet),
      },
      ollama: { fetchImpl: fetchImpl as unknown as typeof fetch },
    });
    expect(report.ok).toBe(true);
    expect(report.veniceOk).toBe(true);
    expect(report.ollama.reachable).toBe(false);
    expect(report.ollama.ok).toBeNull();
    expect(report.models.some((m) => m.provider === "ollama")).toBe(false);
  });

  it("skips missing Ollama tags without failing the Venice path flag", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/api/tags")) {
        return new Response(JSON.stringify({ models: [{ name: "mistral:latest" }] }), {
          status: 200,
        });
      }
      throw new Error(`unexpected ${url}`);
    };
    const report = await runLlmModelCanary({
      ollama: { fetchImpl, models: [...DEFAULT_OLLAMA_CANARY_MODELS] },
    });
    expect(report.ollama.reachable).toBe(true);
    const ollamaRows = report.models.filter((m) => m.provider === "ollama");
    expect(ollamaRows.every((m) => m.skipped && m.skipReason === "model_not_installed")).toBe(
      true,
    );
    expect(report.ollama.ok).toBe(true);
  });
});

describe("Home restore / teardown guards", () => {
  it("matches snapshot by preset + provider + model (ignores extra fields)", () => {
    expect(
      llmSettingsMatch(
        { preset: "venice", provider: "openai_compatible", model: "grok-4-6" },
        { preset: "venice", provider: "openai_compatible", model: "grok-4-6", baseUrl: "https://api.venice.ai/api/v1" },
      ),
    ).toBe(true);
    expect(
      llmSettingsMatch(
        { preset: "venice", provider: "openai_compatible", model: "grok-4-6" },
        { preset: "venice", provider: "openai_compatible", model: "llama-3.3-70b" },
      ),
    ).toBe(false);
  });

  it("PUT restore body keeps preset+model and never sends an apiKey", () => {
    const body = restorePutBody({
      preset: "venice",
      provider: "openai_compatible",
      model: "grok-4-6",
      baseUrl: "https://api.venice.ai/api/v1",
    });
    expect(body).toEqual({
      preset: "venice",
      model: "grok-4-6",
      baseUrl: "https://api.venice.ai/api/v1",
    });
    expect(body).not.toHaveProperty("apiKey");
  });

  it("heals a leftover canary model when persist is missing", () => {
    const resolved = resolveRestoreTarget({
      current: { preset: "venice", provider: "openai_compatible", model: "llama-3.3-70b" },
    });
    expect(resolved.healed).toBe(true);
    expect(resolved.reason).toBe("leftover_canary_model");
    expect(resolved.snapshot.model).toBe(DEFAULT_HOME_RESTORE_MODEL);
    expect(resolved.snapshot.preset).toBe("venice");
  });

  it("prefers a persisted snapshot over a leftover current model", () => {
    const persisted = { preset: "venice", provider: "openai_compatible", model: "grok-4-6" };
    const resolved = resolveRestoreTarget({
      current: { preset: "venice", provider: "openai_compatible", model: "qwen3-5-9b" },
      persisted,
    });
    expect(resolved).toEqual({ snapshot: persisted, healed: true, reason: "persisted_restore" });
  });

  it("does not treat the production default as a leftover", () => {
    expect(isHomeCanaryLeftoverModel("grok-4-6")).toBe(false);
    expect(isHomeCanaryLeftoverModel("llama-3.3-70b")).toBe(true);
    const resolved = resolveRestoreTarget({
      current: { preset: "venice", provider: "openai_compatible", model: "grok-4-6" },
    });
    expect(resolved.healed).toBe(false);
    expect(resolved.reason).toBe("current");
  });

  it("only tears down lab-llm-canary* fixtures, never friends", () => {
    expect(isDisposableLlmCanaryFixture({ id: "lab-llm-canary", name: "lab-llm-canary" })).toBe(true);
    expect(isDisposableLlmCanaryFixture({ id: "abc", name: "lab-llm-canary-leftover" })).toBe(true);
    expect(isDisposableLlmCanaryFixture({ id: "lab-matrix-paper", name: "lab-matrix-paper" })).toBe(false);
    expect(isDisposableLlmCanaryFixture({ id: "nzl", name: "NewZombieLand3" })).toBe(false);
    expect(isDisposableLlmCanaryFixture({ id: "lab-llm-canary", name: "NewZombieLand3" })).toBe(false);
    expect(DEFAULT_HOME_VENICE_CANARY_MODELS).not.toContain("google-gemma-3-27b-it");
    expect(DEFAULT_HOME_VENICE_CANARY_MODELS).not.toContain("grok-4-6");
  });
});

describe("classifyLlmCanaryFailure", () => {
  it("files only hard product tool-call failures", () => {
    expect(shouldFileLlmCanaryFailure({ ok: false, reason: "mutating_tool" })).toBe(true);
    expect(shouldFileLlmCanaryFailure({ ok: false, reason: "friend_server" })).toBe(true);
    expect(shouldFileLlmCanaryFailure({ ok: false, reason: "fake_tool_json" })).toBe(true);
  });

  it("does not file flakes or cheap-model degraded traces", () => {
    expect(classifyLlmCanaryFailure({ ok: false, reason: "disconnect" })).toBe("flake");
    expect(classifyLlmCanaryFailure({ ok: false, reason: "empty_tool_trace" })).toBe("flake");
    expect(classifyLlmCanaryFailure({ ok: false, reason: "partial_trace", degraded: true })).toBe(
      "degraded",
    );
    expect(classifyLlmCanaryFailure({ ok: false, reason: "need_two_tools", degraded: true })).toBe(
      "degraded",
    );
    expect(shouldFileLlmCanaryFailure({ ok: false, reason: "disconnect" })).toBe(false);
    expect(shouldFileLlmCanaryFailure({ ok: false, reason: "partial_trace", degraded: true })).toBe(
      false,
    );
    expect(shouldFileLlmCanaryFailure({ ok: true, reason: undefined })).toBe(false);
  });

  it("maps Home chat transport errors to flake reasons", () => {
    expect(mapHomeChatFailure(new Error("home_rest_502: /api/chat bad gateway"))).toEqual({
      reason: "http_5xx",
      flake: true,
    });
    expect(mapHomeChatFailure(new Error("fetch failed: ECONNRESET"))).toEqual({
      reason: "disconnect",
      flake: true,
    });
  });
});
