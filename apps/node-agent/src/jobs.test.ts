import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { executeJob } from "./jobs.js";

describe("executeJob", () => {
  it("pings with node metadata", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-node-"));
    const result = executeJob(
      { id: "j1", nodeId: "n1", kind: "ping", args: {} },
      root,
    ) as { pong: boolean; nodeId: string };
    expect(result.pong).toBe(true);
    expect(result.nodeId).toBe("n1");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("lists jailed directories and rejects escape", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-node-"));
    fs.mkdirSync(path.join(root, "servers"), { recursive: true });
    fs.writeFileSync(path.join(root, "servers", "a.txt"), "x");
    const listed = executeJob(
      { id: "j2", nodeId: "n1", kind: "fs_list", args: { path: "servers" } },
      root,
    ) as { entries: Array<{ name: string }> };
    expect(listed.entries.some((e) => e.name === "a.txt")).toBe(true);
    expect(() =>
      executeJob(
        { id: "j3", nodeId: "n1", kind: "fs_list", args: { path: "../.." } },
        root,
      ),
    ).toThrow(/jail|escape|not_found|ENOENT|path/i);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
