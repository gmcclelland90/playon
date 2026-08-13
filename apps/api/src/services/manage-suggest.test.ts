import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import { ManageSuggestService } from "./manage-suggest.js";
import { ServerAdoptionService } from "./server-adoption.js";

vi.mock("./node-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./node-runtime.js")>();
  return {
    ...actual,
    dispatchNodeJob: vi.fn(
      async (opts: {
        kind: string;
        nodeId?: string;
        localHandler?: () => Promise<unknown>;
      }) => {
        // Local suggest/manage uses the in-process handler.
        if ((opts.nodeId === "local" || opts.nodeId === "LOCAL") && opts.localHandler) {
          return opts.localHandler();
        }
        if (opts.kind === "manage_seed") {
          return {
            destRel: "servers/x/game",
            sourcePath: "/opt/pzserver",
            bytesCopied: 10,
          };
        }
        if (opts.kind === "manage_cutover") {
          return {
            playonHome: "/var/lib/playon-node/servers/x/home",
            playonHomeRel: "servers/x/home",
            userdataBytes: 0,
            warnings: [] as string[],
            serverName: "NewZombieLand3",
          };
        }
        return { ok: true };
      },
    ),
  };
});

vi.mock("./placement.js", () => ({
  PlacementService: class {
    async resolveNodeId(_skillName: string, requested?: string) {
      return requested ?? "node-z";
    }
  },
}));

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playon-suggest-"));
  tmpDirs.push(dir);
  return dir;
}

/** Skills root nested under a unique tmp dir so parent yaml cannot shadow fixtures. */
function isolatedSkillsRoot(): string {
  const dir = path.join(mkTmp(), "skills");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe("ManageSuggestService.suggest (local)", () => {
  it("probes allowlisted roots and returns Zomboid candidates", async () => {
    const dataRoot = mkTmp();
    const skillsRoot = isolatedSkillsRoot();
    const scanRoot = mkTmp();
    const serverDir = path.join(scanRoot, "pz");
    fs.mkdirSync(serverDir);
    fs.writeFileSync(path.join(serverDir, "StartServer64.sh"), "#!/bin/sh\n");

    const scanPathYaml = scanRoot.replace(/\\/g, "/");
    fs.writeFileSync(
      path.join(skillsRoot, "import-hints.yaml"),
      [
        "version: 1",
        "hints:",
        "  - id: project_zomboid_layout",
        "    anyFiles:",
        "      - StartServer64.sh",
        "    suggestedGame: Project Zomboid",
        "    suggestedSkillName: games.project-zomboid",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(skillsRoot, "import-scan-roots.yaml"),
      [
        "version: 1",
        "linux:",
        `  - "${scanPathYaml}"`,
        "windows:",
        `  - "${scanPathYaml}"`,
        "",
      ].join("\n"),
    );

    const config = {
      dataRoot,
      skillsRoots: [skillsRoot],
    } as AppConfig;

    const importLocal = { importFromPath: vi.fn() };
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [],
          }),
        }),
      }),
    };

    const svc = new ManageSuggestService(
      db as never,
      config,
      importLocal as never,
      { get: vi.fn() } as never,
      {} as never,
    );
    const result = await svc.suggest("local");
    expect(result.scannedRoots).toContain(path.resolve(scanRoot));
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.suggestedGame).toBe("Project Zomboid");
    expect(result.candidates[0]?.path).toBe(path.resolve(serverDir));
  });

  it("manages local path without packing", async () => {
    const dataRoot = mkTmp();
    const skillsRoot = isolatedSkillsRoot();
    fs.writeFileSync(path.join(skillsRoot, "import-hints.yaml"), "version: 1\nhints: []\n");
    fs.writeFileSync(
      path.join(skillsRoot, "import-scan-roots.yaml"),
      "version: 1\nlinux: []\nwindows: []\n",
    );
    const source = mkTmp();
    const importLocal = {
      importFromPath: vi.fn(async (args: { sourcePath: string; nodeId?: string }) => ({
        server: { id: "s1", name: "n", nodeId: args.nodeId },
        skillName: "draft",
        skillSource: "draft" as const,
        baselineSnapshotId: "snap",
        copiedBytes: 1,
        detectedHints: [],
        followUp: [],
      })),
    };
    const svc = new ManageSuggestService(
      { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) } as never,
      { dataRoot, skillsRoots: [skillsRoot] } as AppConfig,
      importLocal as never,
      { get: vi.fn() } as never,
      {} as never,
    );
    await svc.manageFromNode({ nodeId: "local", sourcePath: source, serverName: "Demo" });
    expect(importLocal.importFromPath).toHaveBeenCalledWith(
      expect.objectContaining({ sourcePath: source, nodeId: "local", serverName: "Demo" }),
    );
  });

  it("binds manageFromNode to catalog skill from import hint", async () => {
    const dataRoot = mkTmp();
    const skillsRoot = isolatedSkillsRoot();
    const gameSkillDir = path.join(skillsRoot, "games", "project-zomboid");
    fs.mkdirSync(path.join(gameSkillDir, "guides"), { recursive: true });
    fs.writeFileSync(
      path.join(gameSkillDir, "metadata.yaml"),
      [
        "name: games.project-zomboid",
        "version: 0.1.0",
        "game: Project Zomboid",
        "description: PZ dedicated",
        "containerSupport: none",
        "steamAppId: 380870",
        "ports:",
        "  - name: game",
        "    protocol: udp",
        "    default: 16261",
        "healthChecks:",
        "  - id: process",
        "    type: process_running",
        "    onFail: restart",
        "dependencies: []",
        "requiredTools: []",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(gameSkillDir, "guides", "INSTALL.md"), "# PZ\n");
    fs.writeFileSync(
      path.join(skillsRoot, "import-hints.yaml"),
      [
        "version: 1",
        "hints:",
        "  - id: project_zomboid_layout",
        "    anyFiles:",
        "      - StartServer64.sh",
        "    suggestedGame: Project Zomboid",
        "    suggestedSkillName: games.project-zomboid",
        "    manage:",
        "      userdataHomeDirs:",
        "        - Zomboid",
        "      serverNameArg: servername",
        "      adminPasswordArg: true",
        "      worldSubdirs:",
        "        - Server",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(skillsRoot, "import-scan-roots.yaml"),
      "version: 1\nlinux: []\nwindows: []\n",
    );

    const inserted: Array<Record<string, unknown>> = [];
    let createdId = "";
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                id: "node-z",
                name: "zomboid",
                kind: "lan",
                joinHost: "172.16.0.109",
                lastSeenAt: new Date(),
                os: "linux",
                docker: 1,
                native: 1,
                steamcmd: 1,
                freeDiskBytes: 1e11,
                tunnelStatus: "none",
              },
            ],
          }),
        }),
      }),
      insert: () => ({
        values: async (row: Record<string, unknown>) => {
          inserted.push(row);
          createdId = String(row.id);
        },
      }),
      update: () => ({
        set: () => ({
          where: async () => undefined,
        }),
      }),
    };

    const serversSvc = {
      get: vi.fn(async (id: string) => {
        const row = inserted.find((r) => r.id === id) ?? inserted[0];
        return row
          ? {
              id: String(row.id),
              name: String(row.name),
              game: String(row.game),
              nodeId: String(row.nodeId),
              runtimeMode: String(row.runtimeMode),
              status: String(row.status),
              dataPath: String(row.dataPath),
              createdAt: row.createdAt as Date,
            }
          : null;
      }),
      files: vi.fn(async () => {
        throw new Error("files_should_use_provisional_store_before_insert");
      }),
    };

    const config = {
      dataRoot,
      skillsRoots: [skillsRoot],
      runtimeMode: "docker",
    } as AppConfig;

    const adoption = new ServerAdoptionService(
      db as never,
      config,
      serversSvc as never,
      { create: vi.fn(async () => ({ id: "snap-1" })) } as never,
    );

    const svc = new ManageSuggestService(
      db as never,
      config,
      { importFromPath: vi.fn() } as never,
      serversSvc as never,
      adoption,
    );

    const report = await svc.manageFromNode({
      nodeId: "node-z",
      sourcePath: "/opt/pzserver",
      hintIds: ["project_zomboid_layout"],
    });

    expect(report.skillName).toBe("games.project-zomboid");
    expect(report.skillSource).toBe("detected");
    expect(report.draftSlug).toBeUndefined();
    expect(createdId).toBeTruthy();
    const marker = JSON.parse(
      fs.readFileSync(path.join(String(inserted[0]?.dataPath), "skill.json"), "utf8"),
    ) as { skillName: string; steamAppId?: number };
    expect(marker.skillName).toBe("games.project-zomboid");
    expect(marker.steamAppId).toBe(380870);
    expect(inserted[0]?.game).toBe("Project Zomboid");
  });
});
