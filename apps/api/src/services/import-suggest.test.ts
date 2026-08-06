import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import { ImportSuggestService } from "./import-suggest.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playon-suggest-"));
  tmpDirs.push(dir);
  return dir;
}

describe("ImportSuggestService.suggest (local)", () => {
  it("probes allowlisted roots and returns Zomboid candidates", async () => {
    const dataRoot = mkTmp();
    const skillsRoot = mkTmp();
    const scanRoot = mkTmp();
    const serverDir = path.join(scanRoot, "pz");
    fs.mkdirSync(serverDir);
    fs.writeFileSync(path.join(serverDir, "StartServer64.sh"), "#!/bin/sh\n");

    const scanPathYaml = scanRoot.replace(/\\/g, "/");
    fs.writeFileSync(
      path.join(skillsRoot, "import-hints.yaml"),
      [
        "version: 1",
        "hints:",
        "  - id: project_zomboid_layout",
        "    anyFiles:",
        "      - StartServer64.sh",
        "    suggestedGame: Project Zomboid",
        "    suggestedSkillName: games.project-zomboid",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(skillsRoot, "import-scan-roots.yaml"),
      [
        "version: 1",
        "linux:",
        `  - "${scanPathYaml}"`,
        "windows:",
        `  - "${scanPathYaml}"`,
        "",
      ].join("\n"),
    );

    const config = {
      dataRoot,
      skillsRoots: [skillsRoot],
    } as AppConfig;

    const importLocal = { importFromPath: vi.fn() };
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [],
          }),
        }),
      }),
    };

    const svc = new ImportSuggestService(db as never, config, importLocal as never);
    const result = await svc.suggest("local");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.suggestedGame).toBe("Project Zomboid");
    expect(result.candidates[0]?.path).toBe(path.resolve(serverDir));
  });

  it("imports local path without packing", async () => {
    const dataRoot = mkTmp();
    const skillsRoot = mkTmp();
    fs.writeFileSync(
      path.join(skillsRoot, "import-hints.yaml"),
      "version: 1\nhints: []\n",
    );
    fs.writeFileSync(
      path.join(skillsRoot, "import-scan-roots.yaml"),
      "version: 1\nlinux: []\nwindows: []\n",
    );
    const source = mkTmp();
    const importLocal = {
      importFromPath: vi.fn(async (args: { sourcePath: string; nodeId?: string }) => ({
        server: { id: "s1", name: "n", nodeId: args.nodeId },
        skillName: "draft",
        skillSource: "draft" as const,
        baselineSnapshotId: "snap",
        copiedBytes: 1,
        detectedHints: [],
        followUp: [],
      })),
    };
    const svc = new ImportSuggestService(
      { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) } as never,
      { dataRoot, skillsRoots: [skillsRoot] } as AppConfig,
      importLocal as never,
    );
    await svc.importFromNode({ nodeId: "local", sourcePath: source, serverName: "Demo" });
    expect(importLocal.importFromPath).toHaveBeenCalledWith(
      expect.objectContaining({ sourcePath: source, nodeId: "local", serverName: "Demo" }),
    );
  });
});
