import { describe, expect, it } from "vitest";
import {
  extractToolCallsFromContent,
  isSequentialToolCallingBackend,
  looksLikeToolShapedContent,
  OpenAICompatibleLlmClient,
} from "./llm.js";

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
});

