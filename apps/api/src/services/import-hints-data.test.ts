import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadImportHintRules, loadImportScanRoots } from "./import-hints-data.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../");
const skillsRoot = path.join(repoRoot, "skills");

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
});
