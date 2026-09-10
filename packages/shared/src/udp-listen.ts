/**
 * UDP listen evidence for lab-matrix `port_open` and the node `net_udp_listen` job.
 *
 * Linux matrix uses `ss -uln` on Home. Windows UDP is not visible that way, so
 * the node agent parses `netstat` (or `ss` on Linux nodes) and Home may accept
 * query-online as the other proof. `status=running` is never enough.
 */

export const UDP_LISTEN_PROBES = ["ss", "netstat", "unavailable"] as const;
export type UdpListenProbe = (typeof UDP_LISTEN_PROBES)[number];

/** True when a listen table line shows this UDP port as a local bind. */
export function udpPortListedInOutput(output: string, port: number): boolean {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  const re = new RegExp(`:${port}(\\s|$)`);
  return output.split(/\r?\n/).some((line) => re.test(line));
}

export type WindowsUdpPortOpenInput = {
  /** Home/node process status is running. */
  running: boolean;
  /**
   * Node-side listen check: true = required UDP port(s) bound, false = probed
   * and not bound, null = probe unavailable (old agent / missing ss|netstat).
   */
  listening: boolean | null;
  /**
   * Query dialect proof: true = online, false = tried and offline, null = no
   * dialect or not attempted yet.
   */
  queryOnline: boolean | null;
};

export type WindowsUdpPortOpenVerdict =
  | { ok: true; via: "listen" | "query" }
  | { ok: false; reason: "udp_process_not_running" | "udp_listen_unproven" };

/**
 * Windows / no-TCP `port_open` gate. Query-online OR a node listen check.
 * Does not apply to Linux — Linux still requires `ss` (see lab-matrix).
 */
export function windowsUdpPortOpenVerdict(
  input: WindowsUdpPortOpenInput,
): WindowsUdpPortOpenVerdict {
  if (!input.running) return { ok: false, reason: "udp_process_not_running" };
  if (input.listening === true) return { ok: true, via: "listen" };
  if (input.queryOnline === true) return { ok: true, via: "query" };
  return { ok: false, reason: "udp_listen_unproven" };
}

export type SkillUdpListenPort = {
  name: string;
  protocol?: string;
  default?: number;
};

export type SkillUdpListenMeta = {
  ports?: SkillUdpListenPort[];
  queryDialect?: string | null;
  queryPortName?: string;
};

/**
 * UDP ports the matrix must prove listening (Linux ss / Windows node job).
 * When a query dialect is declared, only the queryPortName bind is required —
 * Steam-networking game ports (Avorion) and Keen CU2+ Enshrouded often never
 * show a separate game socket in ss/netstat.
 */
export function udpListenTargets(meta: SkillUdpListenMeta): {
  udpGame: Array<{ name: string; protocol: string; default: number }>;
  listenTargets: Array<{ name: string; protocol: string; default: number }>;
} {
  const udpGame = (meta.ports ?? [])
    .filter(
      (p) =>
        p.protocol === "udp" &&
        typeof p.default === "number" &&
        /^(game|query)([-_]|$)/i.test(p.name),
    )
    .map((p) => ({ name: p.name, protocol: "udp", default: p.default! }));
  const queryName = typeof meta.queryPortName === "string" ? meta.queryPortName.trim() : "";
  const requireQueryOnly = !!queryName && !!meta.queryDialect && meta.queryDialect !== "none";
  const mustListen = requireQueryOnly ? udpGame.filter((p) => p.name === queryName) : udpGame;
  return { udpGame, listenTargets: mustListen.length ? mustListen : udpGame };
}

/** Collapse per-port probes into the tri-state `listening` field above. */
export function requiredUdpListenEvidence(
  probes: Array<{ required: boolean; listening: boolean | null }>,
): boolean | null {
  const required = probes.filter((p) => p.required);
  if (!required.length) return false;
  if (required.every((p) => p.listening === true)) return true;
  if (required.some((p) => p.listening === false)) return false;
  return null;
}
