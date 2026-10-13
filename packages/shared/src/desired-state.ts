/**
 * Per-server desired run state across a control-plane restart (#1038).
 *
 * `desiredState` is only written by an explicit user start/stop (or equivalent
 * API/tool). Crash / reconcile / health must not flip it to stopped.
 *
 * Auto-start on Home boot is opt-out and must never blindly restart sacred
 * live hosts (NZL / Hub / Frontier / …) while #1016-class start bugs are open.
 */

import { isProtectedLiveServerName } from "./lab-jail-gc.js";

export type DesiredState = "running" | "stopped";

export type DesiredStateRestoreAction = "adopt" | "start" | "skip";

export const NEVER_AUTO_START_MARKER_REL = ".playon/never-auto-start";

export function parseDesiredState(raw: unknown): DesiredState {
  return raw === "running" ? "running" : "stopped";
}

/** Comma/whitespace-separated server ids or names (`PLAYON_NEVER_AUTO_START`). */
export function parseNeverAutoStartList(raw?: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isListedNeverAutoStart(
  server: { id: string; name?: string | null },
  list: readonly string[],
): boolean {
  if (!list.length) return false;
  const id = server.id.trim().toLowerCase();
  const name = (server.name ?? "").trim().toLowerCase();
  return list.some((entry) => {
    const key = entry.trim().toLowerCase();
    return key === id || (name.length > 0 && key === name);
  });
}

/**
 * Sacred / opted-out servers may be re-adopted if still alive, but must not
 * be started by Home on its own.
 */
export function isProtectedFromAutoStart(input: {
  id: string;
  name?: string | null;
  game?: string | null;
  autoStart?: boolean | null;
  neverAutoStartList?: readonly string[];
  neverAutoStartMarker?: boolean | null;
}): boolean {
  if (input.autoStart === false) return true;
  if (input.neverAutoStartMarker === true) return true;
  if (isProtectedLiveServerName(input.name) || isProtectedLiveServerName(input.game)) {
    return true;
  }
  return isListedNeverAutoStart(
    { id: input.id, name: input.name },
    input.neverAutoStartList ?? [],
  );
}

export function decideDesiredStateRestore(input: {
  desiredState: DesiredState | string;
  processAlive: boolean;
  autoStart?: boolean | null;
  protectedFromAutoStart?: boolean;
}): { action: DesiredStateRestoreAction; reason: string } {
  if (input.processAlive) {
    return { action: "adopt", reason: "process_alive" };
  }
  if (parseDesiredState(input.desiredState) !== "running") {
    return { action: "skip", reason: "desired_stopped" };
  }
  if (input.autoStart === false) {
    return { action: "skip", reason: "auto_start_opt_out" };
  }
  if (input.protectedFromAutoStart) {
    return { action: "skip", reason: "protected_from_auto_start" };
  }
  return { action: "start", reason: "desired_running" };
}
