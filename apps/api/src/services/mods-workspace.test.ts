import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { PlayonModManifestSchema } from "@playon/shared";
import type { AppConfig } from "../config.js";
import { createControlPlane } from "../control-plane.js";
import { createDb } from "../db/client.js";
import { applyBootstrap } from "../db/migrate.js";
import { servers } from "../db/schema.js";
import { createPlayOnToolRegistry } from "./tools.js";
import { openServerFileStore } from "./server-file-store.js";
import {
  ModsWorkspaceError,
  PRE_MOD_DEPLOY_LABEL,
  assertAllowedDeployRel,
  assertSafeModId,
  deployAuthoredMod,
  dialectLiveDest,
  modsSrcRel,
  patchPzModsIni,
  listAuthoredMods,
  scaffoldModWorkspace,
} from "./mods-workspace.js";

const temps: Array<{ root: string; sqlite?: Database.Database }> = [];

afterEach(() => {
  while (temps.length) {
    const entry = temps.pop();
    if (!entry) break;
    try {
      entry.sqlite?.close();
    } catch {
      /* ignore */
    }
    fs.rmSync(entry.root, { recursive: true, force: true });
  }
});

function tempJail(): { dataPath: string; files: ReturnType<typeof openServerFileStore> } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-modsrc-"));
  temps.push({ root });
  const dataPath = path.join(root, "servers", "srv");
  fs.mkdirSync(dataPath, { recursive: true });
  const files = openServerFileStore({ id: "srv", nodeId: "local", dataPath });
  return { dataPath, files };
}

function testConfig(dataRoot: string): AppConfig {
  return {
    port: 0,
    advertiseHost: "127.0.0.1",
    dataRoot,
    dbPath: path.join(dataRoot, "playon.sqlite"),
    sessionSecret: "test-session-secret-at-least-32-chars!!",
    skillsRoots: [path.join(process.cwd(), "skills")],
    llmMode: "openai_compatible",
    runtimeMode: "docker",
  };
}

async function planeWithServer(opts?: {
  game?: string;
  skillName?: string;
}): Promise<{
  plane: ReturnType<typeof createControlPlane>;
  serverId: string;
  dataPath: string;
}> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-modtools-"));
  applyBootstrap(path.join(root, "playon.sqlite"));
  const config = testConfig(root);
  const { db, sqlite } = createDb(config.dbPath);
  temps.push({ root, sqlite });
  const plane = createControlPlane(db, config);
  const serverId = "srv-mod-1";
  const dataPath = path.join(root, "servers", serverId);
  fs.mkdirSync(dataPath, { recursive: true });
  if (opts?.skillName) {
    fs.writeFileSync(
      path.join(dataPath, "skill.json"),
      JSON.stringify({
        skillName: opts.skillName,
        version: "0.1.0",
        runtimeMode: "docker",
        containerSupport: "none",
        nodeId: null,
      }),
    );
  }
  await db.insert(servers).values({
    id: serverId,
    name: "Mod Lab",
    game: opts?.game ?? "lab",
    nodeId: null,
    runtimeMode: "docker",
    status: "stopped",
    dataPath,
    createdAt: new Date(),
  });
  return { plane, serverId, dataPath };
}

describe("playon-mod.json Zod", () => {
  it("accepts dialect aliases and clientNeed", () => {
    expect(
      PlayonModManifestSchema.parse({
        dialect: "project_zomboid",
        displayName: "Locker",
        clientNeed: "manual",
        version: "0.1.0",
      }).dialect,
    ).toBe("project-zomboid");
  });
});

describe("path jail", () => {
  it("refuses path-escape mod ids", () => {
    expect(() => assertSafeModId("../etc")).toThrow(ModsWorkspaceError);
    expect(() => assertSafeModId("foo/../bar")).toThrow(ModsWorkspaceError);
    expect(() => assertSafeModId("foo/bar")).toThrow(ModsWorkspaceError);
    expect(() => assertSafeModId("foo\\bar")).toThrow(ModsWorkspaceError);
    expect(() => modsSrcRel("..")).toThrow(ModsWorkspaceError);
  });

  it("refuses Workshop cache, worlds, db, and player-save dests", () => {
    expect(() => assertAllowedDeployRel("steamapps/workshop/content/108600/1")).toThrow(
      /forbidden_dest/,
    );
    expect(() => assertAllowedDeployRel("workshop/content/x")).toThrow(/forbidden_dest/);
    expect(() => assertAllowedDeployRel("worlds/overworld")).toThrow(/forbidden_dest/);
    expect(() => assertAllowedDeployRel("db/players.db")).toThrow(/forbidden_dest/);
    expect(() => assertAllowedDeployRel("Saves/Multiplayer/x")).toThrow(/forbidden_dest/);
    expect(() => assertAllowedDeployRel("mods/../steamapps/workshop/x")).toThrow(/path_escape/);
    expect(() => assertAllowedDeployRel("mods/Hello")).not.toThrow();
    expect(() => assertAllowedDeployRel("plugins")).not.toThrow();
  });
});

describe("dialect dest map", () => {
  it("maps PZ and Paper; stubs other dialects", () => {
    expect(dialectLiveDest("project-zomboid", "Locker")).toMatchObject({
      ok: true,
      destPath: "mods/Locker",
      enable: "pz_mods_ini",
    });
    expect(dialectLiveDest("minecraft_paper", "Hello")).toMatchObject({
      ok: true,
      destPath: "plugins",
      enable: "presence",
    });
    expect(dialectLiveDest("factorio", "pack")).toMatchObject({
      ok: true,
      dialect: "factorio",
      destPath: "mods",
      enable: "factorio_mod_list",
    });
    expect(dialectLiveDest("rust-oxide", "MyPlugin")).toMatchObject({
      ok: true,
      destPath: "oxide/plugins",
      enable: "presence",
    });
    expect(dialectLiveDest("garrys-mod", "my_addon")).toMatchObject({
      ok: true,
      enable: "presence",
    });
    expect(dialectLiveDest("terraria-tmod", "ExampleMod")).toMatchObject({
      ok: true,
      enable: "tmod_enabled_json",
    });
    expect(dialectLiveDest("none", "x")).toMatchObject({ ok: false, error: "unknown_dialect" });
    expect(dialectLiveDest("unknown", "x")).toMatchObject({ ok: false, error: "unknown_dialect" });
  });

  it("patches Mods= without duplicating", () => {
    const first = patchPzModsIni("PublicName=Lab\nMods=Vanilla\n", "Locker");
    expect(first.text).toMatch(/Mods=Vanilla;Locker/);
    expect(first.changed).toBe(true);
    const again = patchPzModsIni(first.text, "Locker");
    expect(again.changed).toBe(false);
    const added = patchPzModsIni("DefaultPort=16261\n", "Locker");
    expect(added.text).toContain("Mods=Locker");
    const empty = patchPzModsIni("PublicName=Lab\nMods=\n", "Locker");
    expect(empty.text).toMatch(/^Mods=Locker$/m);
    expect(empty.text).not.toMatch(/^Locker$/m);
  });
});

describe("mods_scaffold workspace", () => {
  it("creates mods-src skeleton + playon-mod.json inside the jail", async () => {
    const { dataPath, files } = tempJail();
    const result = await scaffoldModWorkspace({
      files,
      modId: "Locker",
      dialect: "project-zomboid",
      displayName: "PlayOn Locker",
    });
    expect(result.path).toBe("mods-src/Locker");
    expect(fs.existsSync(path.join(dataPath, "mods-src", "Locker", "playon-mod.json"))).toBe(true);
    expect(fs.existsSync(path.join(dataPath, "mods-src", "Locker", "mod.info"))).toBe(true);
    expect(
      fs.existsSync(path.join(dataPath, "mods-src", "Locker", "media", "lua", "server", "Locker.lua")),
    ).toBe(true);
    const manifest = PlayonModManifestSchema.parse(
      JSON.parse(fs.readFileSync(path.join(dataPath, "mods-src", "Locker", "playon-mod.json"), "utf8")),
    );
    expect(manifest.dialect).toBe("project-zomboid");
    expect(manifest.displayName).toBe("PlayOn Locker");
    expect(fs.existsSync(path.join(dataPath, "mods", "Locker"))).toBe(false);
  });

  it("refuses to clobber a non-empty folder unless overwrite is set", async () => {
    const { files } = tempJail();
    await scaffoldModWorkspace({ files, modId: "Locker", dialect: "project-zomboid" });
    await expect(
      scaffoldModWorkspace({ files, modId: "Locker", dialect: "project-zomboid" }),
    ).rejects.toMatchObject({ code: "workspace_exists" });
    await expect(
      scaffoldModWorkspace({
        files,
        modId: "Locker",
        dialect: "project-zomboid",
        overwrite: true,
      }),
    ).resolves.toMatchObject({ overwritten: true });
  });

  it("lists authored mods before deploy as authored", async () => {
    const { files } = tempJail();
    await scaffoldModWorkspace({
      files,
      modId: "Draft",
      dialect: "project-zomboid",
      displayName: "Draft",
    });
    const listed = await listAuthoredMods(files);
    expect(listed).toEqual([
      expect.objectContaining({ modId: "Draft", deployStatus: "authored", destPath: null }),
    ]);
  });
});


describe("mods_deploy mutate + snapshot-first", () => {
  it("copies PZ workspace to mods/ and patches Mods= after snapshot", async () => {
    const { dataPath, files } = tempJail();
    fs.mkdirSync(path.join(dataPath, "home", "Zomboid", "Server"), { recursive: true });
    fs.writeFileSync(
      path.join(dataPath, "home", "Zomboid", "Server", "servertest.ini"),
      "PublicName=Lab\nMods=\n",
    );
    await scaffoldModWorkspace({
      files,
      modId: "Locker",
      dialect: "project-zomboid",
      displayName: "Locker",
    });
    await files.writeText("mods-src/Locker/media/lua/server/extra.lua", "-- extra\n");

    const events: string[] = [];
    const result = await deployAuthoredMod({
      files,
      modId: "Locker",
      dialect: "project-zomboid",
      snapshotFirst: async (fn) => {
        events.push("snapshot");
        expect(fs.existsSync(path.join(dataPath, "mods", "Locker", "mod.info"))).toBe(false);
        const out = await fn();
        events.push("mutate");
        return out;
      },
    });

    expect(events).toEqual(["snapshot", "mutate"]);
    expect(result.destPath).toBe("mods/Locker");
    expect(result.enablePatched).toBe(true);
    expect(result.clientNeed).toBe("none");
    expect(fs.existsSync(path.join(dataPath, "mods", "Locker", "mod.info"))).toBe(true);
    expect(fs.existsSync(path.join(dataPath, "mods", "Locker", "media", "lua", "server", "extra.lua"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(dataPath, "mods", "Locker", "playon-mod.json"))).toBe(false);
    expect(fs.existsSync(path.join(dataPath, "mods", "Locker", "playon-deploy.json"))).toBe(false);
    expect(fs.existsSync(path.join(dataPath, "mods-src", "Locker", "playon-deploy.json"))).toBe(true);
    const listed = await listAuthoredMods(files);
    expect(listed).toEqual([
      expect.objectContaining({
        modId: "Locker",
        deployStatus: "deployed",
        destPath: "mods/Locker",
      }),
    ]);
    expect(
      fs.readFileSync(path.join(dataPath, "home", "Zomboid", "Server", "servertest.ini"), "utf8"),
    ).toMatch(/Mods=Locker/);
  });

  it("copies Paper jar/drop into plugins/ by presence", async () => {
    const { dataPath, files } = tempJail();
    await scaffoldModWorkspace({
      files,
      modId: "Hello",
      dialect: "minecraft-paper",
      displayName: "Hello",
    });
    await files.writeBytes("mods-src/Hello/Hello.jar", Buffer.from("jar-bytes"));

    const result = await deployAuthoredMod({
      files,
      modId: "Hello",
      dialect: "minecraft-paper",
      snapshotFirst: (fn) => fn(),
    });

    expect(result.destPath).toBe("plugins");
    expect(result.enablePatched).toBe(true);
    expect(fs.readFileSync(path.join(dataPath, "plugins", "Hello.jar"))).toEqual(
      Buffer.from("jar-bytes"),
    );
    expect(fs.existsSync(path.join(dataPath, "plugins", "plugin.yml"))).toBe(true);
    expect(fs.existsSync(path.join(dataPath, "plugins", "playon-mod.json"))).toBe(false);
  });

  it("does not mutate when snapshotFirst throws", async () => {
    const { dataPath, files } = tempJail();
    await scaffoldModWorkspace({ files, modId: "Locker", dialect: "project-zomboid" });
    await expect(
      deployAuthoredMod({
        files,
        modId: "Locker",
        dialect: "project-zomboid",
        snapshotFirst: async () => {
          throw new Error("snapshot_failed");
        },
      }),
    ).rejects.toThrow(/snapshot_failed/);
    expect(fs.existsSync(path.join(dataPath, "mods", "Locker"))).toBe(false);
  });

  it("marks unknown dialect strings as unknown_dialect", () => {
    expect(dialectLiveDest("totally-unknown-game", "x")).toMatchObject({
      ok: false,
      error: "unknown_dialect",
    });
  });
});

describe("mods tools confirm + withSnapshot", () => {
  it("does not write when confirm is missing", async () => {
    const { plane, serverId, dataPath } = await planeWithServer({
      skillName: "games.project-zomboid",
      game: "Project Zomboid",
    });
    const files = await plane.servers.files(serverId);
    await scaffoldModWorkspace({ files, modId: "Locker", dialect: "project-zomboid" });
    const { registry } = createPlayOnToolRegistry(plane, {});
    const result = await registry.invoke("mods_deploy", { serverId, modId: "Locker" });
    expect(result).toMatchObject({ error: "confirm_required", toolName: "mods_deploy" });
    expect(fs.existsSync(path.join(dataPath, "mods", "Locker"))).toBe(false);
    expect((await plane.snapshots.list(serverId)).some((s) => s.label === PRE_MOD_DEPLOY_LABEL)).toBe(
      false,
    );
  });

  it("scaffold also requires confirm", async () => {
    const { plane, serverId, dataPath } = await planeWithServer({
      skillName: "games.minecraft-paper",
    });
    const { registry } = createPlayOnToolRegistry(plane, {});
    const result = await registry.invoke("mods_scaffold", {
      serverId,
      modId: "Hello",
      dialect: "minecraft-paper",
    });
    expect(result).toMatchObject({ error: "confirm_required", toolName: "mods_scaffold" });
    expect(fs.existsSync(path.join(dataPath, "mods-src", "Hello"))).toBe(false);
  });

  it("calls withSnapshot before dest writes and returns snapshotId", async () => {
    const { plane, serverId, dataPath } = await planeWithServer({
      skillName: "games.project-zomboid",
    });
    fs.mkdirSync(path.join(dataPath, "home", "Zomboid", "Server"), { recursive: true });
    fs.writeFileSync(
      path.join(dataPath, "home", "Zomboid", "Server", "servertest.ini"),
      "Mods=\n",
    );
    const files = await plane.servers.files(serverId);
    await scaffoldModWorkspace({ files, modId: "Locker", dialect: "project-zomboid" });

    const events: string[] = [];
    const origCreate = plane.snapshots.create.bind(plane.snapshots);
    plane.snapshots.create = async (id, label) => {
      events.push(`snapshot:${label}`);
      expect(fs.existsSync(path.join(dataPath, "mods", "Locker", "mod.info"))).toBe(false);
      return origCreate(id, label);
    };

    const { registry } = createPlayOnToolRegistry(plane, {});
    const result = await registry.invoke(
      "mods_deploy",
      { serverId, modId: "Locker" },
      { confirmPolicy: "auto", autoApproveActor: "test" },
    );
    expect(events[0]).toBe(`snapshot:${PRE_MOD_DEPLOY_LABEL}`);
    expect(result).toMatchObject({
      destPath: "mods/Locker",
      enablePatched: true,
      clientNeed: "none",
      restartRequired: true,
    });
    expect((result as { snapshotId?: string }).snapshotId).toBeTruthy();
    expect(fs.existsSync(path.join(dataPath, "mods", "Locker", "mod.info"))).toBe(true);
    expect(fs.existsSync(path.join(dataPath, "mods", "Locker", "playon-mod.json"))).toBe(false);
  });

  it("keeps scaffold/deploy off the install catalog", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-modcat-"));
    applyBootstrap(path.join(root, "playon.sqlite"));
    const config = testConfig(root);
    const { db, sqlite } = createDb(config.dbPath);
    temps.push({ root, sqlite });
    const plane = createControlPlane(db, config);
    const install = createPlayOnToolRegistry(plane, { catalog: "install" });
    const maintain = createPlayOnToolRegistry(plane, { catalog: "maintain" });
    const names = (reg: ReturnType<typeof createPlayOnToolRegistry>) =>
      reg.registry.getDefinitions().map((d) => d.name);
    expect(names(install)).not.toContain("mods_scaffold");
    expect(names(install)).not.toContain("mods_deploy");
    expect(names(maintain)).toContain("mods_scaffold");
    expect(names(maintain)).toContain("mods_deploy");
    expect(names(maintain)).toContain("mods_errors");
  });
});
