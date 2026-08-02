import { describe, expect, it } from "vitest";
import { extractToolCallsFromContent } from "./llm.js";

describe("extractToolCallsFromContent", () => {
  it("parses Venice text function JSON", () => {
    const content =
      '{"type": "function", "function": {"name": "servers_create_from_skill", "parameters": {"skillName": "games.minecraft-paper", "serverName": "Venice Paper"}}}';
    const calls = extractToolCallsFromContent(content);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("servers_create_from_skill");
    expect(calls[0]?.arguments).toEqual({
      skillName: "games.minecraft-paper",
      serverName: "Venice Paper",
    });
  });

  it("parses fenced JSON tool blobs", () => {
    const content = `Sure.\n\`\`\`json\n{"name":"panel_publish","arguments":{"serverId":"abc"}}\n\`\`\``;
    const calls = extractToolCallsFromContent(content);
    expect(calls[0]?.name).toBe("panel_publish");
    expect(calls[0]?.arguments).toEqual({ serverId: "abc" });
  });

  it("returns empty for normal prose", () => {
    expect(extractToolCallsFromContent("I can help set that up.")).toEqual([]);
  });
});
