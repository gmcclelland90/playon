/**
 * Process/container liveness vs advertised game-port binds.
 *
 * A live PID or container is not "up". Same spirit as the join-path ready-gate
 * (#877): do not treat an instance as healthy unless the host still holds the
 * advertised game port. Join-path (Home → advertised host) stays a separate
 * publish/path check — this module only answers host-local bind evidence.
 *
 * `hostPortsBound`:
 * - true  — advertised game port is bound on the host
 * - false — probed and not bound
 * - null  — no declared port, or the probe could not run (do not invent)
 */

export type HostPortsBound = boolean | null;

export type StartInstanceDecision = "reuse" | "reap_then_start" | "start";

export type ReconcileInstanceDecision = "running" | "stopped" | "dead" | "keep";

export const DEFAULT_PORT_DEAD_GRACE_MS = 15 * 60 * 1000;

/** Start: never stack a second instance; reap leftovers; reuse a healthy one. */
export function decideStartInstance(input: {
  processAlive: boolean;
  hostPortsBound: HostPortsBound;
}): StartInstanceDecision {
  if (input.processAlive && input.hostPortsBound === true) return "reuse";
  if (input.processAlive) return "reap_then_start";
  return "start";
}

/**
 * Reconcile DB status with the runtime + host bind.
 *
 * Alive + ports dropped after grace (or after we already claimed `running`)
 * is dead: callers must reap and mark not-running. `starting` + unbound is
 * still binding. Unknown ports (`null`) keep the process-only mapping.
 */
export function decideReconcileInstance(input: {
  processAlive: boolean;
  hostPortsBound: HostPortsBound;
  dbStatus: string;
  /** Elapsed since this Home observed the instance as started / first seen. */
  startedAgoMs?: number;
  graceMs?: number;
}): ReconcileInstanceDecision {
  const graceMs = input.graceMs ?? DEFAULT_PORT_DEAD_GRACE_MS;
  const startedAgoMs = input.startedAgoMs ?? 0;

  if (!input.processAlive) {
    if (
      input.dbStatus === "running" ||
      input.dbStatus === "starting" ||
      input.dbStatus === "error"
    ) {
      return "stopped";
    }
    return "keep";
  }

  if (input.hostPortsBound === true) return "running";

  if (input.hostPortsBound === false) {
    if (input.dbStatus === "starting") return "keep";
    if (input.dbStatus === "running" && startedAgoMs >= graceMs) return "dead";
    if (input.dbStatus === "running") return "keep";
    return "keep";
  }

  // Probe unavailable: follow the process, same as before this gate existed.
  if (input.dbStatus === "running" || input.dbStatus === "starting") return "running";
  return "running";
}
