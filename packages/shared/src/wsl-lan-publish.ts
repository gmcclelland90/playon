import { isLoopbackJoinHost } from "./join-path-probe.js";
import type { WslNetworkingMode } from "./nodes.js";
import type { SkillMetadata } from "./skill.js";

export type WslLanPublishVerdict = {
  ok: boolean;
  reason: string;
  joinHost: string;
};

/**
 * Whether a WSL sibling can offer a LAN-joinable advertised address.
 *
 * Parent must have a non-loopback join host. NAT/unknown needs the Windows
 * agent to advertise `net_port_publish` (userspace proxy onto that IP).
 * Mirrored mode already exposes WSL `-p 0.0.0.0` on the parent NIC.
 */
export function evaluateWslLanPublish(input: {
  parentJoinHost?: string | null;
  advertiseHost?: string | null;
  parentAdvertisesPublish: boolean;
  networkingMode?: WslNetworkingMode;
}): WslLanPublishVerdict {
  const joinHost = (input.parentJoinHost?.trim() || input.advertiseHost?.trim() || "").trim();
  if (!joinHost || isLoopbackJoinHost(joinHost)) {
    return { ok: false, reason: "wsl_parent_join_host_unusable", joinHost };
  }
  if (input.networkingMode === "mirrored") {
    return { ok: true, reason: "wsl_lan_mirrored", joinHost };
  }
  if (input.parentAdvertisesPublish) {
    return { ok: true, reason: "wsl_lan_publishable", joinHost };
  }
  return { ok: false, reason: "wsl_lan_publish_unavailable", joinHost };
}

export function skillHasLanJoinPort(skill: Pick<SkillMetadata, "ports">): boolean {
  return skill.ports.some((p) => p.default != null && p.default > 0);
}

/** Game / RCON / query ports to publish on the Windows parent LAN IP. */
export function lanPublishPortsForSkill(
  skill: Pick<SkillMetadata, "ports"> | null | undefined,
  extraTcpPorts: number[] = [],
): Array<{ port: number; protocol: "tcp" | "udp" }> {
  const out: Array<{ port: number; protocol: "tcp" | "udp" }> = [];
  const seen = new Set<string>();
  const add = (port: number, protocol: "tcp" | "udp") => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) return;
    const key = `${protocol}:${port}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ port, protocol });
  };
  for (const p of skill?.ports ?? []) {
    if (p.default) add(p.default, p.protocol === "udp" ? "udp" : "tcp");
  }
  for (const port of extraTcpPorts) add(port, "tcp");
  return out;
}
