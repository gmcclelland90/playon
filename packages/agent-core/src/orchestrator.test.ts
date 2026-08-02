import { describe, expect, it } from "vitest";
import { Orchestrator } from "./orchestrator.js";

describe("Orchestrator tool exposure", () => {
  it("filters tool defs exposed to the LLM by persona", () => {
    // Client is unused for getToolDefinitions; mode must be a real provider id.
    const orch = new Orchestrator({
      mode: "openai_compatible",
      async complete() {
        throw new Error("llm_should_not_be_called");
      },
    });
    orch.registerTool(
      { name: "panel_publish", description: "p", parameters: {} },
      async () => ({}),
    );
    orch.registerTool(
      { name: "servers_stop", description: "s", parameters: {} },
      async () => ({}),
    );
    expect(orch.getToolDefinitions("player_panel").map((t) => t.name)).toEqual(["panel_publish"]);
    expect(orch.getToolDefinitions("orchestrator").map((t) => t.name)).toEqual([
      "panel_publish",
      "servers_stop",
    ]);
  });
});
