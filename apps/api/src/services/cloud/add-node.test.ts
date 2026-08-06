import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb } from "../../db/client.js";
import { applyBootstrap } from "../../db/migrate.js";
import type { AppConfig } from "../../config.js";
import { nodes } from "../../db/schema.js";
import {
  AddNodeService,
  buildCloudBootstrapScript,
  buildLanBootstrapScript,
  classifyBootstrapFailure,
  classifySshAuthError,
  clearBootstrapTokensForTests,
  wrapRemotePrivilegedScript,
  type SshExec,
} from "./add-node.js";
import { TunnelService } from "./tunnel.js";
import { MemoryWireGuardRunner } from "./wireguard.js";

const roots: string[] = [];

function tempConfig(): { config: AppConfig; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-add-node-"));
  roots.push(root);
  const dbPath = path.join(root, "playon.db");
  applyBootstrap(dbPath);
  const config: AppConfig = {
    port: 8787,
    dataRoot: root,
    dbPath,
    sessionSecret: "add-node-test-secret-at-least-32-chars!",
    llmMode: "openai_compatible",
    runtimeMode: "native",
    advertiseHost: "192.168.1.10",
    nodeToken: "node-token",
    skillsRoots: [],
  };
  return { config, root };
}

describe("bootstrap scripts", () => {
  it("builds LAN install script", () => {
    const script = buildLanBootstrapScript({
      apiUrl: "http://192.168.1.10:8787",
      nodeToken: "tok",
      nodeId: "spare-1",
    });
    expect(script).toContain("--api 'http://192.168.1.10:8787'");
    expect(script).toContain("--node-id 'spare-1'");
  });

  it("builds cloud script with wireguard", () => {
    const script = buildCloudBootstrapScript({
      apiUrl: "http://10.77.0.1:8787",
      nodeToken: "tok",
      nodeId: "vps-1",
      wgConfig: "[Interface]\nPrivateKey = x\n",
      wgListenPort: 51820,
    });
    expect(script).toContain("wireguard");
    expect(script).toContain("wg-quick up playon0");
    expect(script).toContain("10.77.0.1:8787");
  });

  it("clears tokens helper", () => {
    clearBootstrapTokensForTests();
    expect(true).toBe(true);
  });
});

describe("wrapRemotePrivilegedScript", () => {
  it("runs as bash for root", () => {
    const w = wrapRemotePrivilegedScript("echo hi", { username: "root" });
    expect(w.command).toMatch(/^bash -lc /);
    expect(w.command).not.toContain("sudo");
    expect(w.stdin).toBeUndefined();
  });

  it("uses sudo -S with password on stdin for non-root", () => {
    const w = wrapRemotePrivilegedScript("echo hi", {
      username: "playon",
      password: "secret",
    });
    expect(w.command).toContain("sudo -S");
    expect(w.command).not.toContain("secret");
    expect(w.stdin).toBe("secret\n");
  });

  it("uses sudo -n when non-root without password", () => {
    const w = wrapRemotePrivilegedScript("echo hi", { username: "playon" });
    expect(w.command).toContain("sudo -n");
    expect(w.stdin).toBeUndefined();
  });
});

describe("error classification", () => {
  it("maps ssh auth failures", () => {
    expect(
      classifySshAuthError(new Error("All configured authentication methods failed")).message,
    ).toBe("ssh_auth_failed");
  });

  it("maps apt permission / root failures", () => {
    const err = classifyBootstrapFailure({
      code: 1,
      stdout: "",
      stderr:
        "E: Could not open lock file /var/lib/apt/lists/lock - open (13: Permission denied)",
    });
    expect(err.message).toMatch(/^ssh_needs_root_or_sudo:/);
  });
});

describe("AddNodeService.addViaSsh", () => {
  afterEach(() => {
    clearBootstrapTokensForTests();
    for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
  });

  it("removes pending placeholder on auth failure", async () => {
    const { config } = tempConfig();
    const { db, sqlite } = createDb(config.dbPath);
    const tunnel = new TunnelService(db, config, new MemoryWireGuardRunner());
    const sshExec: SshExec = async () => {
      throw new Error("All configured authentication methods failed");
    };
    const svc = new AddNodeService(db, config, tunnel, sshExec);

    await expect(
      svc.addViaSsh({
        kind: "lan",
        host: "192.168.1.50",
        username: "playon",
        password: "wrong",
        nodeName: "zomboid",
        nodeId: "node-auth-fail",
      }),
    ).rejects.toThrow("ssh_auth_failed");

    const rows = await db.select().from(nodes).where(eq(nodes.id, "node-auth-fail"));
    expect(rows).toHaveLength(0);
    sqlite.close();
  });

  it("removes pending placeholder on apt permission bootstrap failure", async () => {
    const { config } = tempConfig();
    const { db, sqlite } = createDb(config.dbPath);
    const tunnel = new TunnelService(db, config, new MemoryWireGuardRunner());
    const sshExec: SshExec = async () => ({
      code: 1,
      stdout: "",
      stderr:
        "E: Could not open lock file /var/lib/apt/lists/lock - open (13: Permission denied)",
    });
    const svc = new AddNodeService(db, config, tunnel, sshExec);

    await expect(
      svc.addViaSsh({
        kind: "lan",
        host: "192.168.1.50",
        username: "playon",
        password: "ok",
        nodeName: "zomboid",
        nodeId: "node-apt-fail",
      }),
    ).rejects.toThrow(/ssh_needs_root_or_sudo/);

    const rows = await db.select().from(nodes).where(eq(nodes.id, "node-apt-fail"));
    expect(rows).toHaveLength(0);
    sqlite.close();
  });

  it("keeps node on success and elevates non-root via sudo", async () => {
    const { config } = tempConfig();
    const { db, sqlite } = createDb(config.dbPath);
    const tunnel = new TunnelService(db, config, new MemoryWireGuardRunner());
    let seenScript = "";
    let seenStdin: string | undefined;
    const sshExec: SshExec = async (args) => {
      seenScript = args.script;
      seenStdin = args.stdin;
      return { code: 0, stdout: "ok", stderr: "" };
    };
    const svc = new AddNodeService(db, config, tunnel, sshExec);

    const result = await svc.addViaSsh({
      kind: "lan",
      host: "192.168.1.50",
      username: "playon",
      password: "ok",
      nodeName: "spare",
      nodeId: "node-ok",
    });

    expect(result.detail).toBe("bootstrap_ok_waiting_heartbeat");
    expect(seenScript).toContain("sudo -S");
    expect(seenStdin).toBe("ok\n");
    const rows = await db.select().from(nodes).where(eq(nodes.id, "node-ok"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.agentVersion).toBe("pending");
    expect(rows[0]?.lastSeenAt.getTime()).toBe(0);
    sqlite.close();
  });

  it("does not delete pre-existing one-liner placeholder on SSH failure", async () => {
    const { config } = tempConfig();
    const { db, sqlite } = createDb(config.dbPath);
    const tunnel = new TunnelService(db, config, new MemoryWireGuardRunner());
    await db.insert(nodes).values({
      id: "node-preexisting",
      name: "from-token",
      os: "linux",
      docker: false,
      native: true,
      steamcmd: false,
      freeDiskBytes: null,
      agentVersion: "pending",
      lastSeenAt: new Date(),
      kind: "lan",
      tunnelStatus: "none",
    });
    const sshExec: SshExec = async () => {
      throw new Error("All configured authentication methods failed");
    };
    const svc = new AddNodeService(db, config, tunnel, sshExec);

    await expect(
      svc.addViaSsh({
        kind: "lan",
        host: "192.168.1.50",
        username: "root",
        password: "x",
        nodeId: "node-preexisting",
      }),
    ).rejects.toThrow("ssh_auth_failed");

    const rows = await db.select().from(nodes).where(eq(nodes.id, "node-preexisting"));
    expect(rows).toHaveLength(1);
    sqlite.close();
  });
});
