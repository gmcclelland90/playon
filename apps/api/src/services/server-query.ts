import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_QUERY_CONNECTOR,
  defaultRegistry,
  primaryPortForDialect,
  type QueryTarget,
} from "@playon/server-query";
import type { LiveServerState, QueryDialect, SkillMetadata } from "@playon/shared";
import { offlineState, resolveQueryDialect } from "@playon/shared";
import type { AppConfig } from "../config.js";
import { readSkillMarker } from "./skill-marker.js";
import { loadSkillMetadata, skillsRootsForWorkspace } from "./skills.js";
import type { ServerRecord, ServerService } from "./servers.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type QueryTestArgs = {
  host: string;
  port: number;
  queryPort?: number;
  gamePort?: number;
  timeoutMs?: number;
  skillName?: string;
  /** Absolute or skill-relative path; used with skillName or alone when absolute. */
  connectorPath?: string;
  queryDialect?: QueryDialect;
};

export class ServerQueryService {
  private readonly cache = new Map<string, { at: number; state: LiveServerState }>();

  constructor(
    private readonly dbServers: ServerService,
    private readonly config: AppConfig,
  ) {}

  portForSkill(meta: SkillMetadata | null | undefined, name: string): number | undefined {
    const hit = meta?.ports.find((p) => p.name === name && p.default);
    return hit?.default;
  }

  resolveQueryPorts(
    skillName: string,
    meta: SkillMetadata | null,
  ): { gamePort: number; queryPort: number } {
    const gamePort =
      this.portForSkill(meta, "game") ?? this.dbServers.gamePortForSkill(skillName);
    const queryPortName = meta?.queryPortName?.trim() || "query";
    const queryPort = this.portForSkill(meta, queryPortName) ?? gamePort;
    return { gamePort, queryPort };
  }

  async queryServer(serverId: string): Promise<LiveServerState> {
    const server = await this.dbServers.get(serverId);
    if (!server) return offlineState(`unknown_server: ${serverId}`);

    const marker = readSkillMarker(server.dataPath) ?? {};
    const skillName = marker.skillName ?? "";
    const roots = skillsRootsForWorkspace(
      this.config.skillsRoots,
      this.config.dataRoot,
      serverId,
    );
    const entry = skillName ? loadSkillMetadata(roots, skillName) : null;
    const meta = entry?.metadata ?? null;
    const dialect = resolveQueryDialect(
      skillName,
      (meta?.queryDialect && meta.queryDialect !== "none" ? meta.queryDialect : undefined) ??
        (marker.queryDialect && marker.queryDialect !== "none" ? marker.queryDialect : undefined),
    );
    if (dialect === "none") {
      return offlineState("query_dialect_none");
    }

    const { gamePort, queryPort } = this.resolveQueryPorts(skillName, meta);
    // Probe the node players join (LAN joinHost / Home advertise), not API loopback.
    const host = await this.dbServers.resolveJoinAddress(server);
    const connectorRel =
      meta?.queryConnector ?? marker.queryConnector ?? DEFAULT_QUERY_CONNECTOR;
    const target: QueryTarget = {
      host,
      port: primaryPortForDialect(dialect, { gamePort, queryPort }),
      queryPort,
      gamePort,
      timeoutMs: 2500,
      allowedPorts: meta?.ports.map((p) => p.default).filter((p): p is number => Boolean(p)) ?? [],
    };

    try {
      const connector = defaultRegistry.resolve({
        queryDialect: dialect,
        skillModule:
          dialect === "skill_module" && entry
            ? {
                skillDir: entry.path,
                connectorRelPath: connectorRel,
              }
            : undefined,
      });
      if (!connector) return offlineState("no_connector");
      const state = await connector.query(target);
      this.cache.set(serverId, { at: Date.now(), state });
      return state;
    } catch (err) {
      return offlineState(err instanceof Error ? err.message : "query_failed");
    }
  }

  /** Retry while the game process is still binding its query port after start. */
  async queryServerWithRetry(
    serverId: string,
    opts: { attempts?: number; delayMs?: number } = {},
  ): Promise<LiveServerState> {
    const attempts = Math.max(1, opts.attempts ?? 5);
    const delayMs = Math.max(0, opts.delayMs ?? 1200);
    let last = await this.queryServer(serverId);
    for (let i = 1; i < attempts && !last.online; i++) {
      if (delayMs) await sleep(delayMs);
      last = await this.queryServer(serverId);
    }
    return last;
  }

  getCached(serverId: string, maxAgeMs = 60_000): LiveServerState | null {
    const hit = this.cache.get(serverId);
    if (!hit) return null;
    if (Date.now() - hit.at > maxAgeMs) return null;
    return hit.state;
  }

  async queryTest(args: QueryTestArgs): Promise<LiveServerState> {
    const host = args.host.trim() || "127.0.0.1";
    const port = Number(args.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return offlineState("invalid_port");
    }

    let dialect: QueryDialect = args.queryDialect ?? "none";
    let skillDir: string | undefined;
    let connectorRel: string | undefined;
    let meta: SkillMetadata | null = null;

    if (args.skillName) {
      const entry = loadSkillMetadata(this.config.skillsRoots, String(args.skillName));
      if (!entry) return offlineState(`unknown_skill: ${args.skillName}`);
      skillDir = entry.path;
      meta = entry.metadata;
      dialect = resolveQueryDialect(
        String(args.skillName),
        args.queryDialect ?? meta.queryDialect,
      );
      connectorRel = meta.queryConnector ?? DEFAULT_QUERY_CONNECTOR;
    }

    if (args.connectorPath) {
      const rawPath = String(args.connectorPath);
      if (path.isAbsolute(rawPath) && fs.existsSync(rawPath)) {
        skillDir = path.dirname(path.dirname(rawPath));
        connectorRel = path.basename(path.dirname(rawPath)) + "/" + path.basename(rawPath);
        if (path.basename(path.dirname(rawPath)) !== "query") {
          skillDir = path.dirname(rawPath);
          connectorRel = path.basename(rawPath);
        }
        dialect = "skill_module";
      } else if (skillDir) {
        connectorRel = rawPath;
        dialect = "skill_module";
      } else {
        return offlineState("connector_path_requires_skillName_or_absolute");
      }
    }

    if (dialect === "none") {
      dialect = skillDir ? "skill_module" : "none";
    }
    if (dialect === "none") return offlineState("query_dialect_none");

    const gamePort = args.gamePort ?? this.portForSkill(meta, "game") ?? port;
    const queryPort = args.queryPort ?? this.portForSkill(meta, meta?.queryPortName ?? "query") ?? port;

    try {
      const connector = defaultRegistry.resolve({
        queryDialect: dialect,
        skillModule:
          dialect === "skill_module" && skillDir
            ? { skillDir, connectorRelPath: connectorRel ?? DEFAULT_QUERY_CONNECTOR }
            : undefined,
      });
      if (!connector) return offlineState("no_connector");
      return await connector.query({
        host,
        port: primaryPortForDialect(dialect, { gamePort, queryPort }),
        queryPort,
        gamePort,
        timeoutMs: args.timeoutMs ?? 2500,
        allowedPorts: [port, queryPort, gamePort],
      });
    } catch (err) {
      return offlineState(err instanceof Error ? err.message : "query_test_failed");
    }
  }

  /** Used by health checks — ignore cache. */
  async isQueryResponding(server: ServerRecord): Promise<{ ok: boolean; detail: string }> {
    const state = await this.queryServer(server.id);
    if (state.online) return { ok: true, detail: "query online" };
    return { ok: false, detail: state.error ?? "query offline" };
  }
}
