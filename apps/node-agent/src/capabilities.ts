import { probeHostCapabilities, type HostCapabilities } from "@playon/runtime";

export type { HostCapabilities };

export function detectOs(): "linux" | "windows" {
  return probeHostCapabilities(process.cwd()).os;
}

export function dockerAvailable(): boolean {
  return probeHostCapabilities(process.cwd()).docker;
}

export function freeDiskBytes(dataRoot: string): number | undefined {
  return probeHostCapabilities(dataRoot).freeDiskBytes;
}

export function probeCapabilities(dataRoot: string): HostCapabilities {
  return probeHostCapabilities(dataRoot);
}
