import {
  evaluateJoinReady,
  isLocalNodeId,
  joinHostNotReachableResult,
  probeJoinPath,
  type JoinPathPortState,
  type JoinPathProbeResult,
  type JoinReadyReport,
} from "@playon/shared";
import type { AppConfig } from "../config.js";
import { readSkillMarker } from "./skill-marker.js";
import { loadSkillMetadata } from "./skills.js";
import type { NetToolsService } from "./net-tools.js";
import {
  checkServerLoopbackTcp,
  type LoopbackTcpProbe,
} from "./node-loopback-tcp.js";
import type { ServerQueryService } from "./server-query.js";
import type { ServerRecord, ServerService } from "./servers.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emptyJoinPath(joinHost: string, port: number, reason: string): JoinPathProbeResult {
  return {
    ok: false,
    reason,
    joinHost,
    port,
    loopbackState: "closed",
    joinHostState: "closed",
  };
}

export type JoinReadyLoopbackFn = (
  nodeId: string,
  port: number,
) => Promise<LoopbackTcpProbe>;

/**
 * Advertised-join ready gate. Process-up / loopback is not enough — Home must
 * prove the panel join host:port (or a query against that address).
 * The #843 loopback leg for a remote node runs on that node, never Home.
 */
export class JoinReadyService {
  private readonly cache = new Map<string, { at: number; report: JoinReadyReport }>();
  private readonly loopbackOnNode: JoinReadyLoopbackFn;

  constructor(
    private readonly dbServers: ServerService,
    private readonly net: NetToolsService,
    private readonly config: AppConfig,
    private readonly queries?: ServerQueryService,
    loopbackOnNode?: JoinReadyLoopbackFn,
  ) {
    this.loopbackOnNode =
      loopbackOnNode ??
      ((nodeId, port) => checkServerLoopbackTcp(nodeId, port, (host, p) => this.checkTcp(host, p)));
  }

  cached(serverId: string, maxAgeMs = 60_000): JoinReadyReport | null {
    const hit = this.cache.get(serverId);
    if (!hit) return null;
    if (Date.now() - hit.at > maxAgeMs) return null;
    return hit.report;
  }

  remember(serverId: string, report: JoinReadyReport): JoinReadyReport {
    this.cache.set(serverId, { at: Date.now(), report });
    return report;
  }

  clear(serverId: string): void {
    this.cache.delete(serverId);
  }

  async probe(serverId: string): Promise<JoinReadyReport> {
    const server = await this.dbServers.get(serverId);
    if (!server) {
      const report = evaluateJoinReady({
        processStatus: "stopped",
        joinPath: emptyJoinPath("", 0, "unknown_server"),
        protocol: "tcp",
      });
      return this.remember(serverId, { ...report, reason: "unknown_server" });
    }
    const report = await this.probeServer(server);
    return this.remember(serverId, report);
  }

  /** Retry while the game process is still binding the advertised port. */
  async probeWithRetry(
    serverId: string,
    opts: { attempts?: number; delayMs?: number } = {},
  ): Promise<JoinReadyReport> {
    const attempts = Math.max(1, opts.attempts ?? 5);
    const delayMs = Math.max(0, opts.delayMs ?? 1200);
    let last = await this.probe(serverId);
    for (let i = 1; i < attempts && !last.ready; i++) {
      if (delayMs) await sleep(delayMs);
      last = await this.probe(serverId);
    }
    return last;
  }

  private async probeServer(server: ServerRecord): Promise<JoinReadyReport> {
    const skillName = readSkillMarker(server.dataPath)?.skillName ?? "";
    const meta = skillName ? loadSkillMetadata(this.config.skillsRoots, skillName)?.metadata : null;
    const protocol = this.dbServers.gamePortProtocolForSkill(skillName);
    const join = await this.dbServers.joinInfoFor(server);
    const wantsQuery = Boolean(meta?.queryDialect && meta.queryDialect !== "none");

    if (server.status !== "running" && server.status !== "starting") {
      return evaluateJoinReady({
        processStatus: server.status,
        joinPath: emptyJoinPath(join.address, join.port, "process_not_running"),
        protocol,
      });
    }

    let joinPath: JoinPathProbeResult;
    if (protocol === "tcp" && join.port > 0) {
      const nodeId = server.nodeId;
      const remote = !isLocalNodeId(nodeId);
      joinPath = await probeJoinPath({
        joinHost: join.address,
        port: join.port,
        check: async (host, port) => this.checkTcp(host, port),
        checkLoopback:
          remote && nodeId
            ? async (_host, port) => {
                const probe = await this.loopbackOnNode(nodeId, port);
                return probe.state;
              }
            : undefined,
        loopbackScope: remote ? "node" : "home",
      });
    } else if (protocol === "udp") {
      joinPath = emptyJoinPath(join.address, join.port, "udp_not_tcp_probed");
    } else {
      joinPath = emptyJoinPath(join.address, join.port, "no_game_port");
    }

    let queryOnline: boolean | null = null;
    if (wantsQuery && this.queries) {
      const state = await this.queries.queryServer(server.id);
      queryOnline = state.online;
    }

    return evaluateJoinReady({
      processStatus: server.status,
      joinPath,
      queryOnline,
      protocol,
    });
  }

  private async checkTcp(host: string, port: number): Promise<JoinPathPortState> {
    const probe = await this.net.portCheck({ host, port });
    return probe.state;
  }
}

export { joinHostNotReachableResult };
