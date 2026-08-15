/**
 * Agent-shaped parent: start a keepStdin child via NativeProcessSupervisor,
 * then exit (or wait to be SIGTERM'd) like systemd MAINPID after OTA.
 * The child must stay up and must not see stdin EOF (#886 / PZ shutdown).
 */
import fs from "node:fs";
import { NativeProcessSupervisor } from "./native-process.js";

const jail = process.env.PLAYON_HELPER_JAIL;
const status = process.env.PLAYON_HELPER_STATUS;
const pidFile = process.env.PLAYON_HELPER_PID;
const holderFile = process.env.PLAYON_HELPER_HOLDER_PID;
const mode = process.env.PLAYON_HELPER_MODE ?? "exit";
if (!jail || !status || !pidFile) {
  process.stderr.write("native-parent-exit.helper: missing PLAYON_HELPER_* env\n");
  process.exit(2);
}

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
        try { fs.writeFileSync(status, eof ? "eof" : "alive"); } catch { /* ignore */ }
      }, 80);
    `,
  ],
  cwd: ".",
  keepStdin: true,
  env: { STATUS: status },
});
if (!info.pid) {
  process.stderr.write("native-parent-exit.helper: child has no pid\n");
  process.exit(3);
}
fs.writeFileSync(pidFile, String(info.pid));
const holderPid = supervisor.stdinHolderPid("keep-stdin", ".");
if (holderFile && holderPid) fs.writeFileSync(holderFile, String(holderPid));

if (mode === "wait") {
  setInterval(() => undefined, 60_000);
} else {
  setTimeout(() => process.exit(0), 120);
}
