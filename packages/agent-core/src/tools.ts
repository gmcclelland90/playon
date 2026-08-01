export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** When true, orchestrator pauses for host approval before running the handler. */
  requiresConfirm?: boolean;
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

/** Shape sent to OpenAI-compatible tool APIs (no PlayOn-only fields). */
export function toLlmToolDefinition(def: ToolDefinition): {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
} {
  return {
    name: def.name,
    description: def.description,
    parameters: def.parameters,
  };
}
