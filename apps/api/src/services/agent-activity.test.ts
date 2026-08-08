import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolSurface } from "@playon/agent-core";
import type { AppConfig } from "../config.js";
import { createControlPlane } from "../control-plane.js";
import { createDb } from "../db/client.js";
import { applyBootstrap } from "../db/migrate.js";
import { labelForTool, verbForTool } from "./agent-activity.js";
import { createPlayOnToolSurface } from "./tools.js";

/** Verbs for migrated domains only exist on the composed surface, as chat and watchers pass it. */
function composedSurface(): ToolSurface {
  const dataRoot = mkdtempSync(path.join(tmpdir(), "playon-activity-"));
  const dbPath = path.join(dataRoot, "playon.sqlite");
  applyBootstrap(dbPath);
  const config: AppConfig = {
    port: 0,
    advertiseHost: "127.0.0.1",
    dataRoot,
    dbPath,
    sessionSecret: "test-session-secret-at-least-32-chars!!",
    skillsRoots: [path.join(process.cwd(), "skills")],
    llmMode: "openai_compatible",
    runtimeMode: "docker",
  };
  const { db } = createDb(dbPath);
  return createPlayOnToolSurface(createControlPlane(db, config), {});
}

describe("agent activity verbs", () => {
  it("maps known tools", () => {
    const surface = composedSurface();

    expect(verbForTool("fetch_url")).toBe("fetch");
    expect(verbForTool("archive_extract")).toBe("write");
    expect(verbForTool("panel_publish")).toBe("panel");
    expect(verbForTool("skill_list")).toBe("skill");

    expect(verbForTool("fs_write", surface)).toBe("write");
    expect(verbForTool("fs_delete", surface)).toBe("write");
    expect(verbForTool("servers_logs_tail", surface)).toBe("read");
    expect(verbForTool("servers_start", surface)).toBe("run");
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
