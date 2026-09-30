import { describe, expect, it } from "vitest";
import {
  extractModErrors,
  resolveModDialect,
} from "./mods-errors.js";

const PZ_FIXTURE = `
LOG  : General     , 123456789> LuaManager.getFunctionObject threw an error
LOG  : General     , 123456790> -----------------------------------------
STACK TRACE
-----------------------------------------
Callframe at: print
function: serializeInventory -- file: Utils.lua line # 94 | MOD: PlayOn Nexus
Lua((MOD:PlayOn Nexus)).serializeInventory(Utils.lua:94)
Object tried to call nil in serializeInventory
`.trim();

const PAPER_FIXTURE = `
[18:00:01] [Server thread/INFO]: Preparing start region for dimension minecraft:overworld
[18:00:02] [Server thread/ERROR]: Error occurred while enabling WorldEdit v7.2.0 (Is it up to date?)
java.lang.NoClassDefFoundError: com/sk89q/worldedit/extent/clipboard/io/ClipboardFormats
[18:00:03] [Server thread/ERROR]: Could not load 'plugins/BrokenPlugin.jar' in folder 'plugins'
org.bukkit.plugin.InvalidPluginException: java.lang.ClassNotFoundException: com.example.Broken
`.trim();

describe("resolveModDialect", () => {
  it("maps PlayOn skill slugs", () => {
    expect(resolveModDialect("games.project-zomboid")).toBe("project-zomboid");
    expect(resolveModDialect("games.minecraft-paper")).toBe("minecraft-paper");
    expect(resolveModDialect("games.rust")).toBe("rust-oxide");
    expect(resolveModDialect("")).toBe("unknown");
  });
});

describe("extractModErrors project-zomboid", () => {
  it("captures PlayOn Nexus serializeInventory fixture", () => {
    const errors = extractModErrors("project-zomboid", PZ_FIXTURE);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    const hit = errors.find((e) => e.mod === "PlayOn Nexus");
    expect(hit).toBeDefined();
    expect(hit!.file).toBe("Utils.lua");
    expect(hit!.line).toBe(94);
    expect(hit!.message).toMatch(/Object tried to call nil/i);
    expect(hit!.excerpt).toContain("Lua((MOD:PlayOn Nexus))");
  });

  it("does not invent mods absent from the text", () => {
    const errors = extractModErrors("project-zomboid", "server started ok\n");
    expect(errors.every((e) => !e.mod || PZ_FIXTURE.includes(e.mod))).toBe(true);
    expect(errors).toHaveLength(0);
  });
});

describe("extractModErrors minecraft-paper", () => {
  it("captures plugin enable and load failures", () => {
    const errors = extractModErrors("minecraft-paper", PAPER_FIXTURE);
    expect(errors.some((e) => e.kind === "plugin_enable" && e.mod === "WorldEdit")).toBe(
      true,
    );
    expect(errors.some((e) => e.kind === "plugin_load")).toBe(true);
  });
});
