import fs from "node:fs";
import os from "node:os";

export function detectOs(): "linux" | "windows" {
  return process.platform === "win32" ? "windows" : "linux";
}

export function dockerAvailable(): boolean {
  // Presence of docker binary / socket is enough for capability reporting.
  // Actual adapter selection is controlled by PLAYON_RUNTIME.
  try {
    if (process.platform === "win32") {
      return fs.existsSync("\\\\.\\pipe\\docker_engine");
    }
    return fs.existsSync("/var/run/docker.sock");
  } catch {
    return false;
  }
}

export function freeDiskBytes(dataRoot: string): number | undefined {
  try {
    const stat = fs.statfsSync?.(dataRoot);
    if (stat) return Number(stat.bfree) * Number(stat.bsize);
  } catch {
    /* older node / unsupported */
  }
  void os;
  return undefined;
}
