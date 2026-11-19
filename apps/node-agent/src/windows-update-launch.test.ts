import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SCHTASKS_TR_MAX,
  WINDOWS_APPLY_UPDATE_TASK_NAME,
  WINDOWS_HELPER_ARMED_MARK,
  buildScheduledTaskLaunchScript,
  buildSchtasksCreateArgs,
  buildWindowsHelperArguments,
  buildWindowsHelperLauncherPs1,
  buildWmiLaunchScript,
  formatSchtasksTr,
  helperArmConfirmed,
  launchWindowsUpdateHelper,
  powershellSingleQuote,
  runWindowsHelperLaunchAttempts,
  schtasksOnceLocalTime,
  waitForHelperStart,
  windowsHelperLauncherPath,
  windowsHelperMarkerPath,
  windowsUpdateLaunchOrder,
  type CapturedProcess,
} from "./windows-update-launch.js";

const failed = (stderr: string, code = 1): CapturedProcess => ({ code, stdout: "", stderr });

describe("Windows update helper launch (#1060 / #1041)", () => {
  it("tries a one-shot scheduled task, then schtasks, then WMI", () => {
    expect(windowsUpdateLaunchOrder()).toEqual(["scheduled-task", "schtasks", "wmi"]);
  });

  it("confirms only a fresh armed marker or armed log line", () => {
    expect(helperArmConfirmed({ logSlice: "", markerText: "pid=4\r\n" })).toBe(true);
    expect(helperArmConfirmed({ logSlice: "", markerText: "   " })).toBe(false);
    expect(helperArmConfirmed({ logSlice: "", markerText: null })).toBe(false);
    expect(
      helperArmConfirmed({
        logSlice: `[2026-11-19] ${WINDOWS_HELPER_ARMED_MARK} pid=9`,
        markerText: null,
      }),
    ).toBe(true);
    expect(
      helperArmConfirmed({
        logSlice: "[node-agent] helper launcher start",
        markerText: null,
      }),
    ).toBe(false);
  });

  it("quotes PowerShell strings and keeps the schtasks action under 261 characters", () => {
    expect(powershellSingleQuote("C:\\playon's\\data")).toBe("'C:\\playon''s\\data'");
    const launcher = "C:\\playon-node\\data\\ota-apply-Xx0CtGMqrIhB0sI4vvn96-launch.ps1";
    const tr = formatSchtasksTr(launcher);
    expect(tr.length).toBeLessThanOrEqual(SCHTASKS_TR_MAX);
    expect(tr).toContain(launcher);
    expect(tr).not.toContain("apply-self-update.ps1");
    const args = buildSchtasksCreateArgs({
      taskName: WINDOWS_APPLY_UPDATE_TASK_NAME,
      launcherPs1: launcher,
      startTime: "13:48",
    });
    expect(args).toEqual([
      "/Create",
      "/TN",
      WINDOWS_APPLY_UPDATE_TASK_NAME,
      "/SC",
      "ONCE",
      "/ST",
      "13:48",
      "/RL",
      "HIGHEST",
      "/F",
      "/TR",
      tr,
    ]);
    expect(buildSchtasksCreateArgs({
      taskName: WINDOWS_APPLY_UPDATE_TASK_NAME,
      launcherPs1: launcher,
      startTime: "13:48",
      highest: false,
    })).not.toContain("/RL");
    expect(() =>
      buildSchtasksCreateArgs({
        taskName: WINDOWS_APPLY_UPDATE_TASK_NAME,
        launcherPs1: "C:\\" + "a".repeat(300) + "\\launch.ps1",
        startTime: "13:48",
      }),
    ).toThrow(/schtasks_tr_too_long/);
    expect(schtasksOnceLocalTime(new Date(2026, 10, 19, 3, 58, 30))).toBe("04:00");
    expect(schtasksOnceLocalTime(new Date(2026, 10, 19, 23, 59, 0))).toBe("00:01");
  });

  it("moves the launcher to temp when the apply-log path would overflow schtasks /TR", () => {
    const deep = path.join("C:\\", "a".repeat(240), "ota-apply-job.log");
    const launcher = windowsHelperLauncherPath(deep);
    expect(formatSchtasksTr(launcher).length).toBeLessThanOrEqual(SCHTASKS_TR_MAX);
    expect(path.dirname(launcher)).toBe(os.tmpdir());
    const normal = windowsHelperMarkerPath("C:\\playon-node\\data\\ota-apply-job.log");
    expect(normal.endsWith("ota-apply-job.started")).toBe(true);
    expect(windowsHelperLauncherPath("C:\\playon-node\\data\\ota-apply-job.log")).toMatch(
      /ota-apply-job-launch\.ps1$/,
    );
  });

  it("builds an ASCII launcher that runs the helper detached and captures stderr", () => {
    const helperArgs = buildWindowsHelperArguments({
      sourceDir: "C:\\Users\\playon\\AppData\\Local\\Temp\\playon-node-update-QExXeP\\playon-node",
      targetDir: "C:\\playon-node",
      agentPid: 272,
      version: "0.2.20",
      applyLog: "C:\\playon-node\\data\\ota-apply-Xx0CtGMqrIhB0sI4vvn96.log",
      startedMarker: "C:\\playon-node\\data\\ota-apply-Xx0CtGMqrIhB0sI4vvn96.started",
      preserve: ["data", "node.env.cmd"],
    });
    expect(helperArgs).toContain("-Detached");
    expect(helperArgs).toContain("-ApplyLog");
    expect(helperArgs).toContain("-StartedMarker");
    const launcher = buildWindowsHelperLauncherPs1({
      helperScript: "C:\\staged\\deploy\\windows\\apply-self-update.ps1",
      helperArgs,
      logPath: "C:\\playon-node\\data\\ota-apply-Xx0CtGMqrIhB0sI4vvn96.log",
    });
    expect(launcher).toContain("-Detached");
    expect(launcher).toContain("apply-self-update.ps1");
    expect(launcher).toContain("2>&1");
    expect(launcher).toContain("ota-apply-Xx0CtGMqrIhB0sI4vvn96.log");
    expect(launcher).toContain("helper launcher start");
    expect([...Buffer.from(launcher, "utf8")].every((byte) => byte < 128)).toBe(true);

    const task = buildScheduledTaskLaunchScript({
      launcherPs1: "C:\\playon-node\\data\\ota-apply-Xx0CtGMqrIhB0sI4vvn96-launch.ps1",
    });
    expect(task).toContain("Schedule.Service");
    expect(task).toContain("PlayOnNodeAgentApplyUpdate");
    expect(task).toContain("PlayOnNodeAgent");
    expect(task).toContain("$task.Principal.LogonType = $principal.LogonType");
    expect(task).toContain("$task.Principal.RunLevel = $principal.RunLevel");
    expect(task).toContain("$task.Principal.LogonType = 2");
    expect(task).toContain("$task.Principal.RunLevel = 1");
    expect(task).toContain("RegisterTaskDefinition");
    expect(task).toContain(".Run($null)");
    expect(task).toContain("PLAYON_UPDATE_TASK_STARTED");
    expect(task).not.toContain("schtasks");
    expect(task).not.toContain("CREATE_BREAKAWAY_FROM_JOB");
    expect([...Buffer.from(task, "utf8")].every((byte) => byte < 128)).toBe(true);

    const wmi = buildWmiLaunchScript({
      launcherPs1: "C:\\playon-node\\data\\ota-apply-Xx0CtGMqrIhB0sI4vvn96-launch.ps1",
    });
    expect(wmi).toContain(String.raw`[wmiclass]"\\.\root\cimv2:Win32_Process"`);
    expect(wmi).toContain("PLAYON_WMI_PID=");
    expect([...Buffer.from(wmi, "utf8")].every((byte) => byte < 128)).toBe(true);
  });

  it("returns on the first method that arms and does not try the later ones", async () => {
    const calls: string[] = [];
    const slept: number[] = [];
    const method = await runWindowsHelperLaunchAttempts({
      settleMs: 25,
      sleep: async (ms) => {
        slept.push(ms);
      },
      attempt: async (name) => {
        calls.push(name);
        if (name === "scheduled-task") return { launched: false, detail: "access denied" };
        return { launched: true };
      },
      confirm: async () => calls.includes("schtasks"),
      cleanup: async (name) => {
        calls.push(`cleanup:${name}`);
      },
    });
    expect(method).toBe("schtasks");
    expect(calls).toEqual(["scheduled-task", "cleanup:scheduled-task", "schtasks"]);
    expect(slept).toEqual([25]);
  });

  it("throws update_helper_not_started and does not treat a failed launch as success", async () => {
    const calls: string[] = [];
    await expect(
      runWindowsHelperLaunchAttempts({
        timeoutMs: 15,
        settleMs: 500,
        sleep: async () => {
          throw new Error("settle must not run");
        },
        attempt: async (name) => {
          calls.push(name);
          if (name === "wmi") throw new Error("wmi blocked");
          return { launched: true };
        },
        confirm: async () => false,
        cleanup: async (name) => {
          calls.push(`cleanup:${name}`);
        },
        log: () => {},
      }),
    ).rejects.toThrow(/update_helper_not_started:[\s\S]*Staying on the current version/);
    expect(calls).toEqual([
      "scheduled-task",
      "cleanup:scheduled-task",
      "schtasks",
      "cleanup:schtasks",
      "wmi",
      "cleanup:wmi",
    ]);
  });

  it("sees a marker written during the wait and ignores an older armed line", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playon-arm-"));
    const logPath = path.join(dir, "ota-apply-job.log");
    const markerPath = path.join(dir, "ota-apply-job.started");
    fs.writeFileSync(logPath, `[old] ${WINDOWS_HELPER_ARMED_MARK} pid=1\n`);
    const offset = fs.statSync(logPath).size;
    try {
      await expect(
        waitForHelperStart({ logPath, markerPath, logOffset: offset, timeoutMs: 80, pollMs: 20 }),
      ).resolves.toBe(false);
      const pending = waitForHelperStart({
        logPath,
        markerPath,
        logOffset: offset,
        timeoutMs: 2_000,
        pollMs: 20,
      });
      setTimeout(() => fs.writeFileSync(markerPath, "pid=4\r\n"), 30);
      await expect(pending).resolves.toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops after the scheduled task writes the marker and leaves schtasks unused", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playon-launch-"));
    const logPath = path.join(dir, "ota-apply-job.log");
    const markerPath = windowsHelperMarkerPath(logPath);
    try {
      const result = await launchWindowsUpdateHelper({
        helperScript: "C:\\staged\\deploy\\windows\\apply-self-update.ps1",
        sourceDir: "C:\\staged\\playon-node",
        targetDir: "C:\\playon-node",
        agentPid: 272,
        version: "0.2.21",
        preserve: ["data", "node.env.cmd"],
        logPath,
        settleMs: 0,
        timeoutMs: 1_000,
        pollMs: 20,
        runFile: async () => {
          fs.writeFileSync(markerPath, "pid=9\r\n");
          return { code: 0, stdout: "PLAYON_UPDATE_TASK_STARTED\n", stderr: "" };
        },
        runSchtasks: async () => {
          throw new Error("schtasks should not run");
        },
      });
      expect(result.method).toBe("scheduled-task");
      expect(result.markerPath).toBe(markerPath);
      const launcher = fs.readFileSync(result.launcherPath);
      expect(launcher.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
      const text = launcher.subarray(3).toString("utf8");
      expect(text).toContain("-Detached");
      expect(text).toContain("-ApplyLog");
      expect(text).toContain("2>&1");
      expect(text).toContain("apply-self-update.ps1");
      const register = fs.readFileSync(path.join(dir, "ota-apply-job-register.ps1"), "utf8");
      expect(register).toContain("Schedule.Service");
      expect(fs.readFileSync(logPath, "utf8")).toMatch(/helper armed via scheduled-task/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not exit when no method arms, and it removes the one-shot task", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playon-launch-fail-"));
    const logPath = path.join(dir, "ota-apply-job.log");
    const markerPath = windowsHelperMarkerPath(logPath);
    fs.writeFileSync(markerPath, "stale\n");
    const schtasks: string[] = [];
    const stopped: number[] = [];
    try {
      await expect(
        launchWindowsUpdateHelper({
          helperScript: "C:\\staged\\deploy\\windows\\apply-self-update.ps1",
          sourceDir: "C:\\staged\\playon-node",
          targetDir: "C:\\playon-node",
          agentPid: 272,
          version: "0.2.21",
          preserve: ["data"],
          logPath,
          settleMs: 0,
          timeoutMs: 40,
          pollMs: 10,
          runFile: async (script) => {
            if (script.endsWith("-wmi.ps1")) {
              return { code: 0, stdout: "PLAYON_WMI_PID=77\n", stderr: "" };
            }
            return failed("COM access denied");
          },
          runSchtasks: async (args) => {
            schtasks.push(args.join(" "));
            return failed("The user is not logged on");
          },
          stopProcess: async (pid) => {
            stopped.push(pid);
          },
        }),
      ).rejects.toThrow(/update_helper_not_started:[\s\S]*Staying on the current version/);
      expect(schtasks.some((line) => line.includes("/Delete") && line.includes(WINDOWS_APPLY_UPDATE_TASK_NAME))).toBe(
        true,
      );
      expect(stopped).toEqual([77]);
      expect(fs.readFileSync(logPath, "utf8")).toMatch(/SELF-UPDATE HELPER DID NOT START/);
      expect(fs.readFileSync(logPath, "utf8")).toMatch(/staying on the current version; not exiting/);
      expect(fs.existsSync(markerPath)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
