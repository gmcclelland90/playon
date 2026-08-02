import { describe, expect, it } from "vitest";
import { Orchestrator, toolResultFailed } from "./orchestrator.js";
import type { LlmClient, LlmMessage } from "./llm.js";

describe("toolResultFailed", () => {
  it("detects structured tool errors", () => {
    expect(toolResultFailed({ error: "rcon_command_failed" })).toBe(true);
    expect(toolResultFailed({ ok: false })).toBe(true);
    expect(toolResultFailed({ body: "ok" })).toBe(false);
  });
});

describe("Orchestrator self-heal", () => {
  it("blocks repeating an identical failing tool call and nudges self-heal", async () => {
    const systemNotes: string[] = [];
    let turn = 0;
    const llm: LlmClient = {
      mode: "openai_compatible",
      async complete(messages: LlmMessage[]) {
        for (const m of messages) {
          if (m.role === "system" && m.content.includes("Self-heal")) {
            systemNotes.push(m.content);
          }
        }
        turn += 1;
        if (turn === 1) {
          return {
            content: "",
            toolCalls: [
              { id: "1", name: "rcon_exec", arguments: { command: "gamerule doDaylightCycle false" } },
            ],
          };
        }
        if (turn === 2) {
          return {
            content: "",
            toolCalls: [
              { id: "2", name: "rcon_exec", arguments: { command: "gamerule doDaylightCycle false" } },
            ],
          };
        }
        return { content: "Stopped after heal guidance.", toolCalls: undefined };
      },
    };

    const orch = new Orchestrator(llm);
    orch.registerTool(
      { name: "rcon_exec", description: "r", parameters: {} },
      async () => ({ error: "rcon_command_failed", body: "Incorrect argument" }),
    );

    const result = await orch.handle("configurer", "make it always day");
    expect(result.toolTrace).toHaveLength(2);
    expect(toolResultFailed(result.toolTrace[0]?.result)).toBe(true);
    expect((result.toolTrace[1]?.result as { error?: string }).error).toBe(
      "repeated_failing_tool_call",
    );
    expect(systemNotes.some((n) => n.includes("Self-heal"))).toBe(true);
    expect(result.content).toContain("Stopped after heal guidance");
  });
});
