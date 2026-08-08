import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NativeProcessSupervisor } from "./native-process.js";
import { PathJailError } from "./path-jail.js";

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
    await supervisor.stop(info.id);
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
