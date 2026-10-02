import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../config.js";
import { createDb, type Db } from "../db/client.js";
import { applyBootstrap } from "../db/migrate.js";
import { servers as serversTable } from "../db/schema.js";
import { resolveFixturesRoot } from "../lab-games-root.js";
import { buildManagedStartEnv } from "./manage-suggest.js";
import { ServerService } from "./servers.js";
import {
  iniRelForLaunchName,
  parseManagedStartEnv,
  pathBelongsToServer,
  startIsolationViolation,
  worldIniNamesFromRels,
} from "./start-identity.js";

const temps: Array<{ root: string; sqlite: Database.Database }> = [];

afterEach(() => {
  while (temps.length) {
    const entry = temps.pop();
    if (!entry) break;
    try {
      entry.sqlite.close();
    } catch {
      /* ignore */
    }
    fs.rmSync(entry.root, { recursive: true, force: true });
  }
});

function findRepoRoot(start: string): string {
  let dir = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

function tempPzEnv(): { db: Db; servers: ServerService } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-start-identity-"));
  const dbPath = path.join(root, "playon.sqlite");
  applyBootstrap(dbPath);
  const { db, sqlite } = createDb(dbPath);
  temps.push({ root, sqlite });
  const skillDir = path.join(root, "skills", "games", "project-zomboid");
  fs.mkdirSync(path.join(skillDir, "guides"), { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "metadata.yaml"),
    [
      "name: games.project-zomboid",
      "version: 0.1.0",
      "game: Project Zomboid",
      "description: pz",
      "containerSupport: none",
      "ports:",
      "  - name: game",
      "    protocol: udp",
      "    default: 16261",
      "healthChecks: []",
      "dependencies: []",
      "requiredTools: []",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(skillDir, "guides", "INSTALL.md"), "# PZ\n");
  const config: AppConfig = {
    port: 0,
    dataRoot: root,
    dbPath,
    sessionSecret: "start-identity-test",
    llmMode: "openai_compatible",
    runtimeMode: "native",
    skillsRoots: [path.join(root, "skills"), resolveFixturesRoot(findRepoRoot(process.cwd()))],
    advertiseHost: "127.0.0.1",
  };
  return { db, servers: new ServerService(db, config) };
}

function writeWorldIni(dataPath: string, world: string, defaultPort: number): void {
  const dir = path.join(dataPath, "home", "Zomboid", "Server");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${world}.ini`),
    [`DefaultPort=${defaultPort}`, `UDPPort=${defaultPort + 1}`, ""].join("\n"),
  );
}

function writeStartEnv(dataPath: string, serverName: string, playonHome?: string): void {
  const dir = path.join(dataPath, "game");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".playon-start.env"),
    buildManagedStartEnv({
      playonHome: playonHome ?? path.join(dataPath, "home"),
      serverName,
      serverNameArg: "servername",
    }),
  );
}

describe("parseManagedStartEnv", () => {
  it("round-trips buildManagedStartEnv", () => {
    const env = buildManagedStartEnv({
      playonHome: "/srv/playon/servers/abc/home",
      serverName: "NZLCloneFrontierRD",
      serverNameArg: "servername",
      adminPassword: "secret",
    });
    expect(parseManagedStartEnv(env)).toEqual({
      launchName: "NZLCloneFrontierRD",
      playonHome: "/srv/playon/servers/abc/home",
    });
  });

  it("returns nothing for an env without identity", () => {
    expect(parseManagedStartEnv("# only a comment\n")).toEqual({});
  });
});

describe("start identity helpers", () => {
  it("pathBelongsToServer requires servers/<id>", () => {
    expect(pathBelongsToServer("/data/servers/clone1/home", "clone1")).toBe(true);
    expect(pathBelongsToServer("C:\\playon\\servers\\clone1\\home", "clone1")).toBe(true);
    expect(pathBelongsToServer("/data/servers/nzl/home", "clone1")).toBe(false);
    expect(pathBelongsToServer("/home/pz/clone1/Zomboid", "clone1")).toBe(false);
  });

  it("picks the ini for the launch name only", () => {
    const rels = ["home/Zomboid/Server/NZLCloneFrontierRD.ini", "home/Zomboid/Server/Other.ini"];
    expect(iniRelForLaunchName(rels, "nzlclonefrontierrd")).toBe(rels[0]);
    expect(iniRelForLaunchName(rels, "NewZombieLand3")).toBeUndefined();
    expect(worldIniNamesFromRels([...rels, "game/serverconfig.ini"])).toEqual([
      "NZLCloneFrontierRD",
      "Other",
    ]);
  });
});

describe("startIsolationViolation (#1016)", () => {
  const nzl = {
    id: "B4KR2xjZnLFZjqrtqqvvL",
    name: "NewZombieLand3",
    status: "running",
    launchName: "NewZombieLand3",
    gamePort: 16261,
  };

  it("refuses a clone that inherited NZL's -servername", () => {
    expect(
      startIsolationViolation({
        id: "clone",
        identity: { launchName: "NewZombieLand3", playonHome: "/d/servers/clone/home" },
        worldIniNames: [],
        gamePort: 16361,
        peers: [{ ...nzl, gamePort: 16261 }],
      }),
    ).toMatch(/^start_identity_collision: .*NewZombieLand3/);
  });

  it("refuses a launch name with no matching world ini", () => {
    expect(
      startIsolationViolation({
        id: "clone",
        identity: { launchName: "NewZombieLand3" },
        worldIniNames: ["NZLCloneFrontierRD"],
        gamePort: 16261,
        peers: [],
      }),
    ).toMatch(/^start_identity_world_missing/);
  });

  it("refuses a userdata home outside the server's own jail", () => {
    expect(
      startIsolationViolation({
        id: "clone",
        identity: { playonHome: `/d/servers/${nzl.id}/home` },
        worldIniNames: [],
        peers: [],
      }),
    ).toMatch(/^start_identity_foreign_home/);
  });

  it("refuses a game port a running peer already uses, ignores stopped peers", () => {
    const base = { id: "clone", identity: {}, worldIniNames: [], gamePort: 16261 };
    expect(startIsolationViolation({ ...base, peers: [nzl] })).toMatch(/^start_port_collision/);
    expect(
      startIsolationViolation({ ...base, peers: [{ ...nzl, status: "stopped" }] }),
    ).toBeNull();
  });

  it("allows a clone with its own world, home and port", () => {
    expect(
      startIsolationViolation({
        id: "clone",
        identity: { launchName: "NZLCloneFrontierRD", playonHome: "/d/servers/clone/home" },
        worldIniNames: ["NZLCloneFrontierRD"],
        gamePort: 16361,
        peers: [nzl],
      }),
    ).toBeNull();
  });
});

describe("ServerService.start isolation (#1016 repro)", () => {
  async function nzlAndClone() {
    const { db, servers } = tempPzEnv();
    const nzl = await servers.createFromSkill({
      skillName: "games.project-zomboid",
      serverName: "NewZombieLand3",
    });
    writeWorldIni(nzl.dataPath, "NewZombieLand3", 16261);
    writeStartEnv(nzl.dataPath, "NewZombieLand3");
    await db.update(serversTable).set({ status: "running" }).where(eq(serversTable.id, nzl.id));

    const clone = await servers.createFromSkill({
      skillName: "games.project-zomboid",
      serverName: "NZL-Clone-Frontier-RD",
    });
    writeWorldIni(clone.dataPath, "NZLCloneFrontierRD", 16361);
    return { db, servers, nzl, clone };
  }

  it("refuses to start a clone whose start env carries NZL's -servername", async () => {
    const { db, servers, nzl, clone } = await nzlAndClone();
    writeStartEnv(clone.dataPath, "NewZombieLand3");

    // Its own ini is not the world PZ would load, so the honest port is 16261.
    expect(await servers.joinInfoFor(clone)).toMatchObject({ port: 16261 });
    await expect(servers.start(clone.id)).rejects.toThrow(/start_identity_/);

    const rows = await db.select().from(serversTable);
    expect(rows.find((r) => r.id === nzl.id)?.status).toBe("running");
    expect(rows.find((r) => r.id === clone.id)?.status).toBe("error");
  });

  it("refuses a clone whose PLAYON_HOME points into NZL's jail", async () => {
    const { servers, nzl, clone } = await nzlAndClone();
    writeStartEnv(clone.dataPath, "NZLCloneFrontierRD", path.join(nzl.dataPath, "home"));
    await expect(servers.start(clone.id)).rejects.toThrow(/start_identity_foreign_home/);
  });

  it("passes isolation for a clone with its own world name, home and port", async () => {
    const { servers, clone } = await nzlAndClone();
    writeStartEnv(clone.dataPath, "NZLCloneFrontierRD");
    expect(await servers.joinInfoFor(clone)).toMatchObject({ port: 16361 });
    await expect(servers.assertStartIsolated(clone)).resolves.toBeUndefined();
  });
});
