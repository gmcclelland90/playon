/** Port reachability as returned by net_port_check / TCP connect. */
export type JoinPathPortState = "open" | "closed";

export type JoinPathProbeInput = {
  joinHost: string;
  port: number;
  loopbackState: JoinPathPortState;
  joinHostState: JoinPathPortState;
};

export type JoinPathProbeResult = {
  ok: boolean;
  /** Stable reason for logs / canary output. */
  reason: string;
  joinHost: string;
  port: number;
  loopbackState: JoinPathPortState;
  joinHostState: JoinPathPortState;
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
  check: (host: string, port: number) => Promise<JoinPathPortState>;
  loopbackHost?: string;
}): Promise<JoinPathProbeResult> {
  const loopbackHost = args.loopbackHost?.trim() || "127.0.0.1";
  const joinHost = args.joinHost.trim();
  const loopbackState = await args.check(loopbackHost, args.port);
  const sameHost =
    isLoopbackJoinHost(joinHost) || joinHost.toLowerCase() === loopbackHost.toLowerCase();
  const joinHostState = sameHost ? loopbackState : await args.check(joinHost, args.port);
  return evaluateJoinPathProbe({
    joinHost,
    port: args.port,
    loopbackState,
    joinHostState,
  });
}
