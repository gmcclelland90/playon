import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_KILL_MODE_ENV,
  AGENT_RELAUNCH_EXIT_CODE,
  AGENT_SUPERVISED_ENV,
  applyNodeInstallSwap,
  ensureWindowsStartNodeCmd,
  extractArchive,
  isAgentSupervised,
  isSystemdService,
  performNodeSelfUpdate,
  readSystemdKillMode,
  relaunchUpdatedAgent,
  requireWindowsUpdateHelper,
  resolveAgentEntry,
  runAgentSupervisorLoop,
  runExtractCommand,
  shouldExitSystemdMainPid,
  swapInstallTree,
} from "./self-update.js";
import {
  VINTAGE_PACKAGED_WINDOWS_START_NODE_CMD,
  bundledWindowsStartNodeCmd,
  startNodeCmdLoadsNodeEnv,
} from "@playon/shared";

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

  it("rejects HTML download before apply (#917)", async () => {
    const html = Buffer.from("<!DOCTYPE html><html><body>not the tarball</body></html>");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        headers: { get: (name: string) => (name === "content-type" ? "text/html" : null) },
        arrayBuffer: async () =>
          html.buffer.slice(html.byteOffset, html.byteOffset + html.byteLength),
      })),
    );
    await expect(
      performNodeSelfUpdate({
        downloadUrl: "https://github.com/gmcclelland90/playon/releases/download/v0.2.11/playon-node-0.2.11-windows-x64.tar.gz",
        sha256: "c2ab7575e942a1d3265def8b7fdeec9ae2ff3e8d7b131883196708385c18305a",
        version: "0.2.11",
        expectedSize: 39600808,
        skipExit: true,
      }),
    ).rejects.toThrow(/update_download_size_mismatch|update_download_not_archive/);
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
    expect(src).not.toMatch(/execFileSync\(\s*["']powershell/);
    expect(src).not.toMatch(/timeout:\s*60000/);
    expect(src).toMatch(/runExtractCommand/);
    expect(src).toMatch(/update_extract_timeout/);
    expect(src).toMatch(/buildArchiveExtractCommands/);
    // systemctl show KillMode only — never archive extract (#868 / #909).
    expect(src).toMatch(/execFileSync\("systemctl"/);
  });

  it("does not call require() in the ESM self-update helper (#885)", () => {
    const src = fs.readFileSync(fileURLToPath(new URL("./self-update.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/require\s*\(\s*["']node:child_process["']\s*\)/);
    expect(src).toMatch(/import \{ execFileSync, spawn, type ChildProcess \} from "node:child_process"/);
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
    expect(isSystemdService({ PLAYON_AGENT_EXIT_MAINPID: "1" })).toBe(true);
    expect(isSystemdService({})).toBe(false);
    expect(AGENT_RELAUNCH_EXIT_CODE).toBe(75);
    expect(shouldExitSystemdMainPid({ killMode: "process" })).toBe(true);
    expect(shouldExitSystemdMainPid({ killMode: "process", hasPipeStdin: true })).toBe(false);
    expect(shouldExitSystemdMainPid({ killMode: "control-group" })).toBe(false);
    expect(shouldExitSystemdMainPid({ killMode: "mixed" })).toBe(false);
    expect(shouldExitSystemdMainPid({ killMode: null })).toBe(false);
    expect(readSystemdKillMode({ [AGENT_KILL_MODE_ENV]: "control-group" })).toBe("control-group");
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
        PLAYON_AGENT_EXIT_MAINPID: "1",
        [AGENT_KILL_MODE_ENV]: "process",
        PLAYON_HELPER_JAIL: jail,
        PLAYON_HELPER_STATUS: status,
        PLAYON_HELPER_PID: pidFile,
        PLAYON_HELPER_STAMP: stamp,
        PLAYON_HELPER_MODE: "exit-mainpid",
        PLAYON_HELPER_INSTALL_ROOT: dir,
      },
    });
    const helperExit = new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("helper_did_not_exit: relaunchUpdatedAgent must exit MAINPID")),
        8_000,
      );
      helper.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      helper.once("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    try {
      await waitForStatus(status, "alive");
      const childPid = Number(await waitForFile(pidFile));
      expect(await helperExit).toBe(0);
      // Settle so an EOF from MAINPID death would show up, then poll — a
      // single read can catch writeFileSync's truncate-before-write window
      // (`''` instead of `alive`) on a loaded ubuntu-latest runner.
      await new Promise((r) => setTimeout(r, 400));
      await waitForStatus(status, "alive");
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

  it("systemd OTA exits MAINPID only when KillMode=process; node units stay KillMode=process; Home API unit is untouched", () => {
    const src = fs.readFileSync(fileURLToPath(new URL("./self-update.ts", import.meta.url)), "utf8");
    const index = fs.readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
    expect(src).toMatch(/isSystemdService/);
    expect(src).toMatch(/INVOCATION_ID/);
    expect(src).toMatch(/shouldExitSystemdMainPid/);
    expect(src).toMatch(/readSystemdKillMode/);
    expect(src).toMatch(/runAgentSupervisorLoop/);
    expect(src).toMatch(/AGENT_RELAUNCH_EXIT_CODE/);
    expect(src).not.toMatch(/process_stop|container_stop|reclaim\(/);
    expect(index).toMatch(/relaunchUpdatedAgent/);
    expect(index).toMatch(/hasPipeStdin/);
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

  it("KillMode=control-group keeps MAINPID; native child outside the install tree is not signaled (#909)", async () => {
    if (process.platform === "win32") return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playon-relaunch-cg-"));
    const installRoot = path.join(dir, "opt-playon-node");
    const jail = path.join(dir, "var-lib-playon-node", "servers", "nzl", "game");
    fs.mkdirSync(path.join(installRoot, "apps", "node-agent", "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(installRoot, "apps", "node-agent", "dist", "index.js"),
      "setInterval(() => {}, 60_000);\n",
    );
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
        INVOCATION_ID: "playon-909-test",
        PLAYON_AGENT_EXIT_MAINPID: "1",
        [AGENT_KILL_MODE_ENV]: "control-group",
        PLAYON_HELPER_JAIL: jail,
        PLAYON_HELPER_STATUS: status,
        PLAYON_HELPER_PID: pidFile,
        PLAYON_HELPER_STAMP: stamp,
        PLAYON_HELPER_MODE: "exit-mainpid",
        PLAYON_HELPER_INSTALL_ROOT: installRoot,
      },
    });
    try {
      await waitForStatus(status, "alive");
      const childPid = Number(await waitForFile(pidFile));
      expect(childPid).toBeGreaterThan(0);
      // MAINPID must stay — exiting would let systemd KillMode=control-group
      // SIGTERM every leftover in the unit cgroup, including this game.
      await new Promise((r) => setTimeout(r, 600));
      expect(helper.exitCode).toBeNull();
      expect(() => process.kill(helper.pid!, 0)).not.toThrow();
      expect(fs.readFileSync(status, "utf8").trim()).toBe("alive");
      expect(() => process.kill(childPid, 0)).not.toThrow();
      const childCwd = fs.readlinkSync(`/proc/${childPid}/cwd`);
      expect(childCwd.startsWith(installRoot)).toBe(false);
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
      try {
        const { execFileSync } = await import("node:child_process");
        const out = execFileSync(
          "pgrep",
          ["-f", path.join(installRoot, "apps", "node-agent", "dist", "index.js")],
          { encoding: "utf8" },
        );
        for (const line of out.trim().split("\n")) {
          const pid = Number(line.trim());
          if (Number.isInteger(pid) && pid > 0) {
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              /* gone */
            }
          }
        }
      } catch {
        /* no leftover supervisor child */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("Windows OTA start-node.cmd Home wiring", () => {
  it("repairs a vintage packaged launcher that omitted call node.env.cmd", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-start-node-"));
    try {
      fs.writeFileSync(path.join(root, "start-node.cmd"), VINTAGE_PACKAGED_WINDOWS_START_NODE_CMD);
      fs.writeFileSync(
        path.join(root, "node.env.cmd"),
        "set PLAYON_API_URL=https://home.example:8787\n",
      );
      expect(startNodeCmdLoadsNodeEnv(fs.readFileSync(path.join(root, "start-node.cmd"), "utf8"))).toBe(
        false,
      );
      const { repaired } = ensureWindowsStartNodeCmd(root);
      expect(repaired).toBe(true);
      const after = fs.readFileSync(path.join(root, "start-node.cmd"), "utf8");
      expect(startNodeCmdLoadsNodeEnv(after)).toBe(true);
      expect(after).toBe(bundledWindowsStartNodeCmd());
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("after simulated Windows extract/apply still calls node.env.cmd", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-win-ota-env-"));
    try {
      const installRoot = path.join(root, "install");
      fs.mkdirSync(path.join(installRoot, "data"), { recursive: true });
      fs.writeFileSync(
        path.join(installRoot, "node.env.cmd"),
        [
          "set PLAYON_API_URL=https://home.example:8787",
          "set PLAYON_NODE_TOKEN=secret-token",
          "set PLAYON_NODE_ID=playon-win-1",
          `set PLAYON_DATA_ROOT=${path.join(installRoot, "data")}`,
          "",
        ].join("\n"),
      );
      fs.writeFileSync(
        path.join(installRoot, "start-node.cmd"),
        [
          "@echo off",
          `call "${path.join(installRoot, "node.env.cmd")}"`,
          `cd /d "${installRoot}"`,
          `"${path.join(installRoot, "runtime", "node", "node.exe")}" "${path.join(installRoot, "apps", "node-agent", "dist", "index.js")}" >> "${path.join(installRoot, "data", "agent-stdout.log")}" 2>&1`,
          "",
        ].join("\n"),
      );
      fs.writeFileSync(path.join(installRoot, "data", "state.db"), "db");

      const pkgDir = path.join(root, "pkg");
      const playonNode = path.join(pkgDir, "playon-node");
      fs.mkdirSync(path.join(playonNode, "apps", "node-agent", "dist"), { recursive: true });
      fs.mkdirSync(path.join(playonNode, "deploy", "windows"), { recursive: true });
      fs.writeFileSync(
        path.join(playonNode, "package.json"),
        JSON.stringify({ name: "playon-node", version: "0.2.10" }),
      );
      fs.writeFileSync(path.join(playonNode, "apps", "node-agent", "dist", "index.js"), "// agent");
      fs.writeFileSync(
        path.join(playonNode, "start-node.cmd"),
        VINTAGE_PACKAGED_WINDOWS_START_NODE_CMD,
      );
      fs.writeFileSync(
        path.join(playonNode, "deploy", "windows", "apply-self-update.ps1"),
        "# helper\n",
      );

      const archive = path.join(root, "playon-node-0.2.10-windows-x64.tar.gz");
      const { execFileSync } = await import("node:child_process");
      execFileSync("tar", ["-czf", archive, "-C", pkgDir, "playon-node"]);

      const extracted = await extractArchive(archive, path.join(root, "extracted"));
      expect(fs.readFileSync(path.join(extracted, "start-node.cmd"), "utf8")).toBe(
        VINTAGE_PACKAGED_WINDOWS_START_NODE_CMD,
      );

      const result = applyNodeInstallSwap({
        target: installRoot,
        source: extracted,
        preserve: ["data", "env", "node.env", "node.env.cmd"],
      });
      expect(result.preserved).toContain("data");
      expect(result.preserved).toContain("node.env.cmd");
      expect(result.startNodeRepaired).toBe(true);

      const startCmd = fs.readFileSync(path.join(installRoot, "start-node.cmd"), "utf8");
      expect(startNodeCmdLoadsNodeEnv(startCmd)).toBe(true);
      expect(startCmd).toMatch(/call "%~dp0node\.env\.cmd"/);
      expect(fs.readFileSync(path.join(installRoot, "node.env.cmd"), "utf8")).toContain(
        "https://home.example:8787",
      );
      expect(fs.readFileSync(path.join(installRoot, "data", "state.db"), "utf8")).toBe("db");
      expect(fs.existsSync(path.join(installRoot, "apps", "node-agent", "dist", "index.js"))).toBe(
        true,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("swap of the current bundled launcher keeps Home wiring without a rewrite", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-bundled-cmd-"));
    try {
      const target = path.join(root, "target");
      const source = path.join(root, "source");
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, "node.env.cmd"), "set PLAYON_API_URL=https://home.example:8787\n");
      fs.writeFileSync(
        path.join(target, "start-node.cmd"),
        `call "${path.join(target, "node.env.cmd")}"\n`,
      );
      fs.mkdirSync(source, { recursive: true });
      fs.writeFileSync(path.join(source, "package.json"), "{}");
      fs.writeFileSync(path.join(source, "start-node.cmd"), bundledWindowsStartNodeCmd());

      const result = applyNodeInstallSwap({
        target,
        source,
        preserve: ["data", "env", "node.env", "node.env.cmd"],
      });
      expect(result.startNodeRepaired).toBe(false);
      expect(startNodeCmdLoadsNodeEnv(fs.readFileSync(path.join(target, "start-node.cmd"), "utf8"))).toBe(
        true,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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
    expect(src).toMatch(/function Write-PortableStartNodeCmd/);
    expect(src).toMatch(/if exist "%~dp0node\.env\.cmd" call "%~dp0node\.env\.cmd"/);
    expect(src.indexOf("Write-PortableStartNodeCmd -Dir $TargetDir")).toBeGreaterThan(
      src.indexOf("Copying:"),
    );
    expect(src.indexOf("Write-PortableStartNodeCmd -Dir $TargetDir")).toBeLessThan(
      src.indexOf("Agent missing after swap"),
    );
    const portable = src.match(
      /function Write-PortableStartNodeCmd[\s\S]*?@"\r?\n([\s\S]*?)\r?\n"@/,
    );
    expect(portable?.[1]).toBeTruthy();
    expect(startNodeCmdLoadsNodeEnv(portable![1])).toBe(true);
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
