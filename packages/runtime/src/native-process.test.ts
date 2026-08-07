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
});
