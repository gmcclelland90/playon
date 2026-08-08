/**
 * Apply fleet lancache config from heartbeat responses (hosts pin + reachability).
 */
import {
  applyLancacheHostsPin,
  defaultHostsPath,
  probeLancacheTcp,
  type LancachePinStatus,
} from "@playon/runtime";

export type LancacheAgentConfig = {
  enabled: boolean;
  cacheIp?: string;
  pinSteamcmd: boolean;
};

let lastReachable = false;
let lastPin: LancachePinStatus = "skipped";
let lastConfig: LancacheAgentConfig | null = null;

export function getLancacheAdvertisement(): {
  lancache: boolean;
  lancachePin: LancachePinStatus;
} {
  return { lancache: lastReachable, lancachePin: lastPin };
}

export function resetLancacheClientForTests(): void {
  lastReachable = false;
  lastPin = "skipped";
  lastConfig = null;
}

/**
 * Apply pin + probe after a successful heartbeat. Safe to call on every beat.
 */
export async function applyLancacheHeartbeatConfig(
  config: LancacheAgentConfig | undefined,
  opts?: { hostsPath?: string },
): Promise<void> {
  if (!config) {
    lastConfig = null;
    return;
  }
  lastConfig = config;

  const cacheIp = config.cacheIp?.trim();
  const shouldPin = Boolean(config.enabled && config.pinSteamcmd && cacheIp);
  const result = applyLancacheHostsPin({
    hostsPath: opts?.hostsPath ?? defaultHostsPath(),
    cacheIp: shouldPin ? cacheIp! : null,
  });

  if (result.status === "needs_elevation" || result.status === "error") {
    lastPin = result.status;
  } else if (shouldPin) {
    lastPin = "applied";
  } else if (config.enabled && !config.pinSteamcmd) {
    lastPin = "skipped";
  } else {
    lastPin = "removed";
  }

  if (config.enabled && cacheIp) {
    lastReachable = await probeLancacheTcp(cacheIp, 80, 800);
  } else {
    lastReachable = false;
  }
}

export function getLastLancacheConfig(): LancacheAgentConfig | null {
  return lastConfig;
}
