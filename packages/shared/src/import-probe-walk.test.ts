import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertPackPathAllowed,
  expandScanRoots,
  matchHintsAt,
  runImportProbe,
} from "./import-probe-walk.js";

const tmpDirs: string[] = [];

function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playon-probe-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("expandScanRoots", () => {
  it("expands trailing /* to child directories", () => {
    const root = mkTmp();
    const a = path.join(root, "Alpha");
    const b = path.join(root, "Beta");
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    fs.writeFileSync(path.join(root, "file.txt"), "x");
    const found = expandScanRoots([path.join(root, "*")]);
    expect(found.sort()).toEqual([a, b].map((p) => path.resolve(p)).sort());
  });
});

describe("matchHintsAt / runImportProbe", () => {
  const zomboidHints = [
    {
      id: "project_zomboid_layout",
      anyFiles: ["StartServer64.sh", "ProjectZomboid64"],
      suggestedGame: "Project Zomboid",
      suggestedSkillName: "games.project-zomboid",
    },
  ];
  const paperHints = [
    {
      id: "minecraft_paper_layout",
      anyFiles: ["paper.jar", "eula.txt"],
      suggestedGame: "Minecraft",
      suggestedSkillName: "games.minecraft-paper",
    },
  ];

  it("matches Zomboid markers", () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, "StartServer64.sh"), "#!/bin/sh\n");
    const hit = matchHintsAt(dir, zomboidHints);
    expect(hit?.hintIds).toEqual(["project_zomboid_layout"]);
    expect(hit?.suggestedGame).toBe("Project Zomboid");
  });

  it("finds Paper under an allowlisted root", () => {
    const root = mkTmp();
    const server = path.join(root, "paper-server");
    fs.mkdirSync(server);
    fs.writeFileSync(path.join(server, "paper.jar"), "jar");
    fs.writeFileSync(path.join(server, "eula.txt"), "eula=true");
    const result = runImportProbe({
      roots: [root],
      hints: paperHints,
      maxDepth: 2,
      maxCandidates: 10,
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.path).toBe(path.resolve(server));
    expect(result.candidates[0]?.hintIds).toContain("minecraft_paper_layout");
  });

  it("rejects pack outside allowlist", () => {
    const allowed = mkTmp();
    const outside = mkTmp();
    fs.mkdirSync(path.join(allowed, "ok"));
    expect(() => assertPackPathAllowed(outside, [allowed])).toThrow(/path_not_allowlisted/);
    expect(assertPackPathAllowed(path.join(allowed, "ok"), [allowed])).toBe(
      path.resolve(path.join(allowed, "ok")),
    );
  });
});
