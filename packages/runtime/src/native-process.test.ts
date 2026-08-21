import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  NativeProcessSupervisor,
  serverTreeRoot,
  cmdlineOrphanRoots,
  readProcessGroupId,
  readCgroupRelativePath,
  shouldReapServerTreeOrphans,
  supervisedChildDetached,
} from "./native-process.js";
import { PathJailError } from "./path-jail.js";
import { spawn } from "node:child_process";

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
  throw new Error("tsx_missing: workspace deps required for #886 parent-exit helper");
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

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("NativeProcessSupervisor", () => {
  it("starts and stops a short-lived process", async () => {
    const jail = fs.mkdtempSync(path.join(os.tmpdir(), "playon-proc-"));
    temps.push(jail);

    const supervisor = new NativeProcessSupervisor(jail);
    const isWin = process.platform === "win32";
    const info = await supervisor.start({
      name: "echo",
      command: isWin ? "cmd.exe" : "sleep",
      args: isWin ? ["/c", "ping", "-n", "3", "127.0.0.1", ">nul"] : ["2"],
      cwd: ".",
    });

    expect(info.status).toBe("running");
    expect(info.pid).toBeTypeOf("number");
    expect(supervisor.list()).toEqual([
      expect.objectContaining({ id: info.id, name: "echo", status: "running" }),
    ]);
    await supervisor.stop(info.id);
    expect(supervisor.list()).toEqual([]);
    const stopped = await supervisor.status(info.id);
    expect(stopped.status).toBe("stopped");
  });

  it("rejects cwd outside the jail", async () => {
    const jail = fs.mkdtempSync(path.join(os.tmpdir(), "playon-proc-jail-"));
    temps.push(jail);
    const supervisor = new NativeProcessSupervisor(jail);

    await expect(
      supervisor.start({
        name: "escape",
        command: process.platform === "win32" ? "cmd.exe" : "true",
        args: process.platform === "win32" ? ["/c", "echo", "x"] : [],
        cwd: "..",
      }),
    ).rejects.toBeInstanceOf(PathJailError);
  });

  it("reclaim stops a prior tracked process with the same name before restart", async () => {
    if (process.platform === "win32") return;
    const jail = fs.mkdtempSync(path.join(os.tmpdir(), "playon-proc-reclaim-"));
    temps.push(jail);

    const supervisor = new NativeProcessSupervisor(jail);
    const first = await supervisor.start({
      name: "server-x",
      command: "sleep",
      args: ["30"],
      cwd: ".",
    });
    expect(first.status).toBe("running");
    const second = await supervisor.start({
      name: "server-x",
      command: "sleep",
      args: ["30"],
      cwd: ".",
    });
    expect(second.status).toBe("running");
    expect(second.id).not.toBe(first.id);
    const firstStatus = await supervisor.status(first.id);
    expect(firstStatus.status).toBe("stopped");
    await supervisor.stop(second.id);
  });

  it("finds a running process from name and cwd alone", async () => {
    if (process.platform === "win32") return;
    const jail = fs.mkdtempSync(path.join(os.tmpdir(), "playon-proc-find-"));
    temps.push(jail);
    const gameDir = path.join(jail, "game");
    fs.mkdirSync(gameDir, { recursive: true });

    const supervisor = new NativeProcessSupervisor(jail);
    await expect(supervisor.find("server-x", "game")).resolves.toBeNull();

    const started = await supervisor.start({
      name: "server-x",
      command: "sleep",
      args: ["30"],
      cwd: "game",
    });

    const found = await supervisor.find("server-x", "game");
    expect(found?.status).toBe("running");
    expect(found?.pid).toBe(started.pid);

    await supervisor.stop(started.id);
    await expect(supervisor.find("server-x", "game")).resolves.toBeNull();
  });

  it("derives the server tree root from a game/ launch cwd", () => {
    expect(serverTreeRoot("/data/servers/abc/game")).toBe("/data/servers/abc");
    expect(cmdlineOrphanRoots("/data/servers/abc/game")).toEqual([
      "/data/servers/abc/game",
      "/data/servers/abc/home",
    ]);
    expect(serverTreeRoot("C:\\data\\servers\\abc\\game")).toBe("C:\\data\\servers\\abc");
    expect(cmdlineOrphanRoots("C:\\data\\servers\\abc\\game")).toEqual([
      "C:\\data\\servers\\abc\\game",
      "C:\\data\\servers\\abc\\home",
    ]);
    expect(serverTreeRoot("/tmp/other")).toBe("/tmp/other");
    expect(shouldReapServerTreeOrphans("server-abc", "/data/servers/abc/game")).toBe(true);
    expect(shouldReapServerTreeOrphans("diag", "/data/servers/abc/game")).toBe(false);
    expect(shouldReapServerTreeOrphans("server-unknown", "/data/servers/abc/game")).toBe(false);
    expect(shouldReapServerTreeOrphans("server-abc", "/var/lib/playon-node")).toBe(false);
    expect(shouldReapServerTreeOrphans("", "/data/servers/abc/game")).toBe(false);
  });

  it("finds and reaps a leftover whose cwd left game/ for sibling home/", async () => {
    if (process.platform === "win32") return;
    const jail = fs.mkdtempSync(path.join(os.tmpdir(), "playon-proc-home-orphan-"));
    temps.push(jail);
    const gameDir = path.join(jail, "game");
    const homeDir = path.join(jail, "home", "Zomboid");
    fs.mkdirSync(gameDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });

    // Stands in for a JVM that chdir'd into userdata after launch.
    const leftover = spawn("sleep", ["30"], { cwd: homeDir, detached: true, stdio: "ignore" });
    leftover.unref();
    expect(leftover.pid).toBeTypeOf("number");

    const supervisor = new NativeProcessSupervisor(jail);
    const found = await supervisor.find("server-x", "game");
    expect(found?.status).toBe("running");
    expect(found?.pid).toBe(leftover.pid);

    const started = await supervisor.start({
      name: "server-x",
      command: "sleep",
      args: ["30"],
      cwd: "game",
    });
    expect(started.status).toBe("running");
    expect(started.pid).not.toBe(leftover.pid);
    await expect(supervisor.find("server-x", "game")).resolves.toMatchObject({
      pid: started.pid,
      status: "running",
    });
    expect(() => process.kill(leftover.pid!, 0)).toThrow();

    await supervisor.stop(started.id);
  });

  it("does not tree-reap a JVM when process_start/stop uses the game cwd with another name (#909)", async () => {
    if (process.platform === "win32") return;
    const jail = fs.mkdtempSync(path.join(os.tmpdir(), "playon-proc-cwd-footgun-"));
    temps.push(jail);
    const gameDir = path.join(jail, "servers", "B4KR", "game");
    const homeDir = path.join(jail, "servers", "B4KR", "home", "Zomboid");
    fs.mkdirSync(gameDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });

    const supervisor = new NativeProcessSupervisor(jail);
    const game = await supervisor.start({
      name: "server-B4KR",
      command: "sleep",
      args: ["30"],
      cwd: path.join("servers", "B4KR", "game"),
    });
    expect(game.pid).toBeTypeOf("number");

    // JVM-shaped leftover that left game/ for sibling home/.
    const jvm = spawn("sleep", ["30"], { cwd: homeDir, detached: true, stdio: "ignore" });
    jvm.unref();
    expect(jvm.pid).toBeTypeOf("number");

    const diag = await supervisor.start({
      name: "playon-diag-stop",
      command: "sleep",
      args: ["30"],
      cwd: path.join("servers", "B4KR", "game"),
    });
    expect(diag.pid).not.toBe(game.pid);
    expect(() => process.kill(game.pid!, 0)).not.toThrow();
    expect(() => process.kill(jvm.pid!, 0)).not.toThrow();

    await expect(
      supervisor.find("server-B4KR", path.join("servers", "B4KR", "game")),
    ).resolves.toMatchObject({ pid: game.pid, status: "running" });

    await supervisor.reclaim("playon-diag-stop", path.join(jail, "servers", "B4KR", "game"));
    expect(() => process.kill(game.pid!, 0)).not.toThrow();
    expect(() => process.kill(jvm.pid!, 0)).not.toThrow();

    await supervisor.stop(game.id);
    try {
      process.kill(jvm.pid!, "SIGKILL");
    } catch {
      /* gone */
    }
  });

  it("finds an untracked survivor by its cwd, so a lost id is not a lost process", async () => {
    if (process.platform === "win32") return;
    const jail = fs.mkdtempSync(path.join(os.tmpdir(), "playon-proc-orphan-"));
    temps.push(jail);
    const gameDir = path.join(jail, "game");
    fs.mkdirSync(gameDir, { recursive: true });

    const first = new NativeProcessSupervisor(jail);
    const started = await first.start({
      name: "server-x",
      command: "sleep",
      args: ["30"],
      cwd: "game",
    });

    // A fresh supervisor stands in for a restarted host: no tracked map, same process.
    const restarted = new NativeProcessSupervisor(jail);
    const found = await restarted.find("server-x", "game");
    expect(found?.status).toBe("running");
    expect(found?.name).toBe("server-x");

    await first.stop(started.id);
  });

  it("writes a console line to a process resolved from identity alone", async () => {
    if (process.platform === "win32") return;
    const jail = fs.mkdtempSync(path.join(os.tmpdir(), "playon-proc-stdin-"));
    temps.push(jail);
    const gameDir = path.join(jail, "game");
    fs.mkdirSync(gameDir, { recursive: true });

    const supervisor = new NativeProcessSupervisor(jail);
    const info = await supervisor.start({
      name: "server-x",
      // Stands in for a game that reads its console commands off stdin.
      command: "sh",
      args: ["-c", "while read line; do echo \"ran:$line\"; done"],
      cwd: "game",
      logFile: "logs/console.log",
      keepStdin: true,
    });

    await supervisor.writeStdin("server-x", "game", "say hi");
    await new Promise((r) => setTimeout(r, 400));

    expect(fs.readFileSync(path.join(jail, "logs", "console.log"), "utf8")).toContain("ran:say hi");
    await supervisor.stop(info.id);
  });

  it("refuses a console write for an identity it does not supervise", async () => {
    const jail = fs.mkdtempSync(path.join(os.tmpdir(), "playon-proc-no-stdin-"));
    temps.push(jail);
    const supervisor = new NativeProcessSupervisor(jail);

    // A restarted host can re-resolve an orphan, but it never inherits its pipes.
    await expect(supervisor.writeStdin("server-x", ".", "say hi")).rejects.toThrow(
      /stdin_unavailable/,
    );
  });

  it("places a native child in its own process group so an agent SIGTERM misses it (#886)", async () => {
    if (process.platform === "win32") return;
    const jail = fs.mkdtempSync(path.join(os.tmpdir(), "playon-proc-pgrp-"));
    temps.push(jail);
    const supervisor = new NativeProcessSupervisor(jail);
    const info = await supervisor.start({
      name: "server-pgrp",
      command: "sleep",
      args: ["30"],
      cwd: ".",
    });
    expect(supervisedChildDetached()).toBe(true);
    expect(info.pid).toBeTypeOf("number");
    const childPgrp = readProcessGroupId(info.pid!);
    const agentPgrp = readProcessGroupId(process.pid);
    expect(childPgrp).toBeTypeOf("number");
    expect(agentPgrp).toBeTypeOf("number");
    expect(childPgrp).not.toBe(agentPgrp);
    expect(childPgrp).toBe(info.pid);
    await supervisor.stop(info.id);
  });

  it("keepStdin child stays alive and does not see EOF when the agent parent exits (#886)", async () => {
    if (process.platform === "win32") return;
    const jail = fs.mkdtempSync(path.join(os.tmpdir(), "playon-proc-parent-exit-"));
    temps.push(jail);
    const status = path.join(jail, "status");
    const pidFile = path.join(jail, "child.pid");
    const holderFile = path.join(jail, "holder.pid");
    const helperSrc = fileURLToPath(new URL("./native-parent-exit.helper.ts", import.meta.url));
    const helper = spawn(resolveTsx(), [helperSrc], {
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        ...process.env,
        PLAYON_HELPER_JAIL: jail,
        PLAYON_HELPER_STATUS: status,
        PLAYON_HELPER_PID: pidFile,
        PLAYON_HELPER_HOLDER_PID: holderFile,
        PLAYON_HELPER_MODE: "exit",
      },
    });
    const helperExit = new Promise<number | null>((resolve, reject) => {
      helper.once("error", reject);
      helper.once("close", (code) => resolve(code));
    });
    await waitForStatus(status, "alive");
    const childPid = Number(await waitForFile(pidFile));
    expect(childPid).toBeGreaterThan(0);
    expect(await helperExit).toBe(0);
    await new Promise((r) => setTimeout(r, 400));
    expect(fs.readFileSync(status, "utf8").trim()).toBe("alive");
    expect(() => process.kill(childPid, 0)).not.toThrow();
    if (fs.existsSync(holderFile)) {
      const holderPid = Number(fs.readFileSync(holderFile, "utf8").trim());
      if (holderPid > 0) expect(() => process.kill(holderPid, 0)).not.toThrow();
    }
    try {
      process.kill(childPid, "SIGKILL");
    } catch {
      /* gone */
    }
    if (fs.existsSync(holderFile)) {
      try {
        process.kill(Number(fs.readFileSync(holderFile, "utf8").trim()), "SIGKILL");
      } catch {
        /* gone */
      }
    }
  }, 20_000);

  it("KillMode=process SIGTERM of MAINPID leaves keepStdin + FIFO holder running (#886)", async () => {
    if (process.platform === "win32") return;
    const jail = fs.mkdtempSync(path.join(os.tmpdir(), "playon-proc-killmode-"));
    temps.push(jail);
    const status = path.join(jail, "status");
    const pidFile = path.join(jail, "child.pid");
    const holderFile = path.join(jail, "holder.pid");
    const helperSrc = fileURLToPath(new URL("./native-parent-exit.helper.ts", import.meta.url));
    const helper = spawn(resolveTsx(), [helperSrc], {
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        ...process.env,
        PLAYON_HELPER_JAIL: jail,
        PLAYON_HELPER_STATUS: status,
        PLAYON_HELPER_PID: pidFile,
        PLAYON_HELPER_HOLDER_PID: holderFile,
        PLAYON_HELPER_MODE: "wait",
      },
    });
    await waitForStatus(status, "alive");
    const childPid = Number(await waitForFile(pidFile));
    const holderPid = Number(await waitForFile(holderFile));
    expect(helper.pid).toBeTypeOf("number");
    helper.kill("SIGTERM");
    await new Promise<void>((resolve) => helper.once("close", () => resolve()));
    await new Promise((r) => setTimeout(r, 400));
    expect(fs.readFileSync(status, "utf8").trim()).toBe("alive");
    expect(() => process.kill(childPid, 0)).not.toThrow();
    expect(() => process.kill(holderPid, 0)).not.toThrow();
    try {
      process.kill(childPid, "SIGKILL");
    } catch {
      /* gone */
    }
    try {
      process.kill(holderPid, "SIGKILL");
    } catch {
      /* gone */
    }
  }, 20_000);

  it("does not detach Windows keepStdin (FIFO is Linux-only)", () => {
    const src = fs.readFileSync(fileURLToPath(new URL("./native-process.ts", import.meta.url)), "utf8");
    expect(src).toMatch(/if \(process\.platform === "win32"\) return false;/);
    expect(src).toMatch(/supervisedChildDetached\(Boolean\(spec\.keepStdin\)\)/);
    expect(src).not.toMatch(/export function supervisedChildDetached\(\): boolean \{\s*return true;/);
  });

  it("records cgroup membership and does not treat detached as an escape (#886)", async () => {
    if (process.platform === "win32") return;
    const jail = fs.mkdtempSync(path.join(os.tmpdir(), "playon-proc-cgroup-"));
    temps.push(jail);
    const supervisor = new NativeProcessSupervisor(jail);
    const info = await supervisor.start({
      name: "server-cg",
      command: "sleep",
      args: ["30"],
      cwd: ".",
      keepStdin: true,
    });
    const agentCg = readCgroupRelativePath(process.pid);
    const childCg = info.pid ? readCgroupRelativePath(info.pid) : null;
    const holderPid = supervisor.stdinHolderPid("server-cg", ".");
    const holderCg = holderPid ? readCgroupRelativePath(holderPid) : null;
    expect(agentCg).toBeTypeOf("string");
    expect(childCg).toBeTypeOf("string");
    // Move is best-effort (often EACCES). Either they left the agent cgroup,
    // or NZL-shaped KillMode=process must keep them alive — covered above.
    if (childCg === agentCg) {
      expect(holderCg === agentCg || holderCg == null).toBe(true);
    }
    await supervisor.stop(info.id);
  });

  it("keepStdin console still works when stdin is a held FIFO (#886)", async () => {
    if (process.platform === "win32") return;
    const jail = fs.mkdtempSync(path.join(os.tmpdir(), "playon-proc-fifo-"));
    temps.push(jail);
    const gameDir = path.join(jail, "game");
    fs.mkdirSync(gameDir, { recursive: true });

    const supervisor = new NativeProcessSupervisor(jail);
    const info = await supervisor.start({
      name: "server-x",
      command: "sh",
      args: ["-c", "while read line; do echo \"ran:$line\"; done"],
      cwd: "game",
      logFile: "logs/console.log",
      keepStdin: true,
    });

    await supervisor.writeStdin("server-x", "game", "say hi");
    await new Promise((r) => setTimeout(r, 400));

    expect(fs.readFileSync(path.join(jail, "logs", "console.log"), "utf8")).toContain("ran:say hi");
    await supervisor.stop(info.id);
  });

  it("redirects stdout to logFile when provided", async () => {
    if (process.platform === "win32") return;
    const jail = fs.mkdtempSync(path.join(os.tmpdir(), "playon-proc-log-"));
    temps.push(jail);
    const logFile = path.join(jail, "logs", "console.log");
    const supervisor = new NativeProcessSupervisor(jail);
    const info = await supervisor.start({
      name: "echo-log",
      command: "sh",
      args: ["-c", "echo hello-from-native; sleep 1"],
      cwd: ".",
      logFile: "logs/console.log",
    });
    expect(info.status).toBe("running");
    await new Promise((r) => setTimeout(r, 400));
    await supervisor.stop(info.id);
    expect(fs.existsSync(logFile)).toBe(true);
    expect(fs.readFileSync(logFile, "utf8")).toContain("hello-from-native");
  });
});
