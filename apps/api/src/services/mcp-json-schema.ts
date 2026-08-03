/**
 * Adapt PlayOn ToolDefinition JSON Schema into MCP's Standard Schema + JSON Schema surface
 * so tools/list advertises the same shapes Venice/Ollama see.
 */
export function jsonSchemaAsStandard(parameters: Record<string, unknown>): {
  "~standard": {
    version: 1;
    vendor: "playon";
    validate: (value: unknown) =>
      | { value: Record<string, unknown> }
      | { issues: Array<{ message: string }> };
    jsonSchema: {
      input: () => Record<string, unknown>;
      output: () => Record<string, unknown>;
    };
  };
} {
  const schema =
    parameters && typeof parameters === "object" ? parameters : { type: "object", properties: {} };

  return {
    "~standard": {
      version: 1,
      vendor: "playon",
      validate(value: unknown) {
        if (value === undefined || value === null) {
          return { value: {} };
        }
        if (typeof value !== "object" || Array.isArray(value)) {
          return { issues: [{ message: "arguments must be an object" }] };
        }
        return { value: value as Record<string, unknown> };
      },
      jsonSchema: {
        input: () => schema,
        output: () => ({ type: "object" }),
      },
    },
  };
}
