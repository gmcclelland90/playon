import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listSkills, skillsRootsForWorkspace } from "./skills.js";

const temps: string[] = [];

afterEach(() => {
  for (const root of temps.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("skillsRootsForWorkspace", () => {
  it("merges global and per-server skill roots", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-skills-"));
    temps.push(root);
    const globalRoot = path.join(root, "skills");
    const serverRoot = path.join(root, "servers", "srv-1", "skills", "local-mod");
    fs.mkdirSync(globalRoot, { recursive: true });
    fs.mkdirSync(serverRoot, { recursive: true });
    fs.writeFileSync(
      path.join(serverRoot, "metadata.yaml"),
      [
        "name: server.local-mod",
        "version: 0.0.1",
        "description: Server-local skill",
        "tags: [server]",
      ].join("\n"),
    );

    const roots = skillsRootsForWorkspace([globalRoot], root, "srv-1");
    const skills = listSkills(roots);
    expect(skills.some((s) => s.metadata.name === "server.local-mod")).toBe(true);
  });
});
