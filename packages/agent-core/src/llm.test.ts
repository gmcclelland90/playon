import { describe, expect, it, vi } from "vitest";
import {
  extractProviderReasoning,
  extractToolCallsFromContent,
  formatLlmHttpError,
  googleThoughtSignature,
  isGeminiOpenAiCompatBackend,
  isLlmAbortError,
  isSequentialToolCallingBackend,
  isTransientLlmHttpStatus,
  isTransientLlmNetworkError,
  llmRetryDelayMs,
  looksLikeToolShapedContent,
  OpenAICompatibleLlmClient,
} from "./llm.js";

describe("extractProviderReasoning", () => {
  it("reads reasoning_content when the provider already sent it", () => {
    expect(
      extractProviderReasoning({
        reasoning_content: "Looks like win-1 is still on 0.2.10, so I’ll swap.",
      }),
    ).toBe("Looks like win-1 is still on 0.2.10, so I’ll swap.");
  });

  it("skips signature-shaped blobs", () => {
    expect(
      extractProviderReasoning({
        reasoning: "CiQAAAA-gemini-thought-sig-that-is-long-enough-to-look-like-b64",
      }),
    ).toBeUndefined();
  });
});

describe("extractToolCallsFromContent", () => {
  describe("OpenAI/Hermes JSON formats", () => {
    it("parses Venice text function JSON", () => {
      const content =
        '{"type": "function", "function": {"name": "servers_create_from_skill", "parameters": {"skillName": "games.minecraft-paper", "serverName": "Venice Paper"}}}';
      const calls = extractToolCallsFromContent(content);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.name).toBe("servers_create_from_skill");
      expect(calls[0]?.arguments).toEqual({
        skillName: "games.minecraft-paper",
        serverName: "Venice Paper",
      });
    });

    it("parses simple JSON with name and parameters", () => {
      const content =
        '{"name": "skill_read", "parameters": {"skillName": "games.valheim"}}';
      const calls = extractToolCallsFromContent(content);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.name).toBe("skill_read");
      expect(calls[0]?.arguments).toEqual({ skillName: "games.valheim" });
    });

    it("parses simple JSON with name and arguments", () => {
      const content =
        '{"name": "servers_start", "arguments": {"serverId": "test-123"}}';
      const calls = extractToolCallsFromContent(content);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.name).toBe("servers_start");
      expect(calls[0]?.arguments).toEqual({ serverId: "test-123" });
    });

    it("parses array of function objects", () => {
      const content = `[
        {"type": "function", "function": {"name": "skill_list", "parameters": {}}},
        {"type": "function", "function": {"name": "servers_list", "parameters": {}}}
      ]`;
      const calls = extractToolCallsFromContent(content);
      expect(calls).toHaveLength(2);
      expect(calls[0]?.name).toBe("skill_list");
      expect(calls[1]?.name).toBe("servers_list");
    });

    it("parses array of simple name/parameters objects", () => {
      const content = `[
        {"name": "snapshot_create", "parameters": {"serverId": "abc"}},
        {"name": "servers_restart", "arguments": {"serverId": "abc"}}
      ]`;
      const calls = extractToolCallsFromContent(content);
      expect(calls).toHaveLength(2);
      expect(calls[0]?.name).toBe("snapshot_create");
      expect(calls[1]?.name).toBe("servers_restart");
    });

    it("parses JSON blob embedded in prose", () => {
      const content = `I will create the server. {"type": "function", "function": {"name": "servers_create_from_skill", "parameters": {"skillName": "games.minecraft-paper"}}} This should work.`;
      const calls = extractToolCallsFromContent(content);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.name).toBe("servers_create_from_skill");
    });

    it("parses simple JSON blob embedded in prose", () => {
      const content = `Let me check that. {"name": "servers_status", "parameters": {"serverId": "test"}} for you.`;
      const calls = extractToolCallsFromContent(content);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.name).toBe("servers_status");
    });
  });

  describe("Fenced code block formats", () => {
    it("parses fenced JSON tool blobs", () => {
      const content = `Sure.\n\`\`\`json\n{"name":"panel_publish","arguments":{"serverId":"abc"}}\n\`\`\``;
      const calls = extractToolCallsFromContent(content);
      expect(calls[0]?.name).toBe("panel_publish");
      expect(calls[0]?.arguments).toEqual({ serverId: "abc" });
    });

    it("parses tool_code fenced blocks", () => {
      const content = `I'll help with that.\n\`\`\`tool_code\n{"name":"skill_read","parameters":{"skillName":"games.terraria"}}\n\`\`\``;
      const calls = extractToolCallsFromContent(content);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.name).toBe("skill_read");
      expect(calls[0]?.arguments).toEqual({ skillName: "games.terraria" });
    });

    it("parses tool fenced blocks", () => {
      const content = `\`\`\`tool\n{"name":"servers_list","parameters":{}}\n\`\`\``;
      const calls = extractToolCallsFromContent(content);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.name).toBe("servers_list");
    });
  });

  describe("Gemma Python-style function calls", () => {
    it("parses Python-style function call with string parameters", () => {
      const content = `\`\`\`tool_code\nservers_create_from_skill(skillName="games.minecraft-paper", serverName="Test Server")\n\`\`\``;
      const calls = extractToolCallsFromContent(content);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.name).toBe("servers_create_from_skill");
      expect(calls[0]?.arguments).toEqual({
        skillName: "games.minecraft-paper",
        serverName: "Test Server",
      });
    });

    it("parses Python-style function call with mixed parameters", () => {
      const content = `skill_read(skillName="games.valheim", verbose=true, maxDepth=3)`;
      const calls = extractToolCallsFromContent(content);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.name).toBe("skill_read");
      expect(calls[0]?.arguments).toEqual({
        skillName: "games.valheim",
        verbose: true,
        maxDepth: 3,
      });
    });

    it("parses Python-style function call with single quotes", () => {
      const content = `panel_publish(serverId='test-123', theme='grass')`;
      const calls = extractToolCallsFromContent(content);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.name).toBe("panel_publish");
      expect(calls[0]?.arguments).toEqual({
        serverId: "test-123",
        theme: "grass",
      });
    });

    it("parses Python-style function call with numeric parameters", () => {
      const content = `convert(amount=200000.0, currency="USD", new_currency="EUR")`;
      const calls = extractToolCallsFromContent(content);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.name).toBe("convert");
      expect(calls[0]?.arguments).toEqual({
        amount: 200000.0,
        currency: "USD",
        new_currency: "EUR",
      });
    });

    it("ignores Python calls without named parameters", () => {
      const content = `some_function(arg1, arg2, arg3)`;
      const calls = extractToolCallsFromContent(content);
      expect(calls).toHaveLength(0);
    });
  });

  describe("FunctionGemma XML-style formats", () => {
    it("parses XML function call with simple parameters", () => {
      const content = `<start_function_call>call:get_current_weather{location:Tokyo, Japan}<end_function_call>`;
      const calls = extractToolCallsFromContent(content);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.name).toBe("get_current_weather");
      expect(calls[0]?.arguments).toEqual({ location: "Tokyo, Japan" });
    });

    it("parses XML function call with multiple parameters", () => {
      const content = `<start_function_call>call:servers_create_from_skill{skillName:games.minecraft-paper,serverName:Test Server}<end_function_call>`;
      const calls = extractToolCallsFromContent(content);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.name).toBe("servers_create_from_skill");
      expect(calls[0]?.arguments).toEqual({
        skillName: "games.minecraft-paper",
        serverName: "Test Server",
      });
    });
  });

  describe("Edge cases and validation", () => {
    it("returns empty for normal prose", () => {
      expect(extractToolCallsFromContent("I can help set that up.")).toEqual(
        [],
      );
    });

    it("returns empty for empty string", () => {
      expect(extractToolCallsFromContent("")).toEqual([]);
    });

    it("returns empty for whitespace only", () => {
      expect(extractToolCallsFromContent("   \n\t  ")).toEqual([]);
    });

    it("handles malformed JSON gracefully", () => {
      const content = `{"name": "servers_list", "parameters": {incomplete`;
      const calls = extractToolCallsFromContent(content);
      expect(calls).toHaveLength(0);
    });

    it("prioritizes first valid format found", () => {
      const content = `{"name": "first_call", "parameters": {}}`;
      const calls = extractToolCallsFromContent(content);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.name).toBe("first_call");
    });

    it("handles missing function name gracefully", () => {
      const content = `{"type": "function", "function": {"parameters": {"test": "value"}}}`;
      const calls = extractToolCallsFromContent(content);
      expect(calls).toHaveLength(0);
    });

    it("handles invalid arguments as _raw", () => {
      const content = `{"type": "function", "function": {"name": "test", "parameters": "not-a-json-object"}}`;
      const calls = extractToolCallsFromContent(content);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.name).toBe("test");
      expect(calls[0]?.arguments).toEqual({ _raw: "not-a-json-object" });
    });
  });

  describe("Realistic Gemma-style examples", () => {
    it("parses Gemma tool_code block with prose", () => {
      const content = `Okay, I need to convert $200,000 to EUR. I will use the \`convert\` function for this.
\`\`\`tool_code
convert(amount=200000.0, currency="USD", new_currency="EUR")
\`\`\``;
      const calls = extractToolCallsFromContent(content);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.name).toBe("convert");
      expect(calls[0]?.arguments).toEqual({
        amount: 200000.0,
        currency: "USD",
        new_currency: "EUR",
      });
    });

    it("parses Gemma JSON style with explanatory prose", () => {
      const content = `I will create a Minecraft server for you.
{"name": "servers_create_from_skill", "parameters": {"skillName": "games.minecraft-paper", "serverName": "My Paper Server"}}
This will set up your server.`;
      const calls = extractToolCallsFromContent(content);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.name).toBe("servers_create_from_skill");
      expect(calls[0]?.arguments).toEqual({
        skillName: "games.minecraft-paper",
        serverName: "My Paper Server",
      });
    });
  });
});

describe("looksLikeToolShapedContent", () => {
  it("detects fake tool JSON and fenced tool blocks", () => {
    expect(
      looksLikeToolShapedContent(
        '{"type": "function", "function": {"name": "servers_list", "parameters": {}}}',
      ),
    ).toBe(true);
    expect(looksLikeToolShapedContent("```tool_code\nservers_list()\n```")).toBe(true);
    expect(looksLikeToolShapedContent('{"name":"servers_get","arguments":{"serverId":"x"}}')).toBe(
      true,
    );
  });

  it("detects Gemma Python and FunctionGemma XML shapes", () => {
    expect(
      looksLikeToolShapedContent(
        'servers_create_from_skill(skillName="games.minecraft-paper", serverName="Test")',
      ),
    ).toBe(true);
    expect(
      looksLikeToolShapedContent(
        "<start_function_call>call:servers_list{}<end_function_call>",
      ),
    ).toBe(true);
  });

  it("ignores ordinary assistant prose", () => {
    expect(looksLikeToolShapedContent("Hello — what should we install?")).toBe(false);
    expect(looksLikeToolShapedContent("")).toBe(false);
  });
});

describe("NVIDIA-shaped sequential tool calling", () => {
  it("detects NVIDIA preset, host, and 8B model ids", () => {
    expect(isSequentialToolCallingBackend({ preset: "nvidia" })).toBe(true);
    expect(
      isSequentialToolCallingBackend({
        baseUrl: "https://integrate.api.nvidia.com/v1",
      }),
    ).toBe(true);
    expect(
      isSequentialToolCallingBackend({ model: "meta/llama-3.1-8b-instruct" }),
    ).toBe(true);
    expect(isSequentialToolCallingBackend({ preset: "venice", model: "grok-4-5" })).toBe(
      false,
    );
  });

  it("sends parallel_tool_calls=false and keeps a single tool_call", async () => {
    let posted: Record<string, unknown> | undefined;
    const fetchImpl: typeof fetch = async (_url, init) => {
      posted = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "1",
                    function: { name: "servers_list", arguments: "{}" },
                  },
                  {
                    id: "2",
                    function: {
                      name: "snapshot_create",
                      arguments: '{"serverId":"live-friend"}',
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const client = new OpenAICompatibleLlmClient(
      "https://integrate.api.nvidia.com/v1",
      "nvapi-test",
      "meta/llama-3.1-8b-instruct",
      "openai_compatible",
      {
        parallelToolCalls: false,
        maxToolCallsPerCompletion: 1,
        fetchImpl,
      },
    );

    const result = await client.complete(
      [{ role: "user", content: "spin up" }],
      [
        { name: "servers_list", description: "list", parameters: {} },
        { name: "snapshot_create", description: "snap", parameters: {} },
      ],
    );

    expect(posted?.parallel_tool_calls).toBe(false);
    expect(posted?.tool_choice).toBe("auto");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0]?.name).toBe("servers_list");
  });

  it("leaves Venice completions with multiple tool_calls intact when uncapped", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  { id: "1", function: { name: "servers_list", arguments: "{}" } },
                  { id: "2", function: { name: "skill_list", arguments: "{}" } },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const client = new OpenAICompatibleLlmClient(
      "https://api.venice.ai/api/v1",
      "key",
      "grok-4-5",
      "openai_compatible",
      { fetchImpl },
    );
    const result = await client.complete(
      [{ role: "user", content: "list" }],
      [{ name: "servers_list", description: "l", parameters: {} }],
    );
    expect(result.toolCalls).toHaveLength(2);
  });

  it("surfaces provider reasoning_content on the completion", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "",
                reasoning_content:
                  "Looks like win-1 is still on 0.2.10, so I’ll swap from the extracted tar.",
                tool_calls: [{ id: "1", function: { name: "node_ping", arguments: "{}" } }],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const client = new OpenAICompatibleLlmClient(
      "https://api.venice.ai/api/v1",
      "key",
      "grok-4-5",
      "openai_compatible",
      { fetchImpl },
    );
    const result = await client.complete(
      [{ role: "user", content: "update" }],
      [{ name: "node_ping", description: "p", parameters: {} }],
    );
    expect(result.reasoning).toMatch(/win-1 is still on 0\.2\.10/);
    expect(result.toolCalls?.[0]?.name).toBe("node_ping");
  });
});

describe("Gemini thought_signature round-trip", () => {
  const geminiSig = "CiQAAAA-gemini-thought-sig";

  it("detects the native Gemini OpenAI-compat host, not OpenRouter", () => {
    expect(isGeminiOpenAiCompatBackend({ preset: "gemini" })).toBe(true);
    expect(
      isGeminiOpenAiCompatBackend({
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      }),
    ).toBe(true);
    expect(
      isGeminiOpenAiCompatBackend({
        preset: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
      }),
    ).toBe(false);
  });

  it("persists extra_content.google.thought_signature and sends it on the tool follow-up", async () => {
    const posted: Array<Record<string, unknown>> = [];
    let round = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      posted.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      round += 1;
      if (round === 1) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "",
                  tool_calls: [
                    {
                      id: "function-call-1",
                      type: "function",
                      extra_content: {
                        google: { thought_signature: geminiSig },
                      },
                      function: {
                        name: "servers_list",
                        arguments: "{}",
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "listed" } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const client = new OpenAICompatibleLlmClient(
      "https://generativelanguage.googleapis.com/v1beta/openai",
      "gai-test",
      "gemini-3.1-flash-lite",
      "openai_compatible",
      { fetchImpl },
    );

    const first = await client.complete(
      [{ role: "user", content: "list servers" }],
      [{ name: "servers_list", description: "list", parameters: {} }],
    );
    expect(first.toolCalls).toHaveLength(1);
    expect(googleThoughtSignature(first.toolCalls?.[0]?.extraContent)).toBe(geminiSig);

    const second = await client.complete(
      [
        { role: "user", content: "list servers" },
        {
          role: "assistant",
          content: "",
          toolCalls: first.toolCalls,
        },
        {
          role: "tool",
          name: "servers_list",
          toolCallId: "function-call-1",
          content: "[]",
        },
      ],
      [{ name: "servers_list", description: "list", parameters: {} }],
    );
    expect(second.content).toBe("listed");

    const followUp = posted[1];
    expect(followUp).toBeDefined();
    const messages = followUp?.messages as Array<Record<string, unknown>>;
    const assistant = messages.find((m) => m.role === "assistant" && Array.isArray(m.tool_calls));
    expect(assistant).toBeDefined();
    const toolCalls = assistant?.tool_calls as Array<Record<string, unknown>>;
    expect(toolCalls[0]?.extra_content).toEqual({
      google: { thought_signature: geminiSig },
    });
  });

  it("does not invent extra_content on Venice/OpenRouter-shaped tool_calls", async () => {
    let posted: Record<string, unknown> | undefined;
    const fetchImpl: typeof fetch = async (_url, init) => {
      posted = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const client = new OpenAICompatibleLlmClient(
      "https://openrouter.ai/api/v1",
      "or-key",
      "google/gemini-2.5-flash",
      "openai_compatible",
      { fetchImpl },
    );
    await client.complete(
      [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "1", name: "servers_list", arguments: {} }],
        },
        { role: "tool", name: "servers_list", toolCallId: "1", content: "[]" },
      ],
      [{ name: "servers_list", description: "list", parameters: {} }],
    );
    const messages = posted?.messages as Array<Record<string, unknown>>;
    const assistant = messages.find((m) => m.role === "assistant");
    const toolCalls = assistant?.tool_calls as Array<Record<string, unknown>>;
    expect(toolCalls[0]?.extra_content).toBeUndefined();
  });
});

describe("transient LLM HTTP / network classification", () => {
  it("retries 429/502/503/504 and not 4xx model errors", () => {
    expect(isTransientLlmHttpStatus(429)).toBe(true);
    expect(isTransientLlmHttpStatus(502)).toBe(true);
    expect(isTransientLlmHttpStatus(503)).toBe(true);
    expect(isTransientLlmHttpStatus(504)).toBe(true);
    expect(isTransientLlmHttpStatus(400)).toBe(false);
    expect(isTransientLlmHttpStatus(401)).toBe(false);
    expect(isTransientLlmHttpStatus(500)).toBe(false);
  });

  it("treats fetch-failed / reset as transient and abort as terminal", () => {
    expect(isTransientLlmNetworkError(new TypeError("fetch failed"))).toBe(true);
    const reset = new Error("socket hang up") as Error & { code?: string };
    reset.code = "ECONNRESET";
    expect(isTransientLlmNetworkError(reset)).toBe(true);
    const wrapped = new TypeError("fetch failed", {
      cause: Object.assign(new Error("reset"), { code: "UND_ERR_SOCKET" }),
    });
    expect(isTransientLlmNetworkError(wrapped)).toBe(true);
    const abort = new DOMException("The operation was aborted.", "AbortError");
    expect(isLlmAbortError(abort)).toBe(true);
    expect(isTransientLlmNetworkError(abort)).toBe(false);
  });

  it("honors Retry-After seconds and falls back when the header is absent", () => {
    const withHeader = new Response("", {
      status: 429,
      headers: { "retry-after": "2" },
    });
    expect(llmRetryDelayMs(withHeader, 400)).toBe(2000);
    expect(llmRetryDelayMs(new Response("", { status: 502 }), 400)).toBe(400);
    expect(llmRetryDelayMs(undefined, 800)).toBe(800);
  });

  it("caps Retry-After and includes attempt count on exhausted HTTP errors", () => {
    const long = new Response("", {
      status: 429,
      headers: { "retry-after": "120" },
    });
    expect(llmRetryDelayMs(long, 400)).toBe(10_000);
    expect(formatLlmHttpError(502, "<html>Bad Gateway</html>", 4).message).toBe(
      "LLM request failed (502) after 4 attempts: <html>Bad Gateway</html>",
    );
    expect(formatLlmHttpError(400, "empty function name", 1).message).toBe(
      "LLM request failed (400): empty function name",
    );
  });
});

describe("OpenAI-compatible transient retries", () => {
  const okBody = JSON.stringify({
    choices: [{ message: { content: "recovered" } }],
  });

  it("retries Venice HTTP 502 then succeeds without changing the posted body", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    let posted: Record<string, unknown> | undefined;
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls += 1;
      posted = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (calls < 3) {
        return new Response("Bad Gateway", { status: 502 });
      }
      return new Response(okBody, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new OpenAICompatibleLlmClient(
      "https://api.venice.ai/api/v1",
      "key",
      "grok-4-5",
      "openai_compatible",
      {
        fetchImpl,
        transientRetryBaseMs: 250,
        sleepImpl: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    const result = await client.complete([{ role: "user", content: "hello" }]);
    expect(result.content).toBe("recovered");
    expect(calls).toBe(3);
    expect(sleeps).toEqual([250, 500]);
    expect(posted?.model).toBe("grok-4-5");
    expect(posted?.venice_parameters).toEqual({ include_venice_system_prompt: false });
    expect(warn.mock.calls.some((c) => String(c[0]).includes("LLM transient HTTP 502"))).toBe(
      true,
    );
    warn.mockRestore();
  });

  it("honors Retry-After on 429 before the successful retry", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "1" },
        });
      }
      return new Response(okBody, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new OpenAICompatibleLlmClient(
      "https://api.venice.ai/api/v1",
      "key",
      "grok-4-5",
      "openai_compatible",
      {
        fetchImpl,
        sleepImpl: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    const result = await client.complete([{ role: "user", content: "hello" }]);
    expect(result.content).toBe("recovered");
    expect(calls).toBe(2);
    expect(sleeps).toEqual([1000]);
    warn.mockRestore();
  });

  it("does not retry a 400 model error", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response("empty function name", { status: 400 });
    };
    const client = new OpenAICompatibleLlmClient(
      "https://api.venice.ai/api/v1",
      "key",
      "grok-4-5",
      "openai_compatible",
      { fetchImpl, sleepImpl: async () => undefined },
    );
    await expect(client.complete([{ role: "user", content: "hello" }])).rejects.toThrow(
      /LLM request failed \(400\): empty function name/,
    );
    expect(calls).toBe(1);
  });

  it("fails clearly after exhausting 502 retries", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response("<html>Bad Gateway</html>", { status: 502 });
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new OpenAICompatibleLlmClient(
      "https://api.venice.ai/api/v1",
      "key",
      "grok-4-5",
      "openai_compatible",
      {
        fetchImpl,
        transientRetries: 2,
        sleepImpl: async () => undefined,
      },
    );
    await expect(client.complete([{ role: "user", content: "hello" }])).rejects.toThrow(
      /LLM request failed \(502\) after 3 attempts: <html>Bad Gateway<\/html>/,
    );
    expect(calls).toBe(3);
    warn.mockRestore();
  });

  it("retries fetch-failed then succeeds", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return new Response(okBody, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new OpenAICompatibleLlmClient(
      "https://api.venice.ai/api/v1",
      "key",
      "grok-4-5",
      "openai_compatible",
      { fetchImpl, sleepImpl: async () => undefined },
    );
    const result = await client.complete([{ role: "user", content: "hello" }]);
    expect(result.content).toBe("recovered");
    expect(calls).toBe(2);
    warn.mockRestore();
  });

  it("does not retry when the caller already aborted", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response("should not run", { status: 502 });
    };
    const client = new OpenAICompatibleLlmClient(
      "https://api.venice.ai/api/v1",
      "key",
      "grok-4-5",
      "openai_compatible",
      { fetchImpl, sleepImpl: async () => undefined },
    );
    const signal = AbortSignal.abort();
    await expect(
      client.complete([{ role: "user", content: "hello" }], undefined, { signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(0);
  });
});

