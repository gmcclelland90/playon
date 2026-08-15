import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_RELAUNCH_EXIT_CODE,
  AGENT_SUPERVISED_ENV,
  isAgentSupervised,
  performNodeSelfUpdate,
  requireWindowsUpdateHelper,
  resolveAgentEntry,
  runAgentSupervisorLoop,
  runExtractCommand,
  swapInstallTree,
} from "./self-update.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("swapInstallTree", () => {
  it("preserves data and env", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-swap-"));
    try {
      const target = path.join(root, "target");
      const source = path.join(root, "source");
      fs.mkdirSync(path.join(target, "data"), { recursive: true });
      fs.writeFileSync(path.join(target, "data", "keep.txt"), "keep");
      fs.mkdirSync(path.join(target, "env"), { recursive: true });
      fs.writeFileSync(path.join(target, "env", "secrets"), "secret");
      fs.writeFileSync(path.join(target, "old.txt"), "old");
      fs.mkdirSync(source, { recursive: true });
      fs.writeFileSync(path.join(source, "package.json"), "{}");
      fs.writeFileSync(path.join(source, "new.txt"), "new");
      fs.mkdirSync(path.join(source, "data"), { recursive: true });
      fs.writeFileSync(path.join(source, "data", "wipe.txt"), "wipe");

      const result = swapInstallTree({
        target,
        source,
        preserve: ["data", "env"],
      });
      expect(result.preserved).toContain("data");
      expect(fs.readFileSync(path.join(target, "data", "keep.txt"), "utf8")).toBe("keep");
      expect(fs.readFileSync(path.join(target, "env", "secrets"), "utf8")).toBe("secret");
      expect(fs.existsSync(path.join(target, "data", "wipe.txt"))).toBe(false);
      expect(fs.readFileSync(path.join(target, "new.txt"), "utf8")).toBe("new");
      expect(fs.existsSync(path.join(target, "old.txt"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("performNodeSelfUpdate", () => {
  it("downloads, verifies, and swaps with skipExit", async () => {
    if (process.platform === "win32") return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-self-"));
    try {
      const installRoot = path.join(root, "install");
      fs.mkdirSync(path.join(installRoot, "data"), { recursive: true });
      fs.writeFileSync(path.join(installRoot, "data", "state.db"), "db");

      const pkgDir = path.join(root, "pkg");
      const playonNode = path.join(pkgDir, "playon-node");
      fs.mkdirSync(path.join(playonNode, "apps", "node-agent", "dist"), { recursive: true });
      fs.writeFileSync(path.join(playonNode, "package.json"), JSON.stringify({ name: "playon-node", version: "0.1.5" }));
      fs.writeFileSync(path.join(playonNode, "apps", "node-agent", "dist", "index.js"), "// agent");
      const archive = path.join(root, "playon-node-0.1.5-linux-x64.tar.gz");
      const { execFileSync } = await import("node:child_process");
      execFileSync("tar", ["-czf", archive, "-C", pkgDir, "playon-node"]);
      const bytes = fs.readFileSync(archive);
      const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");

      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        })),
      );

      const result = await performNodeSelfUpdate({
        downloadUrl: "https://playon.games/home/packages/playon-node-0.1.5-linux-x64.tar.gz",
        sha256,
        version: "0.1.5",
        installRoot,
        skipExit: true,
      });
      expect(result.version).toBe("0.1.5");
      expect(result.preserved).toContain("data");
      expect(fs.readFileSync(path.join(installRoot, "data", "state.db"), "utf8")).toBe("db");
      expect(fs.existsSync(path.join(installRoot, "apps", "node-agent", "dist", "index.js"))).toBe(
        true,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves node.env and node.env.cmd by default", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-preserve-"));
    try {
      const target = path.join(root, "target");
      const source = path.join(root, "source");
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, "node.env"), "VAR=old");
      fs.writeFileSync(path.join(target, "node.env.cmd"), "set VAR=old");
      fs.mkdirSync(path.join(target, "data"), { recursive: true });
      fs.writeFileSync(path.join(target, "data", "keep.txt"), "keep");

      fs.mkdirSync(source, { recursive: true });
      fs.writeFileSync(path.join(source, "package.json"), "{}");
      fs.writeFileSync(path.join(source, "node.env"), "VAR=new");
      fs.writeFileSync(path.join(source, "node.env.cmd"), "set VAR=new");

      const result = swapInstallTree({
        target,
        source,
        preserve: ["data", "env", "node.env", "node.env.cmd"],
      });
      expect(result.preserved).toContain("data");
      expect(result.preserved).toContain("node.env");
      expect(result.preserved).toContain("node.env.cmd");
      expect(fs.readFileSync(path.join(target, "node.env"), "utf8")).toBe("VAR=old");
      expect(fs.readFileSync(path.join(target, "node.env.cmd"), "utf8")).toBe("set VAR=old");
      expect(fs.readFileSync(path.join(target, "data", "keep.txt"), "utf8")).toBe("keep");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws if Windows update helper script is missing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-win-"));
    try {
      const extracted = path.join(root, "playon-node");
      fs.mkdirSync(path.join(extracted, "apps", "node-agent", "dist"), { recursive: true });
      fs.writeFileSync(path.join(extracted, "package.json"), "{}");
      expect(() => requireWindowsUpdateHelper(extracted)).toThrow("update_helper_missing");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports update_extract_timeout instead of spawnSync ETIMEDOUT (#868)", async () => {
    if (process.platform === "win32") return;
    await expect(runExtractCommand("sleep", ["5"], 80)).rejects.toThrow(
      /update_extract_timeout: sleep exceeded 80ms/,
    );
  });

  it("does not unpack with execFileSync powershell and a 60s timeout", () => {
    const src = fs.readFileSync(fileURLToPath(new URL("./self-update.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/execFileSync/);
    expect(src).not.toMatch(/timeout:\s*60000/);
    expect(src).toMatch(/runExtractCommand/);
    expect(src).toMatch(/update_extract_timeout/);
    expect(src).toMatch(/buildArchiveExtractCommands/);
  });

  it("does not call require() in the ESM self-update helper (#885)", () => {
    const src = fs.readFileSync(fileURLToPath(new URL("./self-update.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/require\s*\(\s*["']node:child_process["']\s*\)/);
    expect(src).toMatch(/import \{ spawn \} from "node:child_process"/);
  });

  it("swapInstallTree does not delete sibling processes under data tree (#837 regression)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-sibling-"));
    try {
      const target = path.join(root, "target");
      const source = path.join(root, "source");

      // Simulate a game server executable under data/ (like Moria, VRising, etc.)
      fs.mkdirSync(path.join(target, "data", "servers", "vrising"), { recursive: true });
      fs.writeFileSync(path.join(target, "data", "servers", "vrising", "server.exe"), "fake PE");
      fs.writeFileSync(path.join(target, "data", "servers", "vrising", "world.db"), "save data");

      // Other data that should be preserved
      fs.writeFileSync(path.join(target, "data", "state.db"), "agent state");

      // Old package files that should be replaced
      fs.writeFileSync(path.join(target, "old-package.json"), "{}");
      fs.mkdirSync(path.join(target, "apps"), { recursive: true });
      fs.writeFileSync(path.join(target, "apps", "old-agent.js"), "old");

      // New package files
      fs.mkdirSync(path.join(source, "apps", "node-agent", "dist"), { recursive: true });
      fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ version: "0.2.3" }));
      fs.writeFileSync(path.join(source, "apps", "node-agent", "dist", "index.js"), "new agent");

      const result = swapInstallTree({
        target,
        source,
        preserve: ["data", "env"],
      });

      expect(result.preserved).toContain("data");

      // Data tree and all sibling game server files must survive the swap
      expect(fs.existsSync(path.join(target, "data", "servers", "vrising", "server.exe"))).toBe(true);
      expect(fs.readFileSync(path.join(target, "data", "servers", "vrising", "server.exe"), "utf8")).toBe("fake PE");
      expect(fs.existsSync(path.join(target, "data", "servers", "vrising", "world.db"))).toBe(true);
      expect(fs.existsSync(path.join(target, "data", "state.db"))).toBe(true);

      // New package files should be in place
      expect(fs.existsSync(path.join(target, "apps", "node-agent", "dist", "index.js"))).toBe(true);
      expect(fs.readFileSync(path.join(target, "package.json"), "utf8")).toContain("0.2.3");

      // Old files not in source should be gone
      expect(fs.existsSync(path.join(target, "old-package.json"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("agent supervisor relaunch (#886)", () => {
  it("treats PLAYON_AGENT_SUPERVISED=1 as already supervised", () => {
    expect(isAgentSupervised({ [AGENT_SUPERVISED_ENV]: "1" })).toBe(true);
    expect(isAgentSupervised({})).toBe(false);
    expect(AGENT_RELAUNCH_EXIT_CODE).toBe(75);
  });

  it("resolves the swapped agent entry when present", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-entry-"));
    try {
      const dest = path.join(root, "apps", "node-agent", "dist");
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, "index.js"), "// new");
      expect(resolveAgentEntry(root)).toBe(path.join(dest, "index.js"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("relaunch loop does not stop a sibling process", async () => {
    if (process.platform === "win32") return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playon-sup-"));
    const stamp = path.join(dir, "n");
    const ready = path.join(dir, "ready");
    fs.writeFileSync(stamp, "0");
    const sibling = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    sibling.unref();
    const children: import("node:child_process").ChildProcess[] = [];
    try {
      expect(sibling.pid).toBeTypeOf("number");
      runAgentSupervisorLoop({
        nodeBin: process.execPath,
        argv: [
          "-e",
          `
            const fs = require("node:fs");
            const n = Number(fs.readFileSync(process.env.STAMP, "utf8"));
            fs.writeFileSync(process.env.STAMP, String(n + 1));
            if (n === 0) process.exit(${AGENT_RELAUNCH_EXIT_CODE});
            fs.writeFileSync(process.env.READY, "1");
            setTimeout(() => {}, 60_000);
          `,
        ],
        env: { ...process.env, STAMP: stamp, READY: ready },
        exitProcess: false,
        onSpawn: (child) => children.push(child),
      });
      const deadline = Date.now() + 8_000;
      while (!fs.existsSync(ready) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(fs.existsSync(ready)).toBe(true);
      expect(fs.readFileSync(stamp, "utf8")).toBe("2");
      expect(() => process.kill(sibling.pid!, 0)).not.toThrow();
    } finally {
      for (const child of children) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* gone */
        }
      }
      try {
        process.kill(sibling.pid!, "SIGKILL");
      } catch {
        /* gone */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("OTA path does not process.exit the MAINPID on Linux and never stops servers", () => {
    const src = fs.readFileSync(fileURLToPath(new URL("./self-update.ts", import.meta.url)), "utf8");
    const index = fs.readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
    expect(src).toMatch(/runAgentSupervisorLoop/);
    expect(src).toMatch(/AGENT_RELAUNCH_EXIT_CODE/);
    expect(src).not.toMatch(/process_stop|container_stop|reclaim\(/);
    expect(index).toMatch(/relaunchUpdatedAgent/);
    expect(index).toMatch(/stopAgentLoops/);
    expect(index).not.toMatch(/process\.exit\(0\)/);
    const unit = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "deploy", "install-node.sh"),
      "utf8",
    );
    expect(unit).toMatch(/KillMode=process/);
    expect(unit).toMatch(/SendSIGHUP=no/);
    expect(unit).toMatch(/#886/);
  });
});

describe("apply-self-update.ps1", () => {
  it("detaches from the agent Job object and disables RestartCount before swapping", () => {
    const helper = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "deploy",
      "windows",
      "apply-self-update.ps1",
    );
    const src = fs.readFileSync(helper, "utf8");
    expect(src).toMatch(/\[switch\]\$Detached/);
    expect(src).toMatch(/Disable-ScheduledTask/);
    expect(src).toMatch(/PlayOnNodeAgentApplyUpdate/);
    expect(src).toMatch(/Register-ScheduledTask/);
    expect(src).toMatch(/CREATE_BREAKAWAY_FROM_JOB/);
    expect(src.indexOf("Disable-ScheduledTask")).toBeLessThan(src.indexOf("Waiting for node-agent"));
    expect(src.indexOf("Register-ScheduledTask")).toBeLessThan(src.indexOf("Waiting for node-agent"));
    expect(src).not.toMatch(/\brequire\s*\(/);
  });
});

describe("install-node.ps1 manifest extract (#868)", () => {
  it("extracts zip and tar.gz with tar --force-local, not Expand-Archive first", () => {
    const installer = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "deploy",
      "windows",
      "install-node.ps1",
    );
    const src = fs.readFileSync(installer, "utf8");
    expect(src).toMatch(/--force-local/);
    expect(src).toMatch(/& tar --force-local -xzf/);
    expect(src).toMatch(/ProgressPreference/);
    expect(src.indexOf("& tar --force-local -xzf")).toBeLessThan(src.lastIndexOf("Expand-Archive"));
  });
});
