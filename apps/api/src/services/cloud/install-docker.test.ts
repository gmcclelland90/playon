import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../../config.js";
import { createDb } from "../../db/client.js";
import { applyBootstrap } from "../../db/migrate.js";
import { nodes } from "../../db/schema.js";
import {
  buildInstallDockerScript,
  clearInstallDockerTokensForTests,
  dockerManualInstallCommand,
  InstallDockerService,
  resolveEnsureDockerScriptPath,
} from "./install-docker.js";

const roots: string[] = [];

function tempConfig(): { config: AppConfig; root: string; dbPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-idock-"));
  roots.push(root);
  const dbPath = path.join(root, "playon.db");
  applyBootstrap(dbPath);
  const config: AppConfig = {
    port: 8787,
    dataRoot: root,
    dbPath,
    sessionSecret: "idock-test-secret-at-least-32-chars!!",
    llmMode: "openai_compatible",
    runtimeMode: "native",
    advertiseHost: "192.168.1.10",
    nodeToken: "node-token",
    skillsRoots: [],
  };
  return { config, root, dbPath };
}

describe("install-docker", () => {
  afterEach(() => {
    clearInstallDockerTokensForTests();
    for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
  });

  it("resolves ensure-docker.sh from the monorepo", () => {
    const p = resolveEnsureDockerScriptPath();
    expect(p).toBeTruthy();
    expect(fs.existsSync(p!)).toBe(true);
    const body = fs.readFileSync(p!, "utf8");
    expect(body).toContain("playon_ensure_docker");
    expect(body).toContain("PLAYON_INSTALL_DOCKER");
  });

  it("builds a self-contained install script that calls main", () => {
    const script = buildInstallDockerScript();
    expect(script).toContain("playon_ensure_docker_main");
    expect(script).toContain("playon_install_docker_ok");
    expect(script).not.toContain("return 0 2>/dev/null");
  });

  it("accepts an injected script body for tests without disk", () => {
    const script = buildInstallDockerScript({
      scriptBody: `playon_ensure_docker() { :; }\nplayon_ensure_docker_main() { playon_ensure_docker; }\n`,
    });
    expect(script).toContain("playon_ensure_docker_main");
  });

  it("manual command differs by OS", () => {
    expect(dockerManualInstallCommand("linux")).toContain("ensure-docker");
    expect(dockerManualInstallCommand("windows")).toContain("docker.com");
  });

  it("issues a one-liner token and redeems once", async () => {
    const { config, dbPath } = tempConfig();
    const { db, sqlite } = createDb(dbPath);
    await db.insert(nodes).values({
      id: "spare-1",
      name: "spare",
      os: "linux",
      docker: false,
      native: true,
      steamcmd: false,
      freeDiskBytes: null,
      agentVersion: "1",
      lastSeenAt: new Date(),
      kind: "lan",
      tunnelStatus: "none",
    });

    const svc = new InstallDockerService(db, config);
    const tok = await svc.createToken("spare-1");
    expect(tok.oneLiner).toContain("/api/nodes/spare-1/install-docker/");
    expect(tok.oneLiner).toContain("sudo bash");

    const script = await svc.scriptForToken("spare-1", tok.token);
    expect(script).toContain("playon_ensure_docker");

    await expect(svc.scriptForToken("spare-1", tok.token)).rejects.toThrow(
      /install_docker_token_invalid/,
    );
    sqlite.close();
  });

  it("rejects Windows nodes for install", async () => {
    const { config, dbPath } = tempConfig();
    const { db, sqlite } = createDb(dbPath);
    await db.insert(nodes).values({
      id: "win-1",
      name: "win",
      os: "windows",
      docker: false,
      native: true,
      steamcmd: false,
      freeDiskBytes: null,
      agentVersion: "1",
      lastSeenAt: new Date(),
      kind: "lan",
      tunnelStatus: "none",
    });
    const svc = new InstallDockerService(db, config);
    await expect(svc.createToken("win-1")).rejects.toThrow(/windows_unsupported/);
    sqlite.close();
  });

  it("SSH install uses ensure script and reports waiting detail", async () => {
    const { config, dbPath } = tempConfig();
    const { db, sqlite } = createDb(dbPath);
    await db.insert(nodes).values({
      id: "spare-2",
      name: "spare2",
      os: "linux",
      docker: false,
      native: true,
      steamcmd: false,
      freeDiskBytes: null,
      agentVersion: "1",
      lastSeenAt: new Date(),
      kind: "lan",
      tunnelStatus: "none",
    });

    let sawScript = "";
    const svc = new InstallDockerService(db, config, async (args) => {
      sawScript = args.script;
      return { stdout: "ok", stderr: "", code: 0 };
    });

    const res = await svc.installViaSsh({
      nodeId: "spare-2",
      host: "10.0.0.5",
      username: "root",
      password: "x",
    });
    expect(res.detail).toBe("install_docker_ok_waiting_heartbeat");
    expect(sawScript).toContain("playon_ensure_docker");
    sqlite.close();
  });
});
