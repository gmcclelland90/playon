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
});
