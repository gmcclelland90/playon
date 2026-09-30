import { describe, expect, it } from "vitest";
import {
  assertModId,
  dialectDeployDest,
  patchFactorioModList,
  patchPzModsIni,
  scaffoldFiles,
} from "./mods-workspace.js";

describe("assertModId", () => {
  it("accepts safe ids", () => {
    expect(assertModId("PlayOnNexus")).toBe("PlayOnNexus");
    expect(assertModId("my_mod-1")).toBe("my_mod-1");
  });
  it("rejects path tricks", () => {
    expect(() => assertModId("../etc")).toThrow(/invalid_mod_id/);
    expect(() => assertModId("a/b")).toThrow(/invalid_mod_id/);
  });
});

describe("scaffoldFiles project-zomboid", () => {
  it("writes mod.info and playon-mod.json", () => {
    const files = scaffoldFiles("project-zomboid", "HelloMod", "Hello Mod");
    expect(files["mod.info"]).toMatch(/id=HelloMod/);
    expect(JSON.parse(files["playon-mod.json"]!).dialect).toBe("project-zomboid");
    expect(files["media/lua/server/PlayOnAuthored.lua"]).toMatch(/HelloMod/);
  });
});

describe("dialectDeployDest", () => {
  it("maps PZ and Paper", () => {
    expect(dialectDeployDest("project-zomboid", "X").destDir).toBe("mods/X");
    expect(dialectDeployDest("minecraft-paper", "X").destDir).toBe("plugins/X");
  });
});

describe("patchPzModsIni", () => {
  it("appends to Mods=", () => {
    const { content, patched } = patchPzModsIni("Mods=Base\nPauseEmpty=false\n", "HelloMod");
    expect(patched).toBe(true);
    expect(content).toMatch(/Mods=Base;HelloMod/);
  });
  it("is idempotent", () => {
    const once = patchPzModsIni("Mods=HelloMod\n", "HelloMod");
    expect(once.patched).toBe(false);
  });
});

describe("patchFactorioModList", () => {
  it("enables a mod", () => {
    const { content, patched } = patchFactorioModList('{"mods":[]}', "hello_mod");
    expect(patched).toBe(true);
    expect(JSON.parse(content).mods).toEqual([{ name: "hello_mod", enabled: true }]);
  });
});
