import type { HealthCheck, SkillMetadata } from "@playon/shared";
import type { NetToolsService } from "./net-tools.js";
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
  ) {}

  private resolveChecks(server: ServerRecord): { meta: SkillMetadata | null; checks: HealthCheck[] } {
    const skillName = readSkillName(server.dataPath);
    const entry = skillName ? loadSkillMetadata(this.config.skillsRoots, skillName) : null;
    const meta = entry?.metadata ?? null;
    const declared = meta?.healthChecks ?? [];
    if (declared.length) return { meta, checks: declared };

    // Default: process/container running + primary game port when known
    const defaults: HealthCheck[] = [
      { id: "process", type: "process_running", onFail: "restart" },
    ];
    const port = this.dbServers.gamePortForSkill(skillName);
    if (port) {
      defaults.push({
        id: "game-port",
        type: "tcp_port",
        port,
        host: this.config.advertiseHost,
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
    const results: HealthCheckResult[] = [];
    const escalations: string[] = [];
    let needsRestart = false;

    for (const check of checks) {
      if (check.type === "process_running") {
        const ok = server.status === "running";
        results.push({
          id: check.id,
          ok,
          detail: ok ? "server status is running" : `server status is ${server.status}`,
          onFail: check.onFail,
        });
        if (!ok && check.onFail === "restart") needsRestart = true;
        if (!ok && check.onFail === "escalate") escalations.push(check.id);
        continue;
      }

      if (check.type === "tcp_port") {
        const port =
          check.port ??
          (check.portName
            ? this.dbServers.gamePortForSkill(readSkillName(server.dataPath))
            : this.dbServers.gamePortForSkill(readSkillName(server.dataPath)));
        const host = check.host ?? this.config.advertiseHost ?? "127.0.0.1";
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
        if (!ok && check.onFail === "restart") needsRestart = true;
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

    const refreshed = (await this.dbServers.get(serverId)) ?? server;
    const ok = results.every((r) => r.ok) && escalations.length === 0;
    return {
      serverId,
      status: refreshed.status,
      ok,
      checks: results,
      escalations,
    };
  }
}
