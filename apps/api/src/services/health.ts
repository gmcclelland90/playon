import {
  isLoopbackJoinHost,
  type HealthCheck,
  type JoinReadyReport,
  type SkillMetadata,
} from "@playon/shared";
import type { JoinReadyService } from "./join-ready.js";
import type { NetToolsService } from "./net-tools.js";
import { checkServerLoopbackTcp } from "./node-loopback-tcp.js";
import type { ServerQueryService } from "./server-query.js";
import type { ServerRecord, ServerService } from "./servers.js";
import { readSkillMarker } from "./skill-marker.js";
import { loadSkillMetadata } from "./skills.js";
import type { AppConfig } from "../config.js";

export type HealthCheckResult = {
  id: string;
  ok: boolean;
  detail: string;
  onFail: HealthCheck["onFail"];
  remediated?: "restart" | "none" | "escalate";
};

export type ServerHealthReport = {
  serverId: string;
  status: string;
  ok: boolean;
  ready: boolean;
  joinPath?: JoinReadyReport["joinPath"];
  checks: HealthCheckResult[];
  escalations: string[];
};

function readSkillName(dataPath: string): string {
  return readSkillMarker(dataPath)?.skillName ?? "";
}

export class HealthService {
  constructor(
    private readonly dbServers: ServerService,
    private readonly net: NetToolsService,
    private readonly config: AppConfig,
    private readonly queries?: ServerQueryService,
    private readonly joinReady?: JoinReadyService,
  ) {}

  private resolveChecks(server: ServerRecord): { meta: SkillMetadata | null; checks: HealthCheck[] } {
    const skillName = readSkillName(server.dataPath);
    const entry = skillName ? loadSkillMetadata(this.config.skillsRoots, skillName) : null;
    const meta = entry?.metadata ?? null;
    const declared = meta?.healthChecks ?? [];
    if (declared.length) return { meta, checks: declared };

    // Default: process/container running + TCP game port when the skill declares one.
    // UDP-only / unknown-port skills must not invent Minecraft :25565.
    const defaults: HealthCheck[] = [
      { id: "process", type: "process_running", onFail: "restart" },
    ];
    const port = this.dbServers.tcpGamePortForSkill(skillName);
    if (port > 0) {
      defaults.push({
        id: "game-port",
        type: "tcp_port",
        port,
        onFail: "restart",
      });
    }
    return { meta, checks: defaults };
  }

  async checkServer(
    serverId: string,
    opts: { remediate?: boolean } = {},
  ): Promise<ServerHealthReport> {
    const server = await this.dbServers.get(serverId);
    if (!server) throw new Error(`unknown_server: ${serverId}`);

    const { checks } = this.resolveChecks(server);
    const joinHost = await this.dbServers.resolveJoinAddress(server);
    const results: HealthCheckResult[] = [];
    const escalations: string[] = [];
    let needsRestart = false;

    for (const check of checks) {
      if (check.type === "process_running") {
        const ok = server.status === "running" || server.status === "starting";
        results.push({
          id: check.id,
          ok,
          detail: ok ? `server status is ${server.status}` : `server status is ${server.status}`,
          onFail: check.onFail,
        });
        if (!ok && check.onFail === "restart") needsRestart = true;
        if (!ok && check.onFail === "escalate") escalations.push(check.id);
        continue;
      }

      if (check.type === "tcp_port") {
        const skillName = readSkillName(server.dataPath);
        const port =
          check.port ??
          (check.portName
            ? this.dbServers.tcpGamePortForSkill(skillName)
            : this.dbServers.tcpGamePortForSkill(skillName));
        const host = check.host ?? joinHost;
        if (!port) {
          results.push({
            id: check.id,
            ok: false,
            detail: "no port configured for tcp_port check",
            onFail: check.onFail,
          });
          if (check.onFail === "escalate") escalations.push(check.id);
          continue;
        }
        const probe = await this.net.portCheck({ host, port });
        const ok = probe.state === "open";
        results.push({
          id: check.id,
          ok,
          detail: ok ? `${host}:${port} open` : `${host}:${port} closed`,
          onFail: check.onFail,
        });
        if (!ok && check.onFail === "restart") {
          // Advertised-closed + node loopback-open is a publish/path gap, not a dead process.
          // Never use Home 127.0.0.1 for a remote node (soak Paper on the API host).
          if (isLoopbackJoinHost(host)) {
            needsRestart = true;
          } else {
            const loopback = await checkServerLoopbackTcp(server.nodeId, port, async (h, p) => {
              const home = await this.net.portCheck({ host: h, port: p });
              return home.state;
            });
            if (loopback.state === "open") {
              /* do not restart — join-path gate reports degraded instead */
            } else if (loopback.unavailable) {
              /* cannot confirm node loopback — do not thrash a live process */
            } else {
              needsRestart = true;
            }
          }
        }
        if (!ok && check.onFail === "escalate") escalations.push(check.id);
        continue;
      }

      if (check.type === "query_responding") {
        if (!this.queries) {
          results.push({
            id: check.id,
            ok: false,
            detail: "query service unavailable",
            onFail: check.onFail,
          });
          if (check.onFail === "escalate") escalations.push(check.id);
          continue;
        }
        const probe = await this.queries.isQueryResponding(server);
        results.push({
          id: check.id,
          ok: probe.ok,
          detail: probe.detail,
          onFail: check.onFail,
        });
        if (!probe.ok && check.onFail === "restart") needsRestart = true;
        if (!probe.ok && check.onFail === "escalate") escalations.push(check.id);
      }
    }

    const hostPorts = await this.dbServers.evaluateHostPortsHealth(server);
    results.push({
      id: "host-ports",
      ok: hostPorts.ok,
      detail: hostPorts.detail,
      onFail: "restart",
    });
    if (!hostPorts.ok) needsRestart = true;

    if (opts.remediate && needsRestart && escalations.length === 0) {
      try {
        await this.dbServers.restart(serverId);
        for (const r of results) {
          if (!r.ok && r.onFail === "restart") r.remediated = "restart";
        }
      } catch (err) {
        escalations.push(`restart_failed:${err instanceof Error ? err.message : "error"}`);
      }
    } else if (needsRestart && !opts.remediate) {
      for (const r of results) {
        if (!r.ok && r.onFail === "restart") r.remediated = "none";
      }
    }

    let joinReport: JoinReadyReport | undefined;
    if (this.joinReady) {
      joinReport = await this.joinReady.probe(serverId);
      results.push({
        id: "join-path",
        ok: joinReport.ready,
        detail: joinReport.ready
          ? `advertised ${joinReport.joinPath.joinHost}:${joinReport.joinPath.port} reachable (${joinReport.reason})`
          : `advertised ${joinReport.joinPath.joinHost}:${joinReport.joinPath.port} not reachable (${joinReport.reason})`,
        onFail: "none",
      });
    }

    const refreshed = (await this.dbServers.get(serverId)) ?? server;
    const ok = results.every((r) => r.ok) && escalations.length === 0;
    return {
      serverId,
      status: refreshed.status,
      ok,
      ready: joinReport?.ready ?? false,
      joinPath: joinReport?.joinPath,
      checks: results,
      escalations,
    };
  }
}
