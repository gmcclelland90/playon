/**
 * Heartbeat-alive + claim-dead = dead.
 *
 * Windows Task Scheduler RestartCount only fires when the task process exits.
 * A wedged claim loop (hung OTA extract, stuck fetch) still heartbeats, so Home
 * shows online while jobs sit queued. Exit and let the existing supervisor
 * (PlayOnNodeAgent RestartCount, or systemd Restart=always) replace us.
 */

export const DEFAULT_CLAIM_WATCHDOG_IDLE_MS = 5 * 60 * 1000;
export const CLAIM_WATCHDOG_ENV = "PLAYON_CLAIM_WATCHDOG_MS";
/** Distinct from a crash so logs can say "watchdog asked us to die". */
export const CLAIM_WATCHDOG_EXIT_CODE = 1;

export function claimWatchdogIdleMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[CLAIM_WATCHDOG_ENV]?.trim();
  if (!raw) return DEFAULT_CLAIM_WATCHDOG_IDLE_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CLAIM_WATCHDOG_IDLE_MS;
}

export type ClaimLoopWatchdog = {
  markClaimPoll: () => void;
  markJobStarted: (kind: string) => void;
  markJobProgress: () => void;
  markJobFinished: () => void;
  check: () => boolean;
  lastHealthyAt: () => number;
  currentJobKind: () => string | null;
};

export function createClaimLoopWatchdog(opts?: {
  idleMs?: number;
  now?: () => number;
  exit?: (code: number) => void;
  log?: (message: string) => void;
}): ClaimLoopWatchdog {
  const idleMs = opts?.idleMs ?? DEFAULT_CLAIM_WATCHDOG_IDLE_MS;
  const now = opts?.now ?? Date.now;
  const exit = opts?.exit ?? ((code: number) => process.exit(code));
  const log = opts?.log ?? ((message: string) => console.error(message));
  let lastHealthy = now();
  let jobKind: string | null = null;
  let exited = false;

  const touch = () => {
    lastHealthy = now();
  };

  return {
    markClaimPoll: touch,
    markJobStarted: (kind: string) => {
      jobKind = kind;
      touch();
    },
    markJobProgress: touch,
    markJobFinished: () => {
      jobKind = null;
      touch();
    },
    lastHealthyAt: () => lastHealthy,
    currentJobKind: () => jobKind,
    check: () => {
      const idle = now() - lastHealthy;
      if (idle < idleMs || exited) return false;
      exited = true;
      const detail = jobKind
        ? `job ${jobKind} made no progress for ${Math.round(idle / 1000)}s`
        : `claim loop idle for ${Math.round(idle / 1000)}s`;
      log(`[node-agent] claim watchdog: ${detail}; exiting so supervisor restarts`);
      exit(CLAIM_WATCHDOG_EXIT_CODE);
      return true;
    },
  };
}
