import { spawn } from "node:child_process";
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
  isSystemdService,
  performNodeSelfUpdate,
  relaunchUpdatedAgent,
  requireWindowsUpdateHelper,
  resolveAgentEntry,
  runAgentSupervisorLoop,
  runExtractCommand,
  swapInstallTree,
} from "./self-update.js";

function repoRootFromHere(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

function resolveTsx(): string {
  const root = repoRootFromHere();
  const names = process.platform === "win32" ? ["tsx.cmd", "tsx"] : ["tsx"];
  for (const base of [
    path.join(root, "apps", "node-agent", "node_modules", ".bin"),
    path.join(root, "node_modules", ".bin"),
  ]) {
    for (const name of names) {
      const candidate = path.join(base, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error("tsx_missing: workspace deps required for #886 relaunch helper");
}

async function waitForFile(file: string, timeoutMs = 8_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8").trim()) {
      return fs.readFileSync(file, "utf8").trim();
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`timeout waiting for ${file}`);
}

async function waitForStatus(file: string, want: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      last = fs.readFileSync(file, "utf8").trim();
      if (last === want) return;
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`timeout waiting for ${file} === ${want} (last=${last})`);
}

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
    expect(isSystemdService({ INVOCATION_ID: "abc" })).toBe(true);
    expect(isSystemdService({})).toBe(false);
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

  it("relaunchUpdatedAgent under systemd exits MAINPID; keepStdin child sees no EOF", async () => {
    if (process.platform === "win32") return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playon-relaunch-exit-"));
    const jail = path.join(dir, "jail");
    fs.mkdirSync(jail, { recursive: true });
    const status = path.join(dir, "status");
    const pidFile = path.join(dir, "child.pid");
    const stamp = path.join(dir, "n");
    fs.writeFileSync(stamp, "0");
    const helperSrc = fileURLToPath(new URL("./relaunch-keep-stdin.helper.ts", import.meta.url));
    const helper = spawn(resolveTsx(), [helperSrc], {
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        ...process.env,
        INVOCATION_ID: "playon-886-test",
        PLAYON_HELPER_JAIL: jail,
        PLAYON_HELPER_STATUS: status,
        PLAYON_HELPER_PID: pidFile,
        PLAYON_HELPER_STAMP: stamp,
        PLAYON_HELPER_MODE: "exit-mainpid",
        PLAYON_HELPER_INSTALL_ROOT: dir,
      },
    });
    try {
      await waitForStatus(status, "alive");
      const childPid = Number(await waitForFile(pidFile));
      const helperExit = await new Promise<number | null>((resolve, reject) => {
        helper.once("error", reject);
        helper.once("close", (code) => resolve(code));
      });
      expect(helperExit).toBe(0);
      await new Promise((r) => setTimeout(r, 400));
      expect(fs.readFileSync(status, "utf8").trim()).toBe("alive");
      expect(() => process.kill(childPid, 0)).not.toThrow();
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        /* gone */
      }
    } finally {
      try {
        helper.kill("SIGKILL");
      } catch {
        /* gone */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("runAgentSupervisorLoop relaunches on 75 without EOF on a keepStdin child", async () => {
    if (process.platform === "win32") return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playon-sup-keepstdin-"));
    const jail = path.join(dir, "jail");
    fs.mkdirSync(jail, { recursive: true });
    const status = path.join(dir, "status");
    const pidFile = path.join(dir, "child.pid");
    const stamp = path.join(dir, "n");
    const ready = path.join(dir, "ready");
    fs.writeFileSync(stamp, "0");
    const helperSrc = fileURLToPath(new URL("./relaunch-keep-stdin.helper.ts", import.meta.url));
    const children: import("node:child_process").ChildProcess[] = [];
    try {
      runAgentSupervisorLoop({
        nodeBin: resolveTsx(),
        argv: [helperSrc],
        env: {
          ...process.env,
          PLAYON_HELPER_JAIL: jail,
          PLAYON_HELPER_STATUS: status,
          PLAYON_HELPER_PID: pidFile,
          PLAYON_HELPER_STAMP: stamp,
          PLAYON_HELPER_READY: ready,
          PLAYON_HELPER_MODE: "supervised",
        },
        exitProcess: false,
        onSpawn: (child) => children.push(child),
      });
      await waitForStatus(status, "alive");
      const childPid = Number(await waitForFile(pidFile));
      await waitForFile(ready);
      expect(fs.readFileSync(stamp, "utf8")).toBe("2");
      expect(fs.readFileSync(status, "utf8").trim()).toBe("alive");
      expect(() => process.kill(childPid, 0)).not.toThrow();
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        /* gone */
      }
    } finally {
      for (const child of children) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* gone */
        }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("relaunchUpdatedAgent skipExit is a no-op (not the NZL path)", () => {
    expect(relaunchUpdatedAgent({ installRoot: process.cwd(), skipExit: true })).toBeUndefined();
  });

  it("systemd OTA exits MAINPID; node units stay KillMode=process; Home API unit is untouched", () => {
    const src = fs.readFileSync(fileURLToPath(new URL("./self-update.ts", import.meta.url)), "utf8");
    const index = fs.readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
    expect(src).toMatch(/isSystemdService/);
    expect(src).toMatch(/INVOCATION_ID/);
    expect(src).toMatch(/runAgentSupervisorLoop/);
    expect(src).toMatch(/AGENT_RELAUNCH_EXIT_CODE/);
    expect(src).not.toMatch(/process_stop|container_stop|reclaim\(/);
    expect(index).toMatch(/relaunchUpdatedAgent/);
    expect(index).toMatch(/stopAgentLoops/);
    expect(index).not.toMatch(/process\.exit\(0\)/);
    const repo = path.dirname(fileURLToPath(new URL("../../../deploy/install-node.sh", import.meta.url)));
    const unit = fs.readFileSync(path.join(repo, "install-node.sh"), "utf8");
    expect(unit).toMatch(/KillMode=process/);
    expect(unit).toMatch(/SendSIGHUP=no/);
    expect(unit).toMatch(/#886/);
    const homeUnit = fs.readFileSync(
      path.join(repo, "..", "infra", "control-plane", "linux", "playon.service"),
      "utf8",
    );
    expect(homeUnit).toMatch(/Keep OTA\/apply helpers alive when the main process exits for self-update/);
    expect(homeUnit).not.toMatch(/#886/);
    expect(homeUnit).not.toMatch(/SendSIGHUP=no/);
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
