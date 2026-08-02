import { describe, expect, it } from "vitest";
import { Orchestrator } from "./orchestrator.js";
import { pickPersona, toolsAllowedForPersona } from "./personas.js";

describe("personas", () => {
  it("routes install, panel, and specialised Phase-2 personas", () => {
    expect(pickPersona("spin up paper minecraft")).toBe("installer");
    expect(
      pickPersona(
        "we now want to play the original Unreal Tournament, can you get a UT99 server running",
      ),
    ).toBe("installer");
    expect(
      pickPersona(
        "Create a Paper Minecraft server named Venice Paper using servers_create_from_skill with skillName games.minecraft-paper, then publish a join panel.",
      ),
    ).toBe("installer");
    expect(pickPersona("update the player panel join info")).toBe("player_panel");
    expect(pickPersona("install a fabric mod")).toBe("modder");
    expect(pickPersona("tune server.properties difficulty")).toBe("configurer");
    expect(pickPersona("perfect. can you now make it always day time")).toBe("configurer");
    expect(pickPersona("set gamerule keep inventory")).toBe("configurer");
    expect(pickPersona("server won't start diagnose please")).toBe("troubleshooter");
    expect(pickPersona("run a health check / monitor")).toBe("monitor");
    expect(pickPersona("take a backup snapshot")).toBe("backup");
    expect(pickPersona("what can you do?")).toBe("orchestrator");
    expect(
      pickPersona(
        "continue",
        "I hit the tool step limit before finishing a final reply.\nA server was created but not started — say **continue**",
      ),
    ).toBe("installer");
    expect(pickPersona("continue")).toBe("installer");
  });

  it("scopes specialised personas", () => {
    expect(toolsAllowedForPersona("player_panel", "panel_publish")).toBe(true);
    expect(toolsAllowedForPersona("player_panel", "servers_stop")).toBe(false);
    expect(toolsAllowedForPersona("modder", "fetch_url")).toBe(true);
    expect(toolsAllowedForPersona("modder", "archive_extract")).toBe(true);
    expect(toolsAllowedForPersona("modder", "fs_delete")).toBe(true);
    expect(toolsAllowedForPersona("modder", "servers_logs_tail")).toBe(true);
    expect(toolsAllowedForPersona("modder", "servers_create_from_skill")).toBe(false);
    expect(toolsAllowedForPersona("installer", "archive_extract")).toBe(true);
    expect(toolsAllowedForPersona("configurer", "fs_copy")).toBe(true);
    expect(toolsAllowedForPersona("troubleshooter", "servers_logs_tail")).toBe(true);
    expect(toolsAllowedForPersona("backup", "snapshot_restore")).toBe(true);
    expect(toolsAllowedForPersona("monitor", "fs_write")).toBe(false);
    expect(toolsAllowedForPersona("monitor", "servers_query")).toBe(true);
    expect(toolsAllowedForPersona("installer", "servers_query_test")).toBe(true);
    expect(toolsAllowedForPersona("orchestrator", "servers_stop")).toBe(true);
  });

  it("filters tool defs exposed to the LLM by persona", () => {
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
