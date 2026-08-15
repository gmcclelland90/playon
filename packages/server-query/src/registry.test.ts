import { describe, expect, it } from "vitest";
import {
  ConnectorRegistry,
  builtInDialectIds,
  listDialectDescriptors,
  portPreferenceForDialect,
  primaryPortForDialect,
  queryDialectToolEnum,
} from "./registry.js";

describe("ConnectorRegistry", () => {
  const registry = new ConnectorRegistry();

  it("lists built-in dialects", () => {
    const dialects = registry.listBuiltInDialects();
    expect(dialects).toEqual(builtInDialectIds);
    expect(dialects).toContain("minecraft_status");
    expect(dialects).toContain("a2s");
    expect(dialects).toContain("valheim");
    expect(dialects).toContain("unreal");
    expect(dialects).toContain("terraria");
    expect(dialects).toContain("factorio");
    expect(dialects).toContain("project_zomboid");
    expect(dialects).not.toContain("none");
    expect(dialects).not.toContain("skill_module");
  });

  it("exposes descriptors with portPreference", () => {
    const list = listDialectDescriptors();
    expect(list.length).toBe(builtInDialectIds.length);
    expect(list.find((d) => d.id === "minecraft_status")?.portPreference).toBe("game");
    expect(list.find((d) => d.id === "valheim")?.portPreference).toBe("query");
    expect(list.find((d) => d.id === "unreal")?.portPreference).toBe("query");
    expect(list.find((d) => d.id === "a2s")?.portPreference).toBe("query");
    expect(list.find((d) => d.id === "project_zomboid")?.portPreference).toBe("game");
  });

  it("resolves primary port from descriptor preference", () => {
    expect(portPreferenceForDialect("minecraft_status")).toBe("game");
    expect(portPreferenceForDialect("valheim")).toBe("query");
    expect(portPreferenceForDialect("skill_module")).toBe("query");
    expect(portPreferenceForDialect("none")).toBe("query");
    expect(primaryPortForDialect("minecraft_status", { gamePort: 25565, queryPort: 25566 })).toBe(
      25565,
    );
    expect(primaryPortForDialect("valheim", { gamePort: 2456, queryPort: 2457 })).toBe(2457);
    expect(primaryPortForDialect("project_zomboid", { gamePort: 16261, queryPort: 16262 })).toBe(
      16261,
    );
  });

  it("builds tool enum from built-ins plus special cases", () => {
    expect(queryDialectToolEnum()).toEqual([
      "none",
      ...builtInDialectIds,
      "skill_module",
    ]);
  });

  it("returns null for none", () => {
    expect(registry.resolve({ queryDialect: "none" })).toBeNull();
  });

  it("resolves minecraft_status", () => {
    const c = registry.resolve({ queryDialect: "minecraft_status" });
    expect(c?.id).toBe("minecraft_status");
  });

  it("requires skill dir for skill_module", () => {
    expect(() => registry.resolve({ queryDialect: "skill_module" })).toThrow(
      /skill_module_requires_skill_dir/,
    );
  });
});
