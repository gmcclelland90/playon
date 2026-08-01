import type { ToolDefinition } from "./tools.js";

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: LlmToolCall[];
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LlmCompletion {
  content: string;
  toolCalls?: LlmToolCall[];
}

export interface LlmClient {
  readonly mode: "mock" | "openai_compatible" | "ollama";
  complete(messages: LlmMessage[], tools?: ToolDefinition[]): Promise<LlmCompletion>;
}

/** Deterministic stub for CI / autonomous loops. */
export class MockLlmClient implements LlmClient {
  readonly mode = "mock" as const;

  constructor(private readonly reply: LlmCompletion = { content: "Mock LLM ready." }) {}

  async complete(_messages: LlmMessage[], _tools?: ToolDefinition[]): Promise<LlmCompletion> {
    return this.reply;
  }
}

const FIXTURE_PATTERN = /fake-http|fixture|test server/i;
const PAPER_PATTERN = /minecraft|paper/i;

type MockInstallTarget = {
  skillName: string;
  serverName: string;
  port: number;
  doneMessage: string;
};

function resolveInstallTarget(userText: string): MockInstallTarget | null {
  if (FIXTURE_PATTERN.test(userText)) {
    return {
      skillName: "fixtures.fake-http-game",
      serverName: "Fake HTTP Fixture",
      port: 8080,
      doneMessage:
        "Installed the fake-http fixture server and published join + status blocks to the player panel.",
    };
  }
  if (PAPER_PATTERN.test(userText)) {
    return {
      skillName: "games.minecraft-paper",
      serverName: "Paper Minecraft",
      port: 25565,
      doneMessage:
        "Created the Paper Minecraft server (mock runtime) and published join + status blocks to the player panel.",
    };
  }
  return null;
}

/** Mock client that emits tool calls for fixture / reference-skill install flows. */
export class IntentMockLlmClient implements LlmClient {
  readonly mode = "mock" as const;

  async complete(messages: LlmMessage[], _tools?: ToolDefinition[]): Promise<LlmCompletion> {
    const userText = messages
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join("\n");

    const target = resolveInstallTarget(userText);
    if (!target) {
      return {
        content:
          "PlayOn is running in mock LLM mode. Configure an OpenAI-compatible or Ollama provider under Settings → Model settings to enable live model routing.",
      };
    }

    const toolMessages = messages.filter((m) => m.role === "tool");
    const createDone = toolMessages.some((m) => m.name === "servers_create_from_skill");
    const publishDone = toolMessages.some((m) => m.name === "panel_publish");

    if (!createDone) {
      return {
        content: "",
        toolCalls: [
          {
            id: "call-create-skill",
            name: "servers_create_from_skill",
            arguments: { skillName: target.skillName, serverName: target.serverName },
          },
        ],
      };
    }

    if (!publishDone) {
      const createResult = toolMessages.find((m) => m.name === "servers_create_from_skill");
      let serverId = "unknown";
      if (createResult?.content) {
        try {
          const parsed = JSON.parse(createResult.content) as { serverId?: string };
          serverId = parsed.serverId ?? serverId;
        } catch {
          /* ignore */
        }
      }

      return {
        content: "",
        toolCalls: [
          {
            id: "call-panel-publish",
            name: "panel_publish",
            arguments: {
              serverId,
              blocks: [
                {
                  type: "join_info",
                  title: "Join",
                  body: { address: "127.0.0.1", port: target.port },
                },
                {
                  type: "server_status",
                  title: "Status",
                  body: { status: "stopped" },
                },
              ],
            },
          },
        ],
      };
    }

    return { content: target.doneMessage };
  }
}


interface OpenAiChatResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        function: { name: string; arguments: string };
      }>;
    };
  }>;
  error?: { message?: string } | string;
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}") as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return { _raw: raw };
  }
}

/** Calls POST .../chat/completions on an OpenAI-compatible endpoint. */
export class OpenAICompatibleLlmClient implements LlmClient {
  readonly mode: "openai_compatible" | "ollama";

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
    mode: "openai_compatible" | "ollama" = "openai_compatible",
  ) {
    this.mode = mode;
  }

  async complete(messages: LlmMessage[], tools?: ToolDefinition[]): Promise<LlmCompletion> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map((m) => {
        if (m.role === "tool") {
          return {
            role: "tool",
            content: m.content,
            tool_call_id: m.toolCallId,
          };
        }
        if (m.role === "assistant" && m.toolCalls?.length) {
          return {
            role: "assistant",
            content: m.content || null,
            tool_calls: m.toolCalls.map((tc) => ({
              id: tc.id,
              type: "function",
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments ?? {}),
              },
            })),
          };
        }
        return { role: m.role, content: m.content };
      }),
    };

    if (tools?.length) {
      // Venice (and many OpenAI-compatible providers) require tool function names
      // matching ^[a-zA-Z0-9_-]{1,128}$ — no dots.
      body.tools = tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`LLM request failed (${res.status}): ${text.slice(0, 800)}`);
    }

    const data = (await res.json()) as OpenAiChatResponse;
    const message = data.choices?.[0]?.message;
    const toolCalls = message?.tool_calls?.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: parseToolArguments(tc.function.arguments || "{}"),
    }));

    return {
      content: message?.content ?? "",
      toolCalls: toolCalls?.length ? toolCalls : undefined,
    };
  }
}
