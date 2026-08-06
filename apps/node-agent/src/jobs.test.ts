import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { executeJob } from "./jobs.js";

describe("executeJob", () => {
  it("pings with node metadata", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-node-"));
    const result = (await executeJob(
      { id: "j1", nodeId: "n1", kind: "ping", args: {} },
      root,
    )) as { pong: boolean; nodeId: string };
    expect(result.pong).toBe(true);
    expect(result.nodeId).toBe("n1");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("lists jailed directories and rejects escape", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-node-"));
    fs.mkdirSync(path.join(root, "servers"), { recursive: true });
    fs.writeFileSync(path.join(root, "servers", "a.txt"), "x");
    const listed = (await executeJob(
      { id: "j2", nodeId: "n1", kind: "fs_list", args: { path: "servers" } },
      root,
    )) as { entries: Array<{ name: string }> };
    expect(listed.entries.some((e) => e.name === "a.txt")).toBe(true);
    await expect(
      executeJob(
        { id: "j3", nodeId: "n1", kind: "fs_list", args: { path: "../.." } },
        root,
      ),
    ).rejects.toThrow(/jail|escape|not_found|ENOENT|path/i);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reports runtime caps", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-node-"));
    const caps = (await executeJob(
      { id: "j4", nodeId: "n1", kind: "runtime_caps", args: {} },
      root,
    )) as { native: boolean; docker: boolean; steamcmd: boolean };
    expect(caps.native).toBe(true);
    expect(typeof caps.docker).toBe("boolean");
    expect(typeof caps.steamcmd).toBe("boolean");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("import_probe finds allowlisted trees and import_pack rejects escapes", async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playon-node-"));
    const scan = fs.mkdtempSync(path.join(os.tmpdir(), "playon-scan-"));
    const server = path.join(scan, "game");
    fs.mkdirSync(server);
    fs.writeFileSync(path.join(server, "StartServer64.sh"), "#!/bin/sh\n");
    try {
      const probe = (await executeJob(
        {
          id: "j5",
          nodeId: "n1",
          kind: "import_probe",
          args: {
            roots: [scan],
            hints: [
              {
                id: "project_zomboid_layout",
                anyFiles: ["StartServer64.sh"],
                suggestedGame: "Project Zomboid",
              },
            ],
            maxDepth: 2,
            maxCandidates: 10,
          },
        },
        dataRoot,
      )) as { candidates: Array<{ path: string }> };
      expect(probe.candidates.some((c) => c.path === path.resolve(server))).toBe(true);

      await expect(
        executeJob(
          {
            id: "j6",
            nodeId: "n1",
            kind: "import_pack",
            args: { path: dataRoot, allowRoots: [scan], maxBytes: 1024 * 1024 },
          },
          dataRoot,
        ),
      ).rejects.toThrow(/path_not_allowlisted/);

      const packed = (await executeJob(
        {
          id: "j7",
          nodeId: "n1",
          kind: "import_pack",
          args: { path: server, allowRoots: [scan], maxBytes: 1024 * 1024 },
        },
        dataRoot,
      )) as { archiveBase64: string; bytes: number };
      expect(packed.bytes).toBeGreaterThan(0);
      expect(packed.archiveBase64.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
      fs.rmSync(scan, { recursive: true, force: true });
    }
  });
});
