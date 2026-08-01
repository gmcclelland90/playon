import type { LlmClient, LlmMessage } from "./llm.js";
import {
  PERSONA_SYSTEM_PROMPTS,
  toolsAllowedForPersona,
  type AgentPersona,
} from "./personas.js";
import { toLlmToolDefinition, type ToolDefinition, type ToolHandler } from "./tools.js";

export type { AgentPersona };

export interface ToolTraceEntry {
  name: string;
  arguments: Record<string, unknown>;
  result: unknown;
}

export interface OrchestratorResult {
  persona: AgentPersona;
  content: string;
  toolTrace: ToolTraceEntry[];
}

export interface ConfirmRequest {
  requestId: string;
  toolName: string;
  summary: string;
  arguments: Record<string, unknown>;
}

/** Host confirmation gate (plan: host.confirm). */
export interface ConfirmGate {
  requestConfirmation(request: Omit<ConfirmRequest, "requestId">): Promise<{
    requestId: string;
    approved: boolean;
  }>;
}

export interface ChatStreamSink {
  conversationId: string;
  onToken: (token: string) => void;
  onTool: (info: {
    toolName: string;
    status: "started" | "completed" | "failed";
    detail?: Record<string, unknown>;
  }) => void;
}

export interface OrchestratorOptions {
  confirmGate?: ConfirmGate;
  stream?: ChatStreamSink;
}

function emitContentTokens(stream: ChatStreamSink | undefined, content: string): void {
  if (!stream || !content) return;
  const parts = content.split(/(\s+)/);
  for (const part of parts) {
    if (part) stream.onToken(part);
  }
}

const MAX_TOOL_ITERATIONS = 8;

function defaultSummary(toolName: string, args: Record<string, unknown>): string {
  const compact = JSON.stringify(args);
  const clipped = compact.length > 180 ? `${compact.slice(0, 180)}…` : compact;
  return `Allow tool \`${toolName}\` with ${clipped}?`;
}

export class Orchestrator {
  private readonly tools = new Map<string, { def: ToolDefinition; handler: ToolHandler }>();

  constructor(
    private readonly llm: LlmClient,
    private readonly options: OrchestratorOptions = {},
  ) {}

  registerTool(def: ToolDefinition, handler: ToolHandler): void {
    this.tools.set(def.name, { def, handler });
  }

  getToolDefinitions(persona?: AgentPersona): ToolDefinition[] {
    return [...this.tools.values()]
      .map((t) => t.def)
      .filter((def) => (persona ? toolsAllowedForPersona(persona, def.name) : true));
  }

  async handle(
    persona: AgentPersona,
    userMessage: string,
    priorMessages: LlmMessage[] = [],
  ): Promise<OrchestratorResult> {
    const history = priorMessages.filter(
      (m) => m.role === "user" || m.role === "assistant" || m.role === "tool",
    );
    const messages: LlmMessage[] = [
      { role: "system", content: PERSONA_SYSTEM_PROMPTS[persona] },
      ...history,
      { role: "user", content: userMessage },
    ];
    const toolTrace: ToolTraceEntry[] = [];
    const toolDefs = this.getToolDefinitions(persona).map(toLlmToolDefinition);

    const stream = this.options.stream;

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const completion = await this.llm.complete(messages, toolDefs.length ? toolDefs : undefined);

      if (!completion.toolCalls?.length) {
        emitContentTokens(stream, completion.content);
        return { persona, content: completion.content, toolTrace };
      }

      if (completion.content) {
        emitContentTokens(stream, completion.content);
      }

      messages.push({
        role: "assistant",
        content: completion.content,
        toolCalls: completion.toolCalls,
      });

      for (const call of completion.toolCalls) {
        if (!toolsAllowedForPersona(persona, call.name)) {
          const err = { error: `tool_not_allowed_for_persona`, persona, toolName: call.name };
          toolTrace.push({ name: call.name, arguments: call.arguments, result: err });
          stream?.onTool({ toolName: call.name, status: "failed", detail: err });
          messages.push({
            role: "tool",
            name: call.name,
            content: JSON.stringify(err),
            toolCallId: call.id,
          });
          continue;
        }

        const entry = this.tools.get(call.name);
        stream?.onTool({
          toolName: call.name,
          status: "started",
          detail: { arguments: call.arguments },
        });

        if (!entry) {
          const err = { error: `unknown_tool: ${call.name}` };
          toolTrace.push({ name: call.name, arguments: call.arguments, result: err });
          stream?.onTool({ toolName: call.name, status: "failed", detail: err });
          messages.push({
            role: "tool",
            name: call.name,
            content: JSON.stringify(err),
            toolCallId: call.id,
          });
          continue;
        }

        let result: unknown;
        let failed = false;
        try {
          if (entry.def.requiresConfirm) {
            const gate = this.options.confirmGate;
            if (!gate) {
              result = {
                error: "confirm_required",
                detail: "host_confirm_gate_unavailable",
                toolName: call.name,
              };
              failed = true;
            } else {
              const decision = await gate.requestConfirmation({
                toolName: call.name,
                summary: defaultSummary(call.name, call.arguments),
                arguments: call.arguments,
              });
              if (!decision.approved) {
                result = {
                  error: "confirm_denied",
                  requestId: decision.requestId,
                  toolName: call.name,
                };
                failed = true;
              } else {
                result = await entry.handler(call.arguments);
                if (result && typeof result === "object") {
                  result = { ...(result as object), confirmRequestId: decision.requestId };
                }
              }
            }
          } else {
            result = await entry.handler(call.arguments);
          }
        } catch (err) {
          failed = true;
          result = { error: err instanceof Error ? err.message : "tool_failed" };
        }

        toolTrace.push({ name: call.name, arguments: call.arguments, result });
        stream?.onTool({
          toolName: call.name,
          status: failed ? "failed" : "completed",
          detail: typeof result === "object" && result ? (result as Record<string, unknown>) : undefined,
        });
        messages.push({
          role: "tool",
          name: call.name,
          content: JSON.stringify(result),
          toolCallId: call.id,
        });
      }
    }

    const stopped = "Stopped after maximum tool iterations.";
    emitContentTokens(stream, stopped);
    return {
      persona,
      content: stopped,
      toolTrace,
    };
  }
}
