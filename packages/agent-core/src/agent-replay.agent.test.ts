import { describe, expect, it } from "vitest";
import { OpenAICompatibleLlmClient } from "./llm.js";
import { Orchestrator } from "./orchestrator.js";

/**
 * Live Venice tool-calling smoke. Requires PLAYON_VENICE_API_KEY or VENICE_API_KEY.
 * Runs on the Linux lab host as part of the agent verify layer.
 */
describe("agent live Venice tool loop", () => {
  it("calls Venice and can request a Paper create tool", async () => {
    const apiKey =
      process.env.PLAYON_VENICE_API_KEY?.trim() || process.env.VENICE_API_KEY?.trim() || "";
    if (!apiKey) {
      throw new Error(
        "llm_api_key_required: set PLAYON_VENICE_API_KEY (or VENICE_API_KEY) for agent verify on the lab host",
      );
    }

    const llm = new OpenAICompatibleLlmClient(
      process.env.PLAYON_VENICE_BASE_URL?.trim() || "https://api.venice.ai/api/v1",
      apiKey,
      process.env.PLAYON_VENICE_MODEL?.trim() || "llama-3.3-70b",
      "openai_compatible",
    );

    const orch = new Orchestrator(llm);
    const calls: string[] = [];
    orch.registerTool(
      {
        name: "skill_list",
        description: "List installable skills",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
      async () => {
        calls.push("skill_list");
        return { skills: [{ name: "games.minecraft-paper" }] };
      },
    );
    orch.registerTool(
      {
        name: "servers_create_from_skill",
        description: "Create a server from a skill",
        parameters: {
          type: "object",
          properties: { skillName: { type: "string" }, serverName: { type: "string" } },
          required: ["skillName"],
        },
      },
      async (args) => {
        calls.push(`create:${String(args.skillName)}`);
        return { serverId: "live-srv", skillName: args.skillName };
      },
    );

    const result = await orch.handle(
      "List skills then create a Paper Minecraft server named LAN Paper using servers_create_from_skill.",
    );

    expect(result.content.length + (result.toolTrace?.length ?? 0)).toBeGreaterThan(0);
    // Model should use at least one registered tool when asked to create.
    expect(calls.length).toBeGreaterThan(0);
  }, 120_000);
});
