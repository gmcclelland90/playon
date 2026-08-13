import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadImportHintRules, loadImportScanRoots } from "./import-hints-data.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../");
const skillsRoot = path.join(repoRoot, "skills");

const tmpDirs: string[] = [];

function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playon-hints-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("import-hints-data", () => {
  it("loads Zomboid fingerprint and manage cutover metadata from import-hints.yaml", () => {
    const hints = loadImportHintRules([skillsRoot]);
    const z = hints.find((h) => h.id === "project_zomboid_layout");
    expect(z).toBeTruthy();
    expect(z?.suggestedSkillName).toBe("games.project-zomboid");
    expect(z?.anyFiles.length).toBeGreaterThan(0);
    expect(z?.manage?.userdataHomeDirs).toContain("Zomboid");
    expect(z?.manage?.serverNameArg).toBe("servername");
    expect(z?.manage?.adminPasswordArg).toBe(true);
  });

  it("prepopulates manage cutover metadata for other fingerprint games", () => {
    const hints = loadImportHintRules([skillsRoot]);
    const byId = Object.fromEntries(hints.map((h) => [h.id, h]));

    expect(byId.valheimish_layout?.manage?.userdataHomeDirs).toContain(
      ".config/unity3d/IronGate/Valheim",
    );
    expect(byId.valheimish_layout?.manage?.serverNameArg).toBe("world");

    expect(byId.terraria_layout?.manage?.userdataHomeDirs).toContain(".local/share/Terraria");
    expect(byId.terraria_layout?.manage?.serverNameArg).toBe("world");

    expect(byId.factorio_layout?.manage?.userdataHomeDirs).toContain(".factorio");
    expect(byId.factorio_layout?.manage?.serverNameArg).toBe("--start-server");

    expect(byId.rust_dedicated_layout?.manage?.serverNameArg).toBe("+server.identity");
    expect(byId.rust_dedicated_layout?.manage?.userdataHomeDirs).toEqual([]);

    expect(byId.minecraft_java_layout?.manage?.userdataHomeDirs).toEqual([]);
    expect(byId.ut99_layout?.manage?.userdataHomeDirs).toEqual([]);
  });

  it("loads linux scan roots for install trees (Steam/opt/servers)", () => {
    const roots = loadImportScanRoots([skillsRoot], "linux");
    expect(roots.some((r) => r.includes("steamapps"))).toBe(true);
    expect(roots.some((r) => r.includes("/opt/"))).toBe(true);
    expect(roots.some((r) => r.includes("Zomboid"))).toBe(false);
  });

  it("prefers yaml inside a skills root over a leftover file in the parent dir", () => {
    const parent = mkTmp();
    const isolated = path.join(parent, "skills");
    fs.mkdirSync(isolated);
    fs.writeFileSync(
      path.join(parent, "import-scan-roots.yaml"),
      "version: 1\nlinux: []\nwindows: []\n",
    );
    fs.writeFileSync(
      path.join(isolated, "import-scan-roots.yaml"),
      'version: 1\nlinux:\n  - "/opt/pzserver"\nwindows: []\n',
    );
    expect(loadImportScanRoots([isolated], "linux")).toEqual(["/opt/pzserver"]);
  });

  it("finds skills/ yaml when skillsRoots is catalog/platform", () => {
    const repo = mkTmp();
    const platform = path.join(repo, "catalog", "platform");
    fs.mkdirSync(platform, { recursive: true });
    fs.mkdirSync(path.join(repo, "skills"));
    fs.writeFileSync(
      path.join(repo, "skills", "import-scan-roots.yaml"),
      'version: 1\nlinux:\n  - "/opt/pzserver"\nwindows: []\n',
    );
    expect(loadImportScanRoots([platform], "linux")).toEqual(["/opt/pzserver"]);
  });

  it("does not let leftover yaml in os.tmpdir() shadow a mkdtemp skills root", () => {
    const poison = path.join(os.tmpdir(), "import-scan-roots.yaml");
    const previous = fs.existsSync(poison) ? fs.readFileSync(poison, "utf8") : null;
    try {
      fs.writeFileSync(poison, "version: 1\nlinux: []\nwindows: []\n");
      const isolated = mkTmp();
      fs.writeFileSync(
        path.join(isolated, "import-scan-roots.yaml"),
        'version: 1\nlinux:\n  - "/opt/pzserver"\nwindows: []\n',
      );
      expect(loadImportScanRoots([isolated], "linux")).toEqual(["/opt/pzserver"]);
    } finally {
      if (previous == null) fs.rmSync(poison, { force: true });
      else fs.writeFileSync(poison, previous);
    }
  });

  it("resolves scan roots from the repo catalog/platform layout", () => {
    const platform = path.join(repoRoot, "catalog", "platform");
    const roots = loadImportScanRoots([platform], "linux");
    expect(roots.some((r) => r.includes("/opt/"))).toBe(true);
    expect(roots.some((r) => r.includes("Zomboid"))).toBe(false);
  });
});
