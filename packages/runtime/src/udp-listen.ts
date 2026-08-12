import { execFileSync } from "node:child_process";
import {
  udpPortListedInOutput,
  type NetUdpListenResult,
  type UdpListenProbe,
} from "@playon/shared";

function runListenTable(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
  } catch {
    return null;
  }
}

/**
 * Read-only UDP bind check. Linux uses `ss` (same as lab-matrix); Windows uses
 * `netstat`. Never binds the port — a failed bind race would steal it from the game.
 */
export function probeUdpListen(port: number): NetUdpListenResult {
  if (process.platform === "win32") {
    const netstat = runListenTable("netstat", ["-an", "-p", "udp"]);
    if (netstat != null) {
      return { port, listening: udpPortListedInOutput(netstat, port), probe: "netstat" };
    }
    const ps = runListenTable("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Get-NetUDPEndpoint -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty LocalPort`,
    ]);
    if (ps != null) {
      const listening = ps.split(/\r?\n/).some((line) => line.trim() === String(port));
      return { port, listening, probe: "netstat" };
    }
    return { port, listening: false, probe: "unavailable" };
  }

  const ss = runListenTable("ss", ["-uln"]);
  if (ss != null) {
    return { port, listening: udpPortListedInOutput(ss, port), probe: "ss" };
  }
  const netstat = runListenTable("netstat", ["-uln"]);
  if (netstat != null) {
    return { port, listening: udpPortListedInOutput(netstat, port), probe: "netstat" };
  }
  return { port, listening: false, probe: "unavailable" satisfies UdpListenProbe };
}
