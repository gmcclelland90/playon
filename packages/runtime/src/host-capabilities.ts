import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type HostOs = "linux" | "windows";

export interface HostCapabilities {
  os: HostOs;
  docker: boolean;
  native: boolean;
  steamcmd: boolean;
  freeDiskBytes?: number;
}

export function detectHostOs(): HostOs {
  return process.platform === "win32" ? "windows" : "linux";
}

/** True when a Docker Engine socket/pipe appears present. */
export function dockerSocketAvailable(): boolean {
  try {
    if (process.platform === "win32") {
      return fs.existsSync("\\\\.\\pipe\\docker_engine");
    }
    return fs.existsSync("/var/run/docker.sock");
  } catch {
    return false;
  }
}

function steamcmdCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const fromEnv = [
    env.PLAYON_STEAMCMD?.trim(),
    env.STEAMCMD?.trim(),
    env.STEAMCMD_PATH?.trim(),
  ].filter(Boolean) as string[];
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir();
  const extras =
    process.platform === "win32"
      ? [
          path.join(home, "SteamCMD", "steamcmd.exe"),
          path.join(home, "steamcmd", "steamcmd.exe"),
          "C:\\SteamCMD\\steamcmd.exe",
          "C:\\steamcmd\\steamcmd.exe",
        ]
      : [
          path.join(home, "steamcmd", "steamcmd.sh"),
          "/usr/games/steamcmd",
          "/usr/bin/steamcmd",
          "/opt/steamcmd/steamcmd.sh",
        ];
  return [...fromEnv, ...extras];
}

/** True when SteamCMD binary exists, or Linux auto-install is allowed. */
export function steamcmdAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  for (const candidate of steamcmdCandidates(env)) {
    if (candidate && fs.existsSync(candidate)) return true;
  }
  const auto = env.PLAYON_STEAMCMD_AUTO?.trim().toLowerCase();
  if (auto === "0" || auto === "false" || auto === "off" || auto === "no") return false;
  // Linux (and Windows once zip provision lands) can auto-provision.
  return true;
}

export function freeDiskBytes(dataRoot: string): number | undefined {
  try {
    const stat = fs.statfsSync?.(dataRoot);
    if (stat) return Number(stat.bfree) * Number(stat.bsize);
  } catch {
    /* unsupported */
  }
  return undefined;
}

/**
 * Probe host runtime capabilities for heartbeats / local node registration.
 * `native` is always true for host OS agents (process supervisor).
 */
export function probeHostCapabilities(
  dataRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): HostCapabilities {
  const free = freeDiskBytes(dataRoot);
  return {
    os: detectHostOs(),
    docker: dockerSocketAvailable(),
    native: true,
    steamcmd: steamcmdAvailable(env),
    ...(free != null ? { freeDiskBytes: free } : {}),
  };
}
