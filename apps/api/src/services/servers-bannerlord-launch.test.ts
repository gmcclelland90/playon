import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { nodes as nodesTable, servers as serversTable } from "../db/schema.js";
import {
  BANNERLORD_SKILL,
  buildBannerlordWindowsStartBat,
} from "./native-launch.js";
import {
  REMOTE_NODE_ID,
  cleanupRuntimeHandleTemps,
  fake,
  host,
  node,
  resetRuntimeHandleFakes,
  tempEnv,
} from "./servers-runtime-handle-fakes.js";

vi.mock("./node-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./node-runtime.js")>();
  return {
    ...actual,
    dispatchNodeJob: (opts: { kind: string; args?: Record<string, unknown> }) =>
      node.dispatch(opts),
  };
});

vi.mock("./node-sync.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./node-sync.js")>();
  return { ...actual, pushServerDirToNode: async () => undefined };
});

vi.mock("@playon/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@playon/runtime")>();
  const { unitRuntimeDockerStubs } = await import("../test/unit-runtime-mocks.js");
  return {
    ...actual,
    ...unitRuntimeDockerStubs(actual),
    createRuntime: async () => ({
      docker: fake.docker as never,
      process: host.supervisor,
      mode: "docker" as const,
    }),
  };
});

function writeBannerlordSkill(skillsRoot: string): void {
  const skillDir = path.join(skillsRoot, "games", "bannerlord");
  fs.mkdirSync(path.join(skillDir, "guides"), { recursive: true });
  fs.mkdirSync(path.join(skillDir, "files"), { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "metadata.yaml"),
    [
      "name: games.bannerlord",
      "version: 0.1.4",
      "game: Bannerlord",
      "containerSupport: none",
      "os: [windows]",
      "steamAppId: 1863440",
      "adminDialect: stdin",
      "queryDialect: none",
      "native:",
      "  binary: bin/Win64_Shipping_Server/DedicatedCustomServer.Starter.exe",
      "  binaryWindows: bin/Win64_Shipping_Server/DedicatedCustomServer.Starter.exe",
      "  preferStartScript: true",
      "  workingDirectory: bin/Win64_Shipping_Server",
      "ports:",
      "  - name: game",
      "    protocol: udp",
      "    default: 7210",
      "healthChecks: []",
      "dependencies: []",
      "requiredTools: []",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(skillDir, "guides", "INSTALL.md"), "# Bannerlord\n");
  fs.writeFileSync(
    path.join(skillDir, "files", "start.bat"),
    "@echo off\nREM catalog 0.1.4 uses start /wait (Session 0 unsafe)\nstart /wait \"\" DedicatedCustomServer.Starter.exe\n",
  );
}

beforeEach(() => {
  resetRuntimeHandleFakes();
});

afterEach(() => {
  cleanupRuntimeHandleTemps();
  delete process.env.PLAYON_BANNERLORD_AUTH_TOKEN;
});

describe("games.bannerlord Windows remote launch (#956)", () => {
  it("overwrites start.bat with Session-0 /b /wait and forwards the auth token", async () => {
    process.env.PLAYON_BANNERLORD_AUTH_TOKEN = "lab-token-956";
    const { db, config, servers } = tempEnv();
    writeBannerlordSkill(path.join(config.dataRoot!, "skills"));
    await db.insert(nodesTable).values({
      id: REMOTE_NODE_ID,
      name: "playon-win-1",
      os: "windows",
      docker: false,
      native: true,
      steamcmd: true,
      lastSeenAt: new Date(),
      kind: "lan",
    });

    const created = await servers.createFromSkill({
      skillName: BANNERLORD_SKILL,
      serverName: "lab-matrix-bannerlord",
      nodeId: REMOTE_NODE_ID,
    });
    await db
      .update(serversTable)
      .set({ runtimeMode: "native" })
      .where(eq(serversTable.id, created.id));
    node.jobs.length = 0;

    const started = await servers.start(created.id);

    expect(started.status).toBe("running");
    const start = node.jobs.find((j) => j.kind === "process_start");
    expect(start?.args).toMatchObject({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/c", "start.bat"],
      cwd: `servers/${created.id}/game`,
      keepStdin: true,
      env: {
        PLAYON_SERVER_ID: created.id,
        PLAYON_BANNERLORD_AUTH_TOKEN: "lab-token-956",
      },
    });

    const batRel = `servers/${created.id}/game/start.bat`;
    const written = [...node.files.entries()].find(([p]) => p.endsWith("game/start.bat") || p === batRel);
    // Jail-relative write goes through fs_write_text as servers/<id>/game/start.bat
    const batContent =
      node.files.get(`servers/${created.id}/game/start.bat`) ??
      node.files.get("game/start.bat") ??
      written?.[1];
    expect(batContent ?? "").toContain("start /b /wait");
    expect(batContent ?? "").toBe(buildBannerlordWindowsStartBat());
  });
});
