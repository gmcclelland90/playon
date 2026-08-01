import { describe, expect, it } from "vitest";
import type { LlmClient, LlmCompletion, LlmMessage } from "./llm.js";
import { Orchestrator } from "./orchestrator.js";
import type { ToolDefinition } from "./tools.js";


/** Recorded transcript: create skill → publish panel → done. */
class ReplayLlmClient implements LlmClient {
  readonly mode = "mock" as const;
  private step = 0;

  async complete(_messages: LlmMessage[], _tools?: ToolDefinition[]): Promise<LlmCompletion> {
    this.step += 1;
    if (this.step === 1) {
      return {
        content: "",
        toolCalls: [
          {
            id: "1",
            name: "servers_create_from_skill",
            arguments: { skillName: "fixtures.fake-http-game" },
          },
        ],
      };
    }
    if (this.step === 2) {
      return {
        content: "",
        toolCalls: [
          {
            id: "2",
            name: "panel_publish",
            arguments: {
              serverId: "srv-replay",
              blocks: [{ type: "join_info", title: "Join", body: { port: 8080 } }],
            },
          },
        ],
      };
    }
    return { content: "Replay install complete." };
  }
}

describe("agent replay transcripts", () => {
  it("replays fixture install tool loop without a live model", async () => {
    const orch = new Orchestrator(new ReplayLlmClient());
    const calls: string[] = [];

    orch.registerTool(
      {
        name: "servers_create_from_skill",
        description: "create",
        parameters: { type: "object", properties: {} },
      },
      async () => {
        calls.push("create");
        return { serverId: "srv-replay" };
      },
    );
    orch.registerTool(
      {
        name: "panel_publish",
        description: "publish",
        parameters: { type: "object", properties: {} },
      },
      async () => {
        calls.push("publish");
        return { published: 1 };
      },
    );

    const result = await orch.handle("orchestrator", "install fixture");
    expect(calls).toEqual(["create", "publish"]);
    expect(result.toolTrace).toHaveLength(2);
    expect(result.content).toBe("Replay install complete.");
  });

  it("replays confirm approve then deny for high-impact stop", async () => {
    class StopReplay implements LlmClient {
      readonly mode = "mock" as const;
      private step = 0;
      async complete(): Promise<LlmCompletion> {
        this.step += 1;
        if (this.step === 1) {
          return {
            content: "",
            toolCalls: [{ id: "1", name: "servers_stop", arguments: { serverId: "srv" } }],
          };
        }
        return { content: "Handled confirm outcome." };
      }
    }

    const decisions = [true, false];
    for (const approved of decisions) {
      let ran = false;
      const orch = new Orchestrator(new StopReplay(), {
        confirmGate: {
          async requestConfirmation() {
            return { requestId: `req-${approved}`, approved };
          },
        },
      });
      orch.registerTool(
        {
          name: "servers_stop",
          description: "stop",
          requiresConfirm: true,
          parameters: { type: "object", properties: {} },
        },
        async () => {
          ran = true;
          return { ok: true };
        },
      );
      const result = await orch.handle("orchestrator", "stop server");
      expect(ran).toBe(approved);
      if (approved) {
        expect(result.toolTrace[0]?.result).toMatchObject({ ok: true });
      } else {
        expect(result.toolTrace[0]?.result).toMatchObject({ error: "confirm_denied" });
      }
    }
  });
});
