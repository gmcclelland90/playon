import { describe, expect, it } from "vitest";
import {
  ModClientNeedSchema,
  PlayonModManifestSchema,
  normalizePlayonModDialect,
} from "./playon-mod.js";

describe("PlayonModManifestSchema", () => {
  it("parses a PZ workspace manifest", () => {
    const parsed = PlayonModManifestSchema.parse({
      dialect: "project_zomboid",
      displayName: "PlayOn Nexus",
      clientNeed: "none",
      version: "0.1.0",
    });
    expect(parsed.dialect).toBe("project-zomboid");
    expect(parsed.clientNeed).toBe("none");
    expect(parsed.displayName).toBe("PlayOn Nexus");
  });

  it("accepts hyphenated Paper dialect", () => {
    const parsed = PlayonModManifestSchema.parse({
      dialect: "minecraft-paper",
      displayName: "Hello",
      clientNeed: "auto",
      version: "1.2.3",
    });
    expect(parsed.dialect).toBe("minecraft-paper");
    expect(parsed.clientNeed).toBe("auto");
  });

  it("rejects missing fields and unknown dialect", () => {
    expect(PlayonModManifestSchema.safeParse({ dialect: "project-zomboid" }).success).toBe(
      false,
    );
    expect(
      PlayonModManifestSchema.safeParse({
        dialect: "none",
        displayName: "x",
        clientNeed: "none",
        version: "1",
      }).success,
    ).toBe(false);
    expect(ModClientNeedSchema.safeParse("maybe").success).toBe(false);
  });
});

describe("normalizePlayonModDialect", () => {
  it("maps skill slugs and aliases", () => {
    expect(normalizePlayonModDialect("project-zomboid")).toBe("project-zomboid");
    expect(normalizePlayonModDialect("minecraft_paper")).toBe("minecraft-paper");
    expect(normalizePlayonModDialect("unknown")).toBeNull();
    expect(normalizePlayonModDialect("")).toBeNull();
  });
});
