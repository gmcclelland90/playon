/** Port reachability as returned by net_port_check / TCP connect. */
export type JoinPathPortState = "open" | "closed";

export type JoinPathProbeInput = {
  joinHost: string;
  port: number;
  loopbackState: JoinPathPortState;
  joinHostState: JoinPathPortState;
  loopbackScope?: JoinPathLoopbackScope;
};

/** Where the loopback leg was probed. Remote servers must use `node`, never Home. */
export type JoinPathLoopbackScope = "node" | "home";

export type JoinPathProbeResult = {
  ok: boolean;
  /** Stable reason for logs / canary output. */
  reason: string;
  joinHost: string;
  port: number;
  loopbackState: JoinPathPortState;
  joinHostState: JoinPathPortState;
  /** Absent on older canary fixtures; ready-gate sets this. */
  loopbackScope?: JoinPathLoopbackScope;
};

/** Fixture used by the join-path canary (Linux Docker + WSL sibling stand-in). */
export const JOIN_PATH_CANARY_SKILL = "fixtures.lab-docker-server";

export function isLoopbackJoinHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
}

/**
 * Join-path canary verdict (#843).
 *
 * Catalog matrix `port_open` may still probe loopback. This check fails when
 * that loopback path is open but the published `joinHost:port` (from
 * `resolveJoinAddress` / `nodes.join_host`) is not.
 */
export function evaluateJoinPathProbe(input: JoinPathProbeInput): JoinPathProbeResult {
  const joinHost = input.joinHost.trim();
  const base = {
    joinHost,
    port: input.port,
    loopbackState: input.loopbackState,
    joinHostState: input.joinHostState,
    ...(input.loopbackScope ? { loopbackScope: input.loopbackScope } : {}),
  };

  if (!joinHost) {
    return { ok: false, reason: "join_host_empty", ...base };
  }

  if (isLoopbackJoinHost(joinHost)) {
    const ok = input.joinHostState === "open";
    return {
      ok,
      reason: ok ? "join_host_is_loopback" : "join_host_loopback_closed",
      ...base,
    };
  }

  if (input.loopbackState === "open" && input.joinHostState !== "open") {
    return { ok: false, reason: "loopback_open_join_host_closed", ...base };
  }

  if (input.joinHostState !== "open") {
    return { ok: false, reason: "join_host_closed", ...base };
  }

  return { ok: true, reason: "join_host_open", ...base };
}

export async function probeJoinPath(args: {
  joinHost: string;
  port: number;
  /** Advertised / LAN-client vantage (Home TCP). */
  check: (host: string, port: number) => Promise<JoinPathPortState>;
  /**
   * Loopback diagnostic vantage. For a remote node this must be that node's
   * localhost — never Home `127.0.0.1` (soak Paper on the API host).
   */
  checkLoopback?: (host: string, port: number) => Promise<JoinPathPortState>;
  loopbackHost?: string;
  loopbackScope?: JoinPathLoopbackScope;
}): Promise<JoinPathProbeResult> {
  const loopbackHost = args.loopbackHost?.trim() || "127.0.0.1";
  const joinHost = args.joinHost.trim();
  const sameHost =
    isLoopbackJoinHost(joinHost) || joinHost.toLowerCase() === loopbackHost.toLowerCase();
  // Advertised loopback is the player-facing Home path — do not substitute a node job.
  const loopbackCheck = sameHost ? args.check : (args.checkLoopback ?? args.check);
  const loopbackState = await loopbackCheck(loopbackHost, args.port);
  const joinHostState = sameHost ? loopbackState : await args.check(joinHost, args.port);
  const loopbackScope: JoinPathLoopbackScope | undefined = sameHost
    ? "home"
    : args.loopbackScope ?? (args.checkLoopback ? "node" : "home");
  return evaluateJoinPathProbe({
    joinHost,
    port: args.port,
    loopbackState,
    joinHostState,
    loopbackScope,
  });
}

/** User-facing status after the advertised join path has been evaluated. */
export type JoinReadyStatus = "running" | "starting" | "degraded" | "stopped" | "error";

export type JoinReadyInput = {
  /** Process/container lifecycle from the control plane (not join-path). */
  processStatus: string;
  joinPath: JoinPathProbeResult;
  /** Query against the advertised join host. null = not attempted. */
  queryOnline?: boolean | null;
  protocol: "tcp" | "udp";
};

export type JoinReadyReport = {
  ready: boolean;
  status: JoinReadyStatus;
  reason: string;
  joinPath: JoinPathProbeResult;
  queryOnline?: boolean | null;
  protocol: "tcp" | "udp";
};

const PROCESS_UP = new Set(["running", "starting"]);

function processStatusOf(raw: string): JoinReadyStatus {
  if (raw === "starting") return "starting";
  if (raw === "running") return "running";
  if (raw === "error" || raw === "failed") return "error";
  return "stopped";
}

/**
 * Ready-gate for “server is up / joinable”.
 *
 * Process-up, Paper “Done!”, or 127.0.0.1:port is not enough. Ready only when
 * the advertised join host:port is open (TCP) or a query against that address
 * succeeded. Loopback-open + advertised-closed stays not-ready (`degraded`).
 */
export function evaluateJoinReady(input: JoinReadyInput): JoinReadyReport {
  const queryOnline = input.queryOnline ?? null;
  const process = processStatusOf(input.processStatus);
  const base = {
    joinPath: input.joinPath,
    queryOnline,
    protocol: input.protocol,
  };

  if (!PROCESS_UP.has(input.processStatus)) {
    return { ready: false, status: process, reason: "process_not_running", ...base };
  }

  // Query on the advertised host is LAN-client proof for TCP or UDP.
  if (queryOnline === true) {
    return { ready: true, status: "running", reason: "query_online", ...base };
  }

  if (input.protocol === "tcp") {
    if (input.joinPath.ok) {
      return { ready: true, status: "running", reason: input.joinPath.reason, ...base };
    }
    const status: JoinReadyStatus = process === "starting" ? "starting" : "degraded";
    return { ready: false, status, reason: input.joinPath.reason, ...base };
  }

  // UDP: do not treat a TCP connect (or node listen table) as advertised proof.
  const reason = queryOnline === false ? "query_offline" : "udp_join_unproven";
  const status: JoinReadyStatus = process === "starting" ? "starting" : "degraded";
  return { ready: false, status, reason, ...base };
}

/** Panel / UI status string — never “running” unless ready. */
export function displayServerStatus(processStatus: string, ready?: boolean | null): string {
  if (processStatus === "running" && ready !== true) return "degraded";
  return processStatus;
}

export const JOIN_HOST_NOT_REACHABLE = "join_host_not_reachable";

export function joinHostNotReachableResult(report: JoinReadyReport): {
  error: typeof JOIN_HOST_NOT_REACHABLE;
  reason: string;
  joinHost: string;
  port: number;
  hint: string;
} {
  return {
    error: JOIN_HOST_NOT_REACHABLE,
    reason: report.reason,
    joinHost: report.joinPath.joinHost,
    port: report.joinPath.port,
    hint: "Not reachable on the advertised join address. Process-up or 127.0.0.1 is not enough.",
  };
}
