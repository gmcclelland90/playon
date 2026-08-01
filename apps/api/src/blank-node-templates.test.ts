import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function findRepoRoot(start: string): string {
  let dir = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

describe("blank-node IaC templates", () => {
  const root = path.join(findRepoRoot(process.cwd()), "infra", "blank-node");

  it("ships linux + windows bootstrap entrypoints", () => {
    expect(fs.existsSync(path.join(root, "README.md"))).toBe(true);
    expect(fs.existsSync(path.join(root, "linux", "bootstrap.sh"))).toBe(true);
    expect(fs.existsSync(path.join(root, "linux", "cloud-init.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(root, "windows", "bootstrap.ps1"))).toBe(true);
  });

  it("documents node token + API URL wiring", () => {
    const sh = fs.readFileSync(path.join(root, "linux", "bootstrap.sh"), "utf8");
    const ps1 = fs.readFileSync(path.join(root, "windows", "bootstrap.ps1"), "utf8");
    const cloud = fs.readFileSync(path.join(root, "linux", "cloud-init.yaml"), "utf8");
    for (const body of [sh, ps1, cloud]) {
      expect(body).toContain("PLAYON_API_URL");
      expect(body).toContain("PLAYON_NODE_TOKEN");
      expect(body).toContain("node-agent");
    }
  });
});
