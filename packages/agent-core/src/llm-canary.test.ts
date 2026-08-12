import { describe, expect, it, vi } from "vitest";
import type { LlmClient, LlmCompletion } from "./llm.js";
import {
  assertTwoStepToolTrace,
  collectStringValues,
  DEFAULT_OLLAMA_CANARY_MODELS,
  DEFAULT_VENICE_CANARY_MODELS,
  FRIEND_SERVER_RE,
  ollamaModelInstalled,
  probeOllamaReachable,
  runLlmModelCanary,
  runTwoStepCanary,
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
