import { describe, expect, it } from "vitest";
import { ConnectorRegistry } from "./registry.js";

describe("ConnectorRegistry", () => {
  const registry = new ConnectorRegistry();

  it("lists built-in dialects", () => {
    const dialects = registry.listBuiltInDialects();
    expect(dialects).toContain("minecraft_status");
    expect(dialects).toContain("a2s");
    expect(dialects).toContain("valheim");
    expect(dialects).toContain("unreal");
    expect(dialects).toContain("terraria");
    expect(dialects).toContain("factorio");
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
