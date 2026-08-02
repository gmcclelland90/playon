import { describe, expect, it } from "vitest";
import { labelForTool, verbForTool } from "./agent-activity.js";

describe("agent activity verbs", () => {
  it("maps known tools", () => {
    expect(verbForTool("fetch_url")).toBe("fetch");
    expect(verbForTool("fs_write")).toBe("write");
    expect(verbForTool("fs_delete")).toBe("write");
    expect(verbForTool("archive_extract")).toBe("write");
    expect(verbForTool("servers_logs_tail")).toBe("read");
    expect(verbForTool("panel_publish")).toBe("panel");
    expect(verbForTool("servers_start")).toBe("run");
    expect(verbForTool("skill_list")).toBe("skill");
  });

  it("falls back for unknown tools", () => {
    expect(verbForTool("weird_custom_tool")).toBe("other");
  });

  it("provides short labels", () => {
    expect(labelForTool("fetch_url", "fetch")).toMatch(/fetch/i);
  });

  it("distinguishes panel list vs publish labels", () => {
    expect(labelForTool("panel_list", "panel")).toBe("Checking panel…");
    expect(labelForTool("panel_publish", "panel")).toBe("Updating panel…");
  });
});
