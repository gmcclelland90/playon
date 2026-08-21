/**
 * Supervised-agent stand-in for #886:
 *  - first generation starts a keepStdin child, then exits 75 (relaunch)
 *  - later generations just stay up
 *  - `exit-mainpid` starts the child then calls relaunchUpdatedAgent
 */
import fs from "node:fs";
import { NativeProcessSupervisor } from "../../../packages/runtime/src/native-process.js";
import {
  AGENT_RELAUNCH_EXIT_CODE,
  readSystemdKillMode,
  relaunchUpdatedAgent,
  shouldExitSystemdMainPid,
} from "./self-update.js";

const jail = process.env.PLAYON_HELPER_JAIL;
const status = process.env.PLAYON_HELPER_STATUS;
const pidFile = process.env.PLAYON_HELPER_PID;
const stamp = process.env.PLAYON_HELPER_STAMP;
const mode = process.env.PLAYON_HELPER_MODE ?? "supervised";
const installRoot = process.env.PLAYON_HELPER_INSTALL_ROOT ?? process.cwd();

if (!jail || !status || !pidFile || !stamp) {
  process.stderr.write("relaunch-keep-stdin.helper: missing PLAYON_HELPER_* env\n");
  process.exit(2);
}

const n = Number(fs.readFileSync(stamp, "utf8") || "0");
fs.writeFileSync(stamp, String(n + 1));

if (n === 0) {
  const supervisor = new NativeProcessSupervisor(jail);
  const info = await supervisor.start({
    name: "keep-stdin",
    command: process.execPath,
    args: [
      "-e",
      `
        const fs = require("node:fs");
        let eof = false;
        process.stdin.on("end", () => { eof = true; });
        process.stdin.on("data", () => undefined);
        process.stdin.resume();
        const status = process.env.STATUS;
        setInterval(() => {
          try {
            const tmp = status + ".tmp";
            fs.writeFileSync(tmp, eof ? "eof" : "alive");
            fs.renameSync(tmp, status);
          } catch { /* ignore */ }
        }, 80);
      `,
    ],
    cwd: ".",
    keepStdin: true,
    env: { STATUS: status },
  });
  if (!info.pid) {
    process.stderr.write("relaunch-keep-stdin.helper: child has no pid\n");
    process.exit(3);
  }
  fs.writeFileSync(pidFile, String(info.pid));
  if (mode === "exit-mainpid") {
    const hasPipeStdin = supervisor.hasPipeStdinChildren();
    relaunchUpdatedAgent({ installRoot, hasPipeStdin });
    // FIFO write ends / tsx loaders can hold the event loop so the 200ms
    // scheduled exit never runs. Only force-exit when KillMode=process
    // made relaunch schedule MAINPID death (#909).
    if (
      shouldExitSystemdMainPid({
        killMode: readSystemdKillMode(),
        hasPipeStdin,
      })
    ) {
      setImmediate(() => process.exit(0));
    }
  } else {
    setTimeout(() => process.exit(AGENT_RELAUNCH_EXIT_CODE), 120);
  }
} else {
  fs.writeFileSync(process.env.PLAYON_HELPER_READY ?? status, "ready");
  setInterval(() => undefined, 60_000);
}
