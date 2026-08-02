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
  readonly mode: "openai_compatible" | "ollama";
  complete(messages: LlmMessage[], tools?: ToolDefinition[]): Promise<LlmCompletion>;
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

function asArgObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") return parseToolArguments(value);
  return {};
}

/**
 * Recover tool calls when a model emits OpenAI/Hermes-style JSON in content
 * instead of native `tool_calls` (common intermittent Venice behavior).
 */
export function extractToolCallsFromContent(content: string): LlmToolCall[] {
  const trimmed = content.trim();
  if (!trimmed) return [];

  const candidates: string[] = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const calls: LlmToolCall[] = [];
  const push = (name: unknown, args: unknown, idHint: string) => {
    if (typeof name !== "string" || !name.trim()) return;
    calls.push({
      id: idHint,
      name: name.trim(),
      arguments: asArgObject(args),
    });
  };

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (Array.isArray(parsed)) {
        parsed.forEach((item, idx) => {
          if (!item || typeof item !== "object") return;
          const rec = item as Record<string, unknown>;
          const fn = rec.function;
          if (fn && typeof fn === "object") {
            const f = fn as Record<string, unknown>;
            push(f.name, f.parameters ?? f.arguments, `content-${idx}`);
            return;
          }
          push(rec.name, rec.parameters ?? rec.arguments, `content-${idx}`);
        });
      } else if (parsed && typeof parsed === "object") {
        const rec = parsed as Record<string, unknown>;
        const fn = rec.function;
        if (fn && typeof fn === "object") {
          const f = fn as Record<string, unknown>;
          push(f.name, f.parameters ?? f.arguments, "content-0");
        } else if (typeof rec.name === "string") {
          push(rec.name, rec.parameters ?? rec.arguments, "content-0");
        }
      }
    } catch {
      // keep scanning
    }
    if (calls.length) return calls;
  }

  // Loose scan for {"type":"function","function":{...}} blobs in prose.
  const blobRe =
    /\{\s*"type"\s*:\s*"function"\s*,\s*"function"\s*:\s*\{[\s\S]*?\}\s*\}/g;
  let match: RegExpExecArray | null;
  let idx = 0;
  while ((match = blobRe.exec(trimmed)) !== null) {
    try {
      const parsed = JSON.parse(match[0]) as {
        function?: { name?: string; parameters?: unknown; arguments?: unknown };
      };
      push(
        parsed.function?.name,
        parsed.function?.parameters ?? parsed.function?.arguments,
        `content-scan-${idx++}`,
      );
    } catch {
      // ignore partial matches
    }
  }
  return calls;
}

/** Calls POST .../chat/completions on an OpenAI-compatible endpoint (Venice, Ollama, …). */
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
      body.tool_choice = "auto";
    }

    if (this.baseUrl.includes("venice.ai")) {
      // Prefer our persona system prompts over Venice's default chat persona.
      body.venice_parameters = {
        include_venice_system_prompt: false,
      };
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
    const content = message?.content ?? "";
    let toolCalls = message?.tool_calls?.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: parseToolArguments(tc.function.arguments || "{}"),
    }));

    if (!toolCalls?.length && tools?.length) {
      const recovered = extractToolCallsFromContent(content);
      if (recovered.length) {
        toolCalls = recovered;
      }
    }

    return {
      // When we recovered tool calls from content, clear content so the orchestrator
      // doesn't surface raw function JSON as the user-visible reply.
      content: toolCalls?.length && !message?.tool_calls?.length ? "" : content,
      toolCalls: toolCalls?.length ? toolCalls : undefined,
    };
  }
}
