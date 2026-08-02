import { describe, expect, it } from "vitest";
import { labelForTool, verbForTool } from "./agent-activity.js";

describe("agent activity verbs", () => {
  it("maps known tools", () => {
    expect(verbForTool("net_fetch_url")).toBe("fetch");
    expect(verbForTool("fs_write")).toBe("write");
    expect(verbForTool("panel_publish")).toBe("panel");
    expect(verbForTool("servers_start")).toBe("run");
    expect(verbForTool("skill_list")).toBe("skill");
  });

  it("falls back for unknown tools", () => {
    expect(verbForTool("weird_custom_tool")).toBe("other");
  });

  it("provides short labels", () => {
    expect(labelForTool("net_fetch_url", "fetch")).toMatch(/fetch/i);
  });
});
