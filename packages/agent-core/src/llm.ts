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
  /**
   * Provider extras that must round-trip on the next request.
   * Gemini OpenAI-compat: `{ google: { thought_signature } }` on functionCall parts.
   */
  extraContent?: Record<string, unknown>;
}

export interface LlmCompletion {
  content: string;
  toolCalls?: LlmToolCall[];
  /**
   * Provider reasoning / thinking text when the backend already returns it
   * (e.g. `reasoning_content`). Not a second model call. May be empty.
   */
  reasoning?: string;
}

export type LlmCompleteOptions = {
  signal?: AbortSignal;
  /** Internal: set to true to skip retry nudge (prevents infinite loops). */
  _skipRetryNudge?: boolean;
};

export interface LlmClient {
  readonly mode: "openai_compatible" | "ollama";
  /**
   * When 1, this backend only accepts a single tool-call per completion
   * (NVIDIA llama-3.1-8b: "model only supports a single tool-call at once").
   */
  readonly maxToolCallsPerCompletion?: number;
  complete(
    messages: LlmMessage[],
    tools?: ToolDefinition[],
    opts?: LlmCompleteOptions,
  ): Promise<LlmCompletion>;
}

/** NVIDIA NIM 8B (and the NVIDIA preset) reject parallel tool_calls in one completion. */
export function isSequentialToolCallingBackend(input: {
  preset?: string | null;
  baseUrl?: string | null;
  model?: string | null;
}): boolean {
  const preset = (input.preset ?? "").toLowerCase();
  const base = (input.baseUrl ?? "").toLowerCase();
  const model = (input.model ?? "").toLowerCase();
  if (preset === "nvidia") return true;
  if (base.includes("integrate.api.nvidia.com")) return true;
  if (model.includes("llama-3.1-8b")) return true;
  return false;
}

/** Native Gemini OpenAI-compat (not OpenRouter `google/gemini-*`). */
export function isGeminiOpenAiCompatBackend(input: {
  preset?: string | null;
  baseUrl?: string | null;
}): boolean {
  const preset = (input.preset ?? "").toLowerCase();
  const base = (input.baseUrl ?? "").toLowerCase();
  if (preset === "gemini") return true;
  return base.includes("generativelanguage.googleapis.com");
}

export function asExtraContent(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function googleThoughtSignature(
  extra: Record<string, unknown> | undefined,
): string | undefined {
  const google = extra?.google;
  if (!google || typeof google !== "object" || Array.isArray(google)) return undefined;
  const sig = (google as { thought_signature?: unknown }).thought_signature;
  return typeof sig === "string" && sig ? sig : undefined;
}

function extraContentForWire(
  extra: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!extra || Object.keys(extra).length === 0) return undefined;
  return extra;
}

interface OpenAiChatResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        id: string;
        function: { name: string; arguments: string };
        extra_content?: Record<string, unknown>;
      }>;
    };
  }>;
  error?: { message?: string } | string;
}

/** Prefer provider reasoning fields; skip signature-shaped blobs. */
export function extractProviderReasoning(
  message:
    | {
        reasoning_content?: string | null;
        reasoning?: string | null;
      }
    | undefined,
): string | undefined {
  if (!message) return undefined;
  const raw = message.reasoning_content ?? message.reasoning;
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  if (text.length < 8) return undefined;
  if (!/\s/.test(text) && /^[A-Za-z0-9+/=_-]{40,}$/.test(text)) return undefined;
  return text;
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
 * True when assistant text looks like a printed/failed tool call rather than
 * normal prose. Single helper for Gemma retry nudge (#840) and degraded-mode (#845).
 */
export function looksLikeToolShapedContent(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (/```(?:json|tool|tool_code)\b/i.test(trimmed)) return true;
  if (/<\s*(?:function|tool_call|call)\b/i.test(trimmed)) return true;
  if (/\btool_code\b/i.test(trimmed)) return true;
  if (/"type"\s*:\s*"function"/i.test(trimmed)) return true;
  if (
    /"name"\s*:\s*"[a-zA-Z0-9_-]+"/.test(trimmed) &&
    /"(?:arguments|parameters)"\s*:/.test(trimmed)
  ) {
    return true;
  }
  const indicators = [
    /\{[^}]*"name"\s*:/i,
    /\{[^}]*"function"\s*:/i,
    /\{[^}]*"type"\s*:\s*"function"/i,
    /<start_function_call>/i,
    /```\s*tool/i,
    /\w+\([^)]*=/, // Python-style function(param=value)
  ];
  return indicators.some((pattern) => pattern.test(trimmed));
}

/**
 * Recover tool calls when a model emits text-based tool formats
 * instead of native `tool_calls` (Gemma, weaker models, intermittent Venice).
 * Supports: OpenAI/Hermes JSON, Python-style calls, XML tags, fenced blocks.
 */
export function extractToolCallsFromContent(content: string): LlmToolCall[] {
  const trimmed = content.trim();
  if (!trimmed) return [];

  const candidates: string[] = [trimmed];
  
  // Extract fenced blocks: ```json, ```tool_code, ```tool
  const fencedMatches = [
    ...trimmed.matchAll(/```(?:json|tool_code|tool)?\s*([\s\S]*?)```/gi),
  ];
  for (const match of fencedMatches) {
    if (match[1]) candidates.push(match[1].trim());
  }

  const calls: LlmToolCall[] = [];
  const push = (name: unknown, args: unknown, idHint: string) => {
    if (typeof name !== "string" || !name.trim()) return;
    calls.push({
      id: idHint,
      name: name.trim(),
      arguments: asArgObject(args),
    });
  };

  // Try parsing each candidate as JSON
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

  // Scan for Python-style function calls: func_name(param1=value1, param2="value2")
  // Common in Gemma ```tool_code``` blocks
  const pythonCallRe = /(\w+)\s*\(\s*([^)]*)\s*\)/g;
  let match: RegExpExecArray | null;
  let idx = 0;
  while ((match = pythonCallRe.exec(trimmed)) !== null) {
    const funcName = match[1];
    const argsStr = match[2];
    if (!funcName || !argsStr?.includes("=")) continue;
    
    try {
      const args: Record<string, unknown> = {};
      // Parse key=value pairs, handling quoted strings and numbers
      const argMatches = [
        ...argsStr.matchAll(/(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([\d.]+)|(\w+))/g),
      ];
      for (const argMatch of argMatches) {
        const key = argMatch[1];
        const value = argMatch[2] ?? argMatch[3] ?? argMatch[4] ?? argMatch[5];
        if (key && value !== undefined) {
          // Try to parse as number or boolean
          if (/^\d+\.?\d*$/.test(value)) {
            args[key] = parseFloat(value);
          } else if (value === "true") {
            args[key] = true;
          } else if (value === "false") {
            args[key] = false;
          } else {
            args[key] = value;
          }
        }
      }
      if (Object.keys(args).length > 0) {
        push(funcName, args, `python-${idx++}`);
      }
    } catch {
      // ignore malformed python calls
    }
  }
  if (calls.length) return calls;

  // Scan for XML-style function calls: <start_function_call>call:func_name{param:value}<end_function_call>
  // Used by FunctionGemma and some Gemma variants
  const xmlCallRe = /<start_function_call>call:(\w+)\{([^}]+)\}<end_function_call>/g;
  idx = 0;
  while ((match = xmlCallRe.exec(trimmed)) !== null) {
    const funcName = match[1];
    const argsStr = match[2];
    if (!funcName) continue;
    
    try {
      const args: Record<string, unknown> = {};
      // Parse key:value pairs. Need to handle commas in values carefully.
      // Strategy: find first colon, that splits key from value. Then find next key by looking for pattern "word:"
      const keyValueRe = /(\w+):\s*([^,]*?)(?=,\s*\w+:|$)/g;
      let kvMatch: RegExpExecArray | null;
      while ((kvMatch = keyValueRe.exec(argsStr)) !== null) {
        const key = kvMatch[1];
        const value = kvMatch[2]?.trim();
        if (key && value) {
          args[key] = value;
        }
      }
      
      // Fallback: if regex didn't work, try simple split
      if (Object.keys(args).length === 0) {
        const colonIdx = argsStr.indexOf(":");
        if (colonIdx > 0) {
          const key = argsStr.slice(0, colonIdx).trim();
          const value = argsStr.slice(colonIdx + 1).trim();
          if (key) args[key] = value;
        }
      }
      
      if (Object.keys(args).length > 0) {
        push(funcName, args, `xml-${idx++}`);
      }
    } catch {
      // ignore malformed XML calls
    }
  }
  if (calls.length) return calls;

  // Scan for loose JSON blobs in prose: {"type":"function","function":{...}}
  const blobRe =
    /\{\s*"type"\s*:\s*"function"\s*,\s*"function"\s*:\s*\{[\s\S]*?\}\s*\}/g;
  idx = 0;
  while ((match = blobRe.exec(trimmed)) !== null) {
    try {
      const parsed = JSON.parse(match[0]) as {
        function?: { name?: string; parameters?: unknown; arguments?: unknown };
      };
      push(
        parsed.function?.name,
        parsed.function?.parameters ?? parsed.function?.arguments,
        `blob-${idx++}`,
      );
    } catch {
      // ignore partial matches
    }
  }
  
  // Scan for simpler JSON blobs: {"name":"func","parameters":{...}} or {"name":"func","arguments":{...}}
  const simpleJsonRe = /\{\s*"name"\s*:\s*"(\w+)"\s*,\s*"(?:parameters|arguments)"\s*:\s*\{[^}]*\}\s*\}/g;
  idx = 0;
  while ((match = simpleJsonRe.exec(trimmed)) !== null) {
    try {
      const parsed = JSON.parse(match[0]) as {
        name?: string;
        parameters?: unknown;
        arguments?: unknown;
      };
      push(
        parsed.name,
        parsed.parameters ?? parsed.arguments,
        `simple-json-${idx++}`,
      );
    } catch {
      // ignore partial matches
    }
  }

  return calls;
}

export type OpenAICompatibleLlmClientOptions = {
  /**
   * Advertise parallel tool_calls. Default false (Venice/Ollama/NVIDIA all prefer sequential).
   * Sequential backends also cap accepted tool_calls at `maxToolCallsPerCompletion`.
   */
  parallelToolCalls?: boolean;
  /** Cap native + recovered tool_calls. NVIDIA 8B must be 1. */
  maxToolCallsPerCompletion?: number;
  fetchImpl?: typeof fetch;
};

/** Calls POST .../chat/completions on an OpenAI-compatible endpoint (Venice, Ollama, …). */
export class OpenAICompatibleLlmClient implements LlmClient {
  readonly mode: "openai_compatible" | "ollama";
  readonly maxToolCallsPerCompletion?: number;
  private readonly parallelToolCalls: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
    mode: "openai_compatible" | "ollama" = "openai_compatible",
    options: OpenAICompatibleLlmClientOptions = {},
  ) {
    this.mode = mode;
    this.parallelToolCalls = options.parallelToolCalls ?? false;
    this.maxToolCallsPerCompletion = options.maxToolCallsPerCompletion;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(
    messages: LlmMessage[],
    tools?: ToolDefinition[],
    opts?: LlmCompleteOptions,
  ): Promise<LlmCompletion> {
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
            tool_calls: m.toolCalls.map((tc) => {
              const extra = extraContentForWire(tc.extraContent);
              return {
                id: tc.id,
                type: "function",
                function: {
                  name: tc.name,
                  arguments: JSON.stringify(tc.arguments ?? {}),
                },
                ...(extra ? { extra_content: extra } : {}),
              };
            }),
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
      // Several Venice models (and some Ollama ports) reject parallel tool batches.
      // NVIDIA 8B 500s: "model only supports a single tool-call at once".
      body.parallel_tool_calls = this.parallelToolCalls;
    }

    if (this.baseUrl.includes("venice.ai")) {
      // Prefer our agent system prompt over Venice's default chat persona.
      body.venice_parameters = {
        include_venice_system_prompt: false,
      };
    }

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    const res = await this.fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: opts?.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`LLM request failed (${res.status}): ${text.slice(0, 800)}`);
    }

    const data = (await res.json()) as OpenAiChatResponse;
    const message = data.choices?.[0]?.message;
    const content = message?.content ?? "";
    let toolCalls = message?.tool_calls?.map((tc) => {
      const extra = asExtraContent(tc.extra_content);
      return {
        id: tc.id,
        name: tc.function.name,
        arguments: parseToolArguments(tc.function.arguments || "{}"),
        ...(extra ? { extraContent: extra } : {}),
      };
    });

    if (!toolCalls?.length && tools?.length) {
      const recovered = extractToolCallsFromContent(content);
      if (recovered.length) {
        toolCalls = recovered;
      } else if (
        !opts?._skipRetryNudge &&
        looksLikeToolShapedContent(content)
      ) {
        // Content looks tool-shaped but recovery failed. Try once with a nudge.
        const nudgeMessage: LlmMessage = {
          role: "system",
          content:
            "Use native tool_calls (not printed JSON or prose). Emit tool calls properly formatted for the API.",
        };
        const retryMessages = [...messages, nudgeMessage];
        return this.complete(retryMessages, tools, {
          ...opts,
          _skipRetryNudge: true,
        });
      }
    }

    const capped =
      this.maxToolCallsPerCompletion && toolCalls && toolCalls.length > this.maxToolCallsPerCompletion
        ? toolCalls.slice(0, this.maxToolCallsPerCompletion)
        : toolCalls;

    const reasoning = extractProviderReasoning(message);

    return {
      // When we recovered tool calls from content, clear content so the orchestrator
      // doesn't surface raw function JSON as the user-visible reply.
      content: capped?.length && !message?.tool_calls?.length ? "" : content,
      toolCalls: capped?.length ? capped : undefined,
      ...(reasoning ? { reasoning } : {}),
    };
  }
}
