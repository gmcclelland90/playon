import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  createRuntime,
  followLogFile,
  localDockerTransport,
  openServerRuntime,
  readLogFileTail,
  type DockerAdapter,
  type LogFollowHandle,
  type ProcessSupervisor,
  type RuntimeLocality,
  type RuntimeMode,
  type ServerContainerSpec,
  type ServerRuntimeHandle,
} from "@playon/runtime";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import {
  conversations,
  messages,
  nodes,
  panelBlocks,
  servers,
  snapshots,
  toolInvocations,
  watcherRuns,
  watchers,
} from "../db/schema.js";
import type { LanGateway } from "./cloud/gateway.js";
import type { EventHub } from "./event-hub.js";
import { PlacementService } from "./placement.js";
import { pushServerDirToNode } from "./node-sync.js";
import {
  generateRconPassword,
  parseSourceRconText,
  patchSourceRconCfgText,
  patchSourceRconConfigFiles,
  patchSourceRconIniText,
  readRconConfig,
  writeRconConfig,
  type RconEndpoint,
} from "./rcon.js";
import { nativeGamePort, nativeRconPort, resolveNativeLaunch } from "./native-launch.js";
import {
  readSkillMarker,
  writeSkillMarkerFromSkill,
} from "./skill-marker.js";
import { loadSkillMetadata, type SkillEntry } from "./skills.js";
import {
  AdminDialectSchema,
  isLocalNodeId,
  NODE_AUTHORITATIVE_MARKER,
  type AdminDialect,
  type SkillMetadata,
} from "@playon/shared";
import { dispatchNodeJob, nodeServerRelPath } from "./node-runtime.js";

export interface ServerRecord {
  id: string;
  name: string;
  game: string | null;
  nodeId: string | null;
  runtimeMode: string;
  status: string;
  dataPath: string;
  createdAt: Date;
}

export type ConsoleInputState = "ready" | "unsupported" | "unavailable";

export interface ServerConsoleCapability {
  input: ConsoleInputState;
  dialect: AdminDialect;
}

export interface ServerRuntimeDetail {
  kind: "docker" | "native";
  containerName?: string;
  containerStatus?: string;
  imageHint?: string;
  join?: { address: string; port: number };
  logs?: string[];
  /** Dialect-agnostic admin console capability (never includes secrets). */
  console?: ServerConsoleCapability;
}

export interface ServerDetail {
  server: ServerRecord;
  runtime: ServerRuntimeDetail;
}

function toRecord(row: typeof servers.$inferSelect): ServerRecord {
  return {
    id: row.id,
    name: row.name,
    game: row.game,
    nodeId: row.nodeId,
    runtimeMode: row.runtimeMode,
    status: row.status,
    dataPath: row.dataPath,
    createdAt: row.createdAt,
  };
}

export class ServerService {
  private readonly adapters = new Map<string, DockerAdapter>();
  private readonly processes = new Map<string, string>();
  private readonly logFollows = new Map<string, LogFollowHandle>();
  private sharedDocker: DockerAdapter | null = null;
  private sharedProcess: ProcessSupervisor | null = null;

  /** Skill roots for panel/join resolution (same as create/start). */
  get skillsRoots(): string[] {
    return this.config.skillsRoots;
  }

  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
    private readonly events?: EventHub,
    private readonly gateway?: LanGateway,
  ) {}

  private emitStatus(
    serverId: string,
    status: "creating" | "starting" | "running" | "stopping" | "stopped" | "error",
  ): void {
    this.events?.publish({ type: "server.status", serverId, status });
  }

  private stopLogFollow(serverId: string): void {
    const handle = this.logFollows.get(serverId);
    if (!handle) return;
    handle.abort();
    this.logFollows.delete(serverId);
  }

  private consoleLogAbs(serverDataPath: string): string {
    return path.join(serverDataPath, "logs", "console.log");
  }

  private consoleLogRel(serverId: string): string {
    return nodeServerRelPath(serverId, "logs", "console.log");
  }

  private async beginLogFollow(serverId: string, containerId: string): Promise<void> {
    this.stopLogFollow(serverId);
    await this.ensureRuntime();
    const adapter = this.adapterFor(serverId);
    if (!adapter.followLogs) return;
    try {
      const handle = await adapter.followLogs(containerId, (line) => {
        this.events?.publish({ type: "server.log", serverId, line });
      });
      this.logFollows.set(serverId, handle);
    } catch {
      // follow is best-effort; REST detail still has snapshots
    }
  }

  private beginFileLogFollow(serverId: string, logPath: string): void {
    this.stopLogFollow(serverId);
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      const handle = followLogFile(logPath, (line) => {
        this.events?.publish({ type: "server.log", serverId, line });
      });
      this.logFollows.set(serverId, handle);
    } catch {
      // best-effort
    }
  }

  private async readNativeLogTail(server: ServerRecord, lines: number): Promise<string[]> {
    if (!this.isRemoteNode(server)) {
      return readLogFileTail(this.consoleLogAbs(server.dataPath), lines);
    }
    try {
      const rel = this.consoleLogRel(server.id);
      // Probe size first — reading from offset 0 only returns the head of large logs.
      const probe = await dispatchNodeJob({
        nodeId: server.nodeId,
        kind: "fs_read_text",
        args: { path: rel, offset: 0, maxBytes: 1 },
        timeoutMs: 15_000,
        localHandler: async () => {
          throw new Error("remote_only");
        },
      });
      const maxBytes = 128_000;
      const offset = Math.max(0, probe.size - maxBytes);
      const result = await dispatchNodeJob({
        nodeId: server.nodeId,
        kind: "fs_read_text",
        args: { path: rel, offset, maxBytes },
        timeoutMs: 15_000,
        localHandler: async () => {
          throw new Error("remote_only");
        },
      });
      return result.content
        .split(/\r?\n/)
        .filter((l) => l.length > 0)
        .slice(-lines);
    } catch {
      return [];
    }
  }

  private isNodeAuthoritative(server: ServerRecord): boolean {
    return (
      this.isRemoteNode(server) &&
      fs.existsSync(path.join(server.dataPath, NODE_AUTHORITATIVE_MARKER))
    );
  }

  private async syncRconJsonToNode(server: ServerRecord, endpoint: RconEndpoint): Promise<void> {
    if (!server.nodeId || isLocalNodeId(server.nodeId)) return;
    const body = JSON.stringify(
      { host: "127.0.0.1", port: endpoint.port, password: endpoint.password },
      null,
      2,
    );
    const rel = nodeServerRelPath(server.id, "rcon.json");
    await dispatchNodeJob({
      nodeId: server.nodeId,
      kind: "fs_write_text",
      args: { path: rel, content: body },
      timeoutMs: 15_000,
      localHandler: async () => {
        writeRconConfig(server.dataPath, endpoint);
        return { path: rel, bytes: Buffer.byteLength(body, "utf8") };
      },
    });
  }

  private nodeJailRel(serverId: string, relPath: string): string {
    const parts = relPath
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .split("/")
      .filter((p) => p && p !== ".");
    return parts.length ? nodeServerRelPath(serverId, ...parts) : nodeServerRelPath(serverId);
  }

  private async readNodeText(server: ServerRecord, relPath: string): Promise<string | null> {
    if (!server.nodeId || isLocalNodeId(server.nodeId)) return null;
    try {
      const result = await dispatchNodeJob({
        nodeId: server.nodeId,
        kind: "fs_read_text",
        args: {
          path: this.nodeJailRel(server.id, relPath),
          maxBytes: 256_000,
        },
        timeoutMs: 30_000,
        localHandler: async () => {
          throw new Error("remote_only");
        },
      });
      return result.content;
    } catch {
      return null;
    }
  }

  private async writeNodeText(
    server: ServerRecord,
    relPath: string,
    content: string,
  ): Promise<boolean> {
    if (!server.nodeId || isLocalNodeId(server.nodeId)) return false;
    try {
      await dispatchNodeJob({
        nodeId: server.nodeId,
        kind: "fs_write_text",
        args: {
          path: this.nodeJailRel(server.id, relPath),
          content,
        },
        timeoutMs: 30_000,
        localHandler: async () => {
          throw new Error("remote_only");
        },
      });
      return true;
    } catch {
      return false;
    }
  }

  private async listNodeDir(
    server: ServerRecord,
    relPath: string,
  ): Promise<Array<{ name: string; type: "file" | "dir" }>> {
    if (!server.nodeId || isLocalNodeId(server.nodeId)) return [];
    try {
      const result = await dispatchNodeJob({
        nodeId: server.nodeId,
        kind: "fs_list",
        args: {
          path: this.nodeJailRel(server.id, relPath),
        },
        timeoutMs: 30_000,
        localHandler: async () => {
          throw new Error("remote_only");
        },
      });
      return result.entries;
    } catch {
      return [];
    }
  }

  /** Walk node jail for *.ini / *.cfg candidates (bounded). */
  private async collectNodeConfigCandidates(server: ServerRecord): Promise<string[]> {
    const files: string[] = [];
    const skip = new Set(["node_modules", ".git", "steamapps", "logs", "Workshop"]);
    const visit = async (rel: string, depth: number): Promise<void> => {
      if (files.length >= 40 || depth > 4) return;
      const entries = await this.listNodeDir(server, rel);
      for (const ent of entries) {
        if (files.length >= 40) return;
        const child = rel === "." ? ent.name : `${rel}/${ent.name}`;
        if (ent.type === "dir") {
          if (skip.has(ent.name)) continue;
          await visit(child, depth + 1);
        } else if (/\.(ini|cfg)$/i.test(ent.name)) {
          files.push(child);
        }
      }
    };
    await visit(".", 0);
    return files;
  }

  private async discoverSourceRconOnNode(server: ServerRecord): Promise<RconEndpoint | null> {
    for (const rel of await this.collectNodeConfigCandidates(server)) {
      const text = await this.readNodeText(server, rel);
      if (!text) continue;
      const parsed = parseSourceRconText(text);
      if (parsed) return { host: "127.0.0.1", ...parsed };
    }
    return null;
  }

  private async discoverMcRconOnNode(server: ServerRecord): Promise<RconEndpoint | null> {
    const text = await this.readNodeText(server, "game/server.properties");
    if (!text) return null;
    const password = text.match(/^rcon\.password=(.*)$/m)?.[1]?.trim();
    const portRaw = text.match(/^rcon\.port=(.*)$/m)?.[1]?.trim();
    const enabled = text.match(/^enable-rcon=(.*)$/m)?.[1]?.trim();
    if (!password || enabled === "false") return null;
    const port = portRaw ? Number(portRaw) : 25575;
    if (!Number.isFinite(port)) return null;
    return { host: "127.0.0.1", port, password };
  }

  private async patchSourceRconOnNode(
    server: ServerRecord,
    endpoint: RconEndpoint,
  ): Promise<boolean> {
    let patched = false;
    for (const rel of await this.collectNodeConfigCandidates(server)) {
      const text = await this.readNodeText(server, rel);
      if (!text) continue;
      const next = /\.ini$/i.test(rel)
        ? patchSourceRconIniText(text, endpoint)
        : /server\.cfg$/i.test(rel)
          ? patchSourceRconCfgText(text, endpoint)
          : null;
      if (next == null) continue;
      if (await this.writeNodeText(server, rel, next)) patched = true;
    }
    return patched;
  }

  /**
   * Resolve RCON credentials for local or node-authoritative servers.
   * Prefer existing rcon.json / game configs; only generate when missing.
   */
  private async resolveRconConfig(
    server: ServerRecord,
    skillName: string,
  ): Promise<RconEndpoint | null> {
    if (!this.wantsAnyRcon(skillName)) {
      return readRconConfig(server.dataPath);
    }

    const local = readRconConfig(server.dataPath);
    if (local) {
      if (this.isRemoteNode(server)) {
        await this.syncRconJsonToNode(server, local).catch(() => undefined);
      }
      return local;
    }

    if (this.isNodeAuthoritative(server)) {
      const nodeJson = await this.readNodeText(server, "rcon.json");
      if (nodeJson) {
        try {
          const parsed = JSON.parse(nodeJson) as Partial<RconEndpoint>;
          if (
            typeof parsed.port === "number" &&
            typeof parsed.password === "string" &&
            parsed.password
          ) {
            const endpoint: RconEndpoint = {
              host: "127.0.0.1",
              port: parsed.port,
              password: parsed.password,
            };
            writeRconConfig(server.dataPath, endpoint);
            return endpoint;
          }
        } catch {
          // fall through
        }
      }
      const discovered = this.wantsSourceRcon(skillName)
        ? await this.discoverSourceRconOnNode(server)
        : this.wantsMcRcon(skillName)
          ? await this.discoverMcRconOnNode(server)
          : null;
      if (discovered) {
        writeRconConfig(server.dataPath, discovered);
        await this.syncRconJsonToNode(server, discovered).catch(() => undefined);
        return discovered;
      }
    }

    const endpoint: RconEndpoint = {
      host: "127.0.0.1",
      port: this.rconPortForSkill(skillName),
      password: generateRconPassword(),
    };
    writeRconConfig(server.dataPath, endpoint);
    if (this.wantsSourceRcon(skillName)) {
      patchSourceRconConfigFiles(server.dataPath, endpoint);
      if (this.isNodeAuthoritative(server)) {
        await this.patchSourceRconOnNode(server, endpoint).catch(() => undefined);
      }
    }
    if (this.isRemoteNode(server)) {
      await this.syncRconJsonToNode(server, endpoint).catch(() => undefined);
    }
    return endpoint;
  }

  private async ensureRuntime(): Promise<void> {
    if (this.sharedDocker && this.sharedProcess) return;

    // Host PLAYON_RUNTIME is authoritative — never probe Docker when mode is native.
    const adapters = await createRuntime(this.config.runtimeMode);
    this.sharedDocker = adapters.docker;
    this.sharedProcess = adapters.process;
  }

  private adapterFor(serverId: string): DockerAdapter {
    let adapter = this.adapters.get(serverId);
    if (!adapter) {
      if (!this.sharedDocker) {
        throw new Error("runtime_not_ready");
      }
      adapter = this.sharedDocker;
      this.adapters.set(serverId, adapter);
    }
    return adapter;
  }

  private containerName(serverId: string): string {
    return `playon-${serverId}`;
  }

  private readSkillName(dataPath: string): string {
    return readSkillMarker(dataPath)?.skillName ?? "";
  }

  private resolveSkill(skillName: string): SkillEntry | null {
    if (!skillName) return null;
    return loadSkillMetadata(this.config.skillsRoots, skillName);
  }

  private portFromSkill(
    skillName: string,
    portName: string,
    fallback: number,
  ): number {
    const skill = this.resolveSkill(skillName);
    const hit = skill?.metadata.ports.find((p) => p.name === portName && p.default);
    return hit?.default ?? fallback;
  }

  gamePortForSkill(skillName: string, _game?: string | null): number {
    const fromMeta = this.portFromSkill(skillName, "game", 0);
    if (fromMeta > 0) return fromMeta;
    const native = nativeGamePort(this.resolveSkill(skillName)?.metadata);
    if (native != null) return native;
    // No Minecraft-style invent: skills without a declared game port return 0.
    return 0;
  }

  /** TCP game port only — used for default health probes (UDP games must not get tcp_port). */
  tcpGamePortForSkill(skillName: string): number {
    const skill = this.resolveSkill(skillName);
    const hit = skill?.metadata.ports.find(
      (p) => p.name === "game" && p.protocol === "tcp" && p.default,
    );
    return hit?.default ?? 0;
  }

  rconPortForSkill(skillName: string, _game?: string | null): number {
    const fromMeta = this.portFromSkill(skillName, "rcon", 0);
    if (fromMeta > 0) return fromMeta;
    const native = nativeRconPort(this.resolveSkill(skillName)?.metadata);
    if (native != null) return native;
    const dialect = this.resolveSkill(skillName)?.metadata.adminDialect;
    return dialect === "source_rcon" ? 27015 : 25575;
  }

  private wantsMcRcon(skillName: string): boolean {
    return this.resolveSkill(skillName)?.metadata.adminDialect === "mc_rcon";
  }

  private wantsSourceRcon(skillName: string): boolean {
    return this.resolveSkill(skillName)?.metadata.adminDialect === "source_rcon";
  }

  private wantsAnyRcon(skillName: string): boolean {
    return this.wantsMcRcon(skillName) || this.wantsSourceRcon(skillName);
  }

  /** Ensure rcon.json exists for mc_rcon / source_rcon skills (local FS only). */
  ensureRconConfig(server: ServerRecord, skillName: string): RconEndpoint | null {
    if (!this.wantsAnyRcon(skillName)) return readRconConfig(server.dataPath);
    const existing = readRconConfig(server.dataPath);
    if (existing) return existing;
    // Node-authoritative trees are resolved asynchronously via resolveRconConfig.
    if (this.isNodeAuthoritative(server)) return null;
    const endpoint: RconEndpoint = {
      host: "127.0.0.1",
      port: this.rconPortForSkill(skillName),
      password: generateRconPassword(),
    };
    writeRconConfig(server.dataPath, endpoint);
    if (this.wantsSourceRcon(skillName)) {
      patchSourceRconConfigFiles(server.dataPath, endpoint);
    }
    return endpoint;
  }

  async getRconEndpoint(serverId: string): Promise<RconEndpoint | null> {
    const server = await this.get(serverId);
    if (!server) return null;
    const skillName = this.readSkillName(server.dataPath);
    const local =
      (await this.resolveRconConfig(server, skillName)) ?? readRconConfig(server.dataPath);
    if (!local) return null;
    // Remote nodes: talk to the node's LAN/overlay address, not Home loopback.
    if (this.isRemoteNode(server)) {
      const host = await this.resolveJoinAddress(server);
      return { ...local, host };
    }
    return { ...local, host: "127.0.0.1" };
  }

  /** Resolve skill adminDialect for a server (defaults to none). */
  async getAdminDialect(serverId: string): Promise<AdminDialect | null> {
    const server = await this.get(serverId);
    if (!server) return null;
    return this.adminDialectFor(server);
  }

  private adminDialectFor(server: ServerRecord): AdminDialect {
    const skillName = this.readSkillName(server.dataPath);
    const live = this.resolveSkill(skillName)?.metadata.adminDialect;
    const cached = this.readSkillMeta(server.dataPath).adminDialect;
    const raw = live ?? cached ?? "none";
    const parsed = AdminDialectSchema.safeParse(raw);
    return parsed.success ? parsed.data : "none";
  }

  /**
   * Whether the browser/agent console can accept input for this server right now.
   * Secrets and endpoints are never included.
   */
  async consoleCapability(serverId: string): Promise<ServerConsoleCapability | null> {
    const server = await this.get(serverId);
    if (!server) return null;
    const dialect = this.adminDialectFor(server);

    if (dialect === "none") {
      return { input: "unavailable", dialect };
    }
    if (dialect === "rust_web_rcon" || dialect === "http_rest") {
      return { input: "unsupported", dialect };
    }
    if (server.status !== "running" && server.status !== "starting") {
      return { input: "unavailable", dialect };
    }

    if (dialect === "mc_rcon" || dialect === "source_rcon") {
      const endpoint = await this.getRconEndpoint(serverId);
      return { input: endpoint ? "ready" : "unavailable", dialect };
    }

    // stdin — Docker only in this slice (native supervisor uses stdio:ignore).
    if (dialect === "stdin") {
      if (server.runtimeMode === "native") {
        return { input: "unavailable", dialect };
      }
      try {
        await this.ensureRuntime();
        const adapter = this.adapterFor(serverId);
        if (typeof adapter.writeStdin !== "function") {
          return { input: "unsupported", dialect };
        }
        const info = await adapter.inspect(this.containerName(serverId));
        return { input: info.status === "running" ? "ready" : "unavailable", dialect };
      } catch {
        return { input: "unavailable", dialect };
      }
    }

    return { input: "unsupported", dialect };
  }

  /** Write a console line to the server's container stdin (local or remote node). */
  async writeContainerStdin(serverId: string, line: string): Promise<void> {
    const server = await this.get(serverId);
    if (!server) throw new Error("unknown_server");
    if (server.runtimeMode === "native") {
      throw new Error("stdin_unavailable_native");
    }
    await this.ensureRuntime();
    const name = this.containerName(serverId);
    await dispatchNodeJob({
      nodeId: server.nodeId,
      kind: "container_stdin",
      args: { id: name, line },
      timeoutMs: 30_000,
      localHandler: async () => {
        const adapter = this.adapterFor(serverId);
        if (typeof adapter.writeStdin !== "function") {
          throw new Error("container_stdin_unsupported");
        }
        let containerId = name;
        try {
          const info = await adapter.inspect(name);
          containerId = info.id;
        } catch {
          throw new Error("container_missing");
        }
        await adapter.writeStdin(containerId, line);
        return { ok: true as const };
      },
    });
  }

  private readSkillMeta(dataPath: string): {
    skillName: string;
    containerSupport?: string;
    dockerImage?: string;
    dockerEnv?: Record<string, string>;
    dockerDataMount?: string;
    steamAppId?: number;
    adminDialect?: string;
  } {
    const raw = readSkillMarker(dataPath);
    if (!raw) return { skillName: "" };
    return {
      skillName: raw.skillName ?? "",
      containerSupport: raw.containerSupport,
      dockerImage: raw.dockerImage,
      dockerEnv: raw.dockerEnv,
      dockerDataMount: raw.dockerDataMount,
      steamAppId: raw.steamAppId,
      adminDialect: raw.adminDialect,
    };
  }

  private dockerSpecFromSkill(
    skillName: string,
    cached: ReturnType<ServerService["readSkillMeta"]>,
  ): {
    image: string;
    env: Record<string, string>;
    dataMount: string;
    ports: SkillMetadata["ports"];
  } | null {
    const live = this.resolveSkill(skillName)?.metadata;
    const image = live?.dockerImage || cached.dockerImage;
    if (!image) return null;
    return {
      image,
      env: { ...(live?.dockerEnv ?? cached.dockerEnv ?? {}) },
      dataMount: live?.dockerDataMount || cached.dockerDataMount || "/data",
      ports: live?.ports ?? [],
    };
  }

  private wantsNativeRuntime(
    server: ServerRecord,
    _skillName: string,
    containerSupport?: string,
  ): boolean {
    // Host native mode always uses process supervisor (no docker pretend).
    if (this.config.runtimeMode === "native") return true;
    if (server.runtimeMode === "native") return true;
    // containerSupport=none → OS process; full/partial → docker when host has docker.
    if (containerSupport === "none") return true;
    return false;
  }

  private runtimeTarget(server: ServerRecord): {
    mode: RuntimeMode;
    locality: RuntimeLocality;
    skillName: string;
    skillMeta: ReturnType<ServerService["readSkillMeta"]>;
  } {
    const skillMeta = this.readSkillMeta(server.dataPath);
    const skillName = skillMeta.skillName || this.readSkillName(server.dataPath);
    return {
      mode: this.wantsNativeRuntime(server, skillName, skillMeta.containerSupport)
        ? "native"
        : "docker",
      locality: this.isRemoteNode(server) ? "remote" : "local",
      skillName,
      skillMeta,
    };
  }

  /** Quadrants already migrated to {@link ServerRuntimeHandle}; the rest stay on the old paths. */
  private usesRuntimeHandle(server: ServerRecord): boolean {
    const target = this.runtimeTarget(server);
    return target.mode === "docker" && target.locality === "local";
  }

  private localDockerSpec(
    server: ServerRecord,
    skillName: string,
    skillMeta: ReturnType<ServerService["readSkillMeta"]>,
  ): ServerContainerSpec {
    const docker = this.dockerSpecFromSkill(skillName, skillMeta);
    if (!docker) {
      throw new Error(
        `no_container_image: skill "${skillName || server.game || "unknown"}" has containerSupport but no dockerImage in metadata. Add dockerImage to the skill or use a native skill.`,
      );
    }
    const gamePort = this.gamePortForSkill(skillName, server.game);
    const rcon = this.ensureRconConfig(server, skillName);
    const rconPort = rcon?.port ?? this.rconPortForSkill(skillName, server.game);
    const env: Record<string, string> = { ...docker.env };
    if (this.wantsMcRcon(skillName)) {
      env.ENABLE_RCON = env.ENABLE_RCON ?? "true";
      env.RCON_PORT = String(rconPort);
      env.RCON_PASSWORD = rcon?.password ?? generateRconPassword();
    }

    const ports =
      docker.ports.length > 0
        ? docker.ports
            .filter((p) => p.default)
            .map((p) => ({
              host: p.default!,
              container: p.default!,
              protocol: p.protocol,
            }))
        : [{ host: gamePort, container: gamePort, protocol: "tcp" as const }];

    return {
      image: docker.image,
      env,
      ports,
      binds: [
        {
          hostPath: path.join(server.dataPath, "game"),
          containerPath: docker.dataMount,
        },
      ],
    };
  }

  /** Only production choke point for server runtime lifecycle. */
  async runtime(serverId: string): Promise<ServerRuntimeHandle> {
    const server = await this.getRaw(serverId);
    if (!server) throw new Error(`unknown_server: ${serverId}`);
    return this.openRuntime(server);
  }

  private async openRuntime(server: ServerRecord): Promise<ServerRuntimeHandle> {
    const { mode, locality, skillName, skillMeta } = this.runtimeTarget(server);
    const local = mode === "docker" && locality === "local";
    if (local) await this.ensureRuntime();
    return openServerRuntime(
      { serverId: server.id, mode, locality },
      {
        containerName: this.containerName(server.id),
        docker: local ? localDockerTransport(this.adapterFor(server.id)) : undefined,
        resolveContainerSpec: async () => this.localDockerSpec(server, skillName, skillMeta),
      },
    );
  }

  /** Best-effort kill of native game processes for this server (covers orphans after API restart). */
  private killNativeGameProcesses(serverDataPath: string): void {
    if (process.platform === "win32") return;
    const gameDir = path.join(serverDataPath, "game");
    try {
      execFileSync("pkill", ["-f", gameDir], { stdio: "ignore" });
    } catch {
      // pkill exits 1 when nothing matched
    }
  }

  /**
   * Join/probe host for a server:
   * - cloud → Home advertiseHost (LAN gateway)
   * - lan/local with nodes.joinHost → that host
   * - else → advertiseHost
   */
  async resolveJoinAddress(server: ServerRecord): Promise<string> {
    if (!server.nodeId || isLocalNodeId(server.nodeId)) {
      return this.config.advertiseHost;
    }
    const node = await this.nodeRow(server.nodeId);
    if (!node) return this.config.advertiseHost;
    if (node.kind === "cloud") return this.config.advertiseHost;
    const joinHost = node.joinHost?.trim();
    if (joinHost) return joinHost;
    return this.config.advertiseHost;
  }

  async joinInfoFor(server: ServerRecord): Promise<{ address: string; port: number }> {
    const skillName = this.readSkillName(server.dataPath);
    return {
      address: await this.resolveJoinAddress(server),
      port: this.gamePortForSkill(skillName, server.game),
    };
  }

  private async nodeRow(nodeId: string | null | undefined) {
    if (!nodeId) return null;
    const rows = await this.db.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    return rows[0] ?? null;
  }

  /** For cloud nodes, publish Home LAN → overlay game port forwards. */
  private async ensureCloudGateway(server: ServerRecord, skillName: string): Promise<void> {
    if (!this.gateway || !server.nodeId || isLocalNodeId(server.nodeId)) return;
    const node = await this.nodeRow(server.nodeId);
    if (!node || node.kind !== "cloud" || !node.overlayIp) return;
    if (node.tunnelStatus === "down" || node.tunnelStatus === "unconfigured") {
      throw new Error(`cloud_capacity_unreachable: tunnel ${node.tunnelStatus}`);
    }
    const skill = this.resolveSkill(skillName);
    const ports =
      skill?.metadata.ports.filter((p) => p.default != null).map((p) => ({
        port: p.default!,
        protocol: (p.protocol === "udp" ? "udp" : "tcp") as "tcp" | "udp",
      })) ?? [
        {
          port: this.gamePortForSkill(skillName, server.game),
          protocol: "tcp" as const,
        },
      ];
    for (const p of ports) {
      await this.gateway.ensure({
        serverId: server.id,
        nodeId: server.nodeId,
        listenPort: p.port,
        protocol: p.protocol,
        targetHost: node.overlayIp,
        targetPort: p.port,
      });
    }
  }

  async list(): Promise<ServerRecord[]> {
    const rows = await this.db.select().from(servers);
    const records = rows.map(toRecord);
    for (const record of records) {
      await this.reconcileStatus(record).catch(() => undefined);
    }
    const refreshed = await this.db.select().from(servers);
    return refreshed.map(toRecord);
  }

  async get(id: string): Promise<ServerRecord | null> {
    const rows = await this.db.select().from(servers).where(eq(servers.id, id)).limit(1);
    if (!rows[0]) return null;
    const record = toRecord(rows[0]);
    await this.reconcileStatus(record).catch(() => undefined);
    return (await this.getRaw(id))!;
  }

  private async getRaw(id: string): Promise<ServerRecord | null> {
    const rows = await this.db.select().from(servers).where(eq(servers.id, id)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  private nativeProcessAlive(server: ServerRecord): boolean {
    if (this.processes.has(server.id)) return true;
    if (process.platform === "win32") return false;
    const gameDir = path.join(server.dataPath, "game");
    const skillName = this.readSkillName(server.dataPath);
    const native = this.resolveSkill(skillName)?.metadata.native;
    const binaryBits = [native?.binary, native?.binaryWindows]
      .filter(Boolean)
      .map((b) => path.basename(String(b)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const pattern = ["start\\.sh", "start\\.bat", "run\\.sh", "runds\\.sh", ...binaryBits].join(
      "|",
    );
    // Match start scripts / skill-declared binaries; confirm cwd is this server's game dir.
    try {
      const pids = execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" })
        .trim()
        .split("\n")
        .filter(Boolean);
      for (const pid of pids) {
        try {
          const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
          if (cwd === gameDir || cwd.startsWith(`${gameDir}${path.sep}`)) return true;
        } catch {
          /* process exited */
        }
      }
    } catch {
      /* no matching processes */
    }
    try {
      execFileSync("pgrep", ["-f", server.id], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  private async reconcileStatus(server: ServerRecord): Promise<void> {
    const skillMeta = this.readSkillMeta(server.dataPath);
    const useNative = this.wantsNativeRuntime(
      server,
      skillMeta.skillName,
      skillMeta.containerSupport,
    );

    if (useNative) {
      if (this.isRemoteNode(server) && server.nodeId) {
        const procId = this.processes.get(server.id);
        if (procId) {
          try {
            const info = await dispatchNodeJob({
              nodeId: server.nodeId,
              kind: "process_status",
              args: { id: procId },
              timeoutMs: 15_000,
              localHandler: async () => {
                throw new Error("remote_only");
              },
            });
            const next = info.status === "running" ? "running" : "stopped";
            if (next === "stopped") this.processes.delete(server.id);
            if (next !== server.status) {
              await this.db.update(servers).set({ status: next }).where(eq(servers.id, server.id));
              this.emitStatus(server.id, next);
            }
          } catch {
            // Agent restart loses in-memory process ids; don't flip to stopped via Docker inspect.
          }
          return;
        }
        // No tracked remote process — local pgrep can't see the node. Leave status alone.
        return;
      }

      const next = this.nativeProcessAlive(server) ? "running" : "stopped";
      if (next !== server.status) {
        await this.db.update(servers).set({ status: next }).where(eq(servers.id, server.id));
        this.emitStatus(server.id, next);
      }
      return;
    }

    await this.ensureRuntime();
    const missing = async (): Promise<void> => {
      if (server.status === "running" || server.status === "starting") {
        await this.db.update(servers).set({ status: "stopped" }).where(eq(servers.id, server.id));
        this.emitStatus(server.id, "stopped");
      }
    };

    if (this.usesRuntimeHandle(server)) {
      let state: string;
      try {
        state = (await (await this.openRuntime(server)).status()).state;
      } catch {
        state = "missing";
      }
      if (state === "missing") {
        await missing();
        return;
      }
      const next = state === "running" ? "running" : "stopped";
      if (next !== server.status) {
        await this.db.update(servers).set({ status: next }).where(eq(servers.id, server.id));
        this.emitStatus(server.id, next);
      }
      return;
    }

    const adapter = this.adapterFor(server.id);
    try {
      const info = await adapter.inspect(this.containerName(server.id));
      const next = info.status === "running" ? "running" : "stopped";
      if (next !== server.status) {
        await this.db.update(servers).set({ status: next }).where(eq(servers.id, server.id));
        this.emitStatus(server.id, next);
      }
    } catch {
      await missing();
    }
  }

  async detail(id: string): Promise<ServerDetail | null> {
    const server = await this.get(id);
    if (!server) return null;

    const skillName = this.readSkillName(server.dataPath);
    const join = await this.joinInfoFor(server);
    const cached = this.readSkillMeta(server.dataPath);
    const consoleCap = await this.consoleCapability(id);

    if (server.runtimeMode === "native") {
      const logs = await this.readNativeLogTail(server, 40);
      return {
        server,
        runtime: {
          kind: "native",
          join,
          logs,
          console: consoleCap ?? undefined,
        },
      };
    }

    await this.ensureRuntime();
    const adapter = this.adapterFor(id);
    const name = this.containerName(id);
    let containerStatus = "missing";
    let logs: string[] = [];
    try {
      const info = await adapter.inspect(name);
      containerStatus = info.status;
      logs = await adapter.logs(info.id, 40).catch(() => []);
    } catch {
      containerStatus = "missing";
    }

    return {
      server,
      runtime: {
        kind: "docker",
        containerName: name,
        containerStatus,
        imageHint:
          this.resolveSkill(skillName)?.metadata.dockerImage ?? cached.dockerImage,
        join,
        logs,
        console: consoleCap ?? undefined,
      },
    };
  }

  /** Tail runtime logs for a server (Docker adapter or native console.log). */
  async tailLogs(
    id: string,
    lines = 80,
  ): Promise<{ status: string; runtime: "docker" | "native"; lines: string[] } | null> {
    const server = await this.get(id);
    if (!server) return null;
    const capped = Math.min(200, Math.max(1, Math.floor(lines)));
    if (server.runtimeMode === "native") {
      return {
        status: server.status,
        runtime: "native",
        lines: await this.readNativeLogTail(server, capped),
      };
    }
    await this.ensureRuntime();
    const adapter = this.adapterFor(id);
    const name = this.containerName(id);
    try {
      const info = await adapter.inspect(name);
      const logs = await adapter.logs(info.id, capped).catch(() => []);
      return { status: server.status, runtime: "docker", lines: logs };
    } catch {
      return { status: server.status, runtime: "docker", lines: [] };
    }
  }

  private runtimeModeForSkill(_skillName: string, containerSupport: string): "native" | "docker" {
    // Colocate skill containerSupport with host capability.
    if (this.config.runtimeMode === "native") return "native";
    if (containerSupport === "none") return "native";
    // full | partial on a docker host → docker
    return "docker";
  }

  async createFromSkill(args: {
    skillName: string;
    serverName?: string;
    nodeId?: string;
  }): Promise<ServerRecord> {
    const skill = loadSkillMetadata(this.config.skillsRoots, args.skillName);
    if (!skill) throw new Error(`unknown_skill: ${args.skillName}`);

    const placement = new PlacementService(this.db, this.config);
    const resolvedNodeId = await placement.resolveNodeId(args.skillName, args.nodeId);

    const id = nanoid();
    const dataPath = path.join(this.config.dataRoot, "servers", id);
    const runtimeMode = this.runtimeModeForSkill(
      skill.metadata.name,
      skill.metadata.containerSupport,
    );
    writeSkillMarkerFromSkill(dataPath, skill, runtimeMode, resolvedNodeId);

    const name = args.serverName ?? skill.metadata.game ?? skill.metadata.name;
    const now = new Date();
    await this.db.insert(servers).values({
      id,
      name,
      game: skill.metadata.game ?? skill.metadata.name,
      nodeId: resolvedNodeId,
      runtimeMode,
      status: "stopped",
      dataPath,
      createdAt: now,
    });

    return (await this.getRaw(id))!;
  }

  /**
   * Start-over in place: stop/remove runtime, wipe server files, re-bind skill.
   * Keeps the same server id (and conversation binding). Clears snapshots + panel.
   */
  async reinstallFromSkill(
    id: string,
    args: { skillName: string; serverName?: string; nodeId?: string },
  ): Promise<ServerRecord> {
    const existing = await this.getRaw(id);
    if (!existing) throw new Error(`unknown_server: ${id}`);

    const skill = loadSkillMetadata(this.config.skillsRoots, args.skillName);
    if (!skill) throw new Error(`unknown_skill: ${args.skillName}`);

    try {
      await this.stop(id);
    } catch {
      // continue wipe even if stop fails
    }

    await this.ensureRuntime().catch(() => undefined);
    const adapter = this.adapters.get(id) ?? this.sharedDocker;
    if (adapter) {
      const name = this.containerName(id);
      await adapter.stop(name).catch(() => undefined);
      await adapter.remove(name).catch(() => undefined);
    }
    this.adapters.delete(id);
    this.processes.delete(id);
    this.stopLogFollow(id);

    try {
      fs.rmSync(existing.dataPath, { recursive: true, force: true });
    } catch {
      // best-effort
    }

    const placement = new PlacementService(this.db, this.config);
    const resolvedNodeId = await placement.resolveNodeId(args.skillName, args.nodeId);
    const runtimeMode = this.runtimeModeForSkill(
      skill.metadata.name,
      skill.metadata.containerSupport,
    );
    writeSkillMarkerFromSkill(existing.dataPath, skill, runtimeMode, resolvedNodeId);

    await this.db.delete(snapshots).where(eq(snapshots.serverId, id));
    await this.db.delete(panelBlocks).where(eq(panelBlocks.serverId, id));

    const name = args.serverName ?? skill.metadata.game ?? skill.metadata.name;
    await this.db
      .update(servers)
      .set({
        name,
        game: skill.metadata.game ?? skill.metadata.name,
        nodeId: resolvedNodeId,
        runtimeMode,
        status: "stopped",
      })
      .where(eq(servers.id, id));

    this.emitStatus(id, "stopped");
    return (await this.getRaw(id))!;
  }

  private isRemoteNode(server: ServerRecord): boolean {
    return !isLocalNodeId(server.nodeId);
  }

  /** Ensure server dirs exist on a remote node (idempotent). */
  private async provisionRemoteDirs(server: ServerRecord): Promise<void> {
    if (!this.isRemoteNode(server) || !server.nodeId) return;
    const rel = nodeServerRelPath(server.id, "game");
    await dispatchNodeJob({
      nodeId: server.nodeId,
      kind: "fs_ensure_dir",
      args: { path: rel },
      localHandler: async () => ({ path: rel, ok: true }),
    });
  }

  private async startRemote(
    server: ServerRecord,
    skillName: string,
    skillMeta: ReturnType<ServerService["readSkillMeta"]>,
  ): Promise<ServerRecord> {
    const id = server.id;
    const nodeId = server.nodeId!;
    await this.provisionRemoteDirs(server);
    // Manage-seeded servers keep game files on the node; don't wipe them with an empty Home tree.
    const nodeAuthoritative = fs.existsSync(
      path.join(server.dataPath, NODE_AUTHORITATIVE_MARKER),
    );
    if (!nodeAuthoritative) {
      await pushServerDirToNode({
        nodeId,
        serverId: id,
        localDataPath: server.dataPath,
      }).catch(() => undefined);
    }
    await this.ensureCloudGateway(server, skillName);

    if (this.wantsNativeRuntime(server, skillName, skillMeta.containerSupport)) {
      const skillEntry = this.resolveSkill(skillName);
      const native = skillEntry?.metadata.native;
      const isWin = skillEntry?.metadata.os.includes("windows") && !skillEntry?.metadata.os.includes("linux")
        ? true
        : undefined;
      // Prefer start script on the node; fall back to metadata binary relative to game/.
      const preferScript = native?.preferStartScript !== false;
      let command: string;
      let args: string[];
      if (preferScript) {
        command = "/bin/bash";
        args = ["start.sh"];
      } else if (native?.binary) {
        command = native.binaryWindows && isWin ? native.binaryWindows : native.binary;
        args = [...(native.args ?? [])];
      } else {
        command = "/bin/bash";
        args = ["start.sh"];
      }
      const cwd = nodeServerRelPath(id, "game");
      const procName = `server-${id}`;
      // Reclaim orphans before start (API/node-agent restarts lose the process id map).
      await dispatchNodeJob({
        nodeId,
        kind: "process_stop",
        args: {
          id: this.processes.get(id) ?? "",
          name: procName,
          cwd,
        },
        timeoutMs: 60_000,
        localHandler: async () => ({ ok: true }),
      }).catch(() => undefined);
      this.processes.delete(id);
      // Ensure RCON credentials (discover/patch on node when authoritative).
      await this.resolveRconConfig(server, skillName).catch(() => undefined);
      const info = await dispatchNodeJob({
        nodeId,
        kind: "process_start",
        args: {
          name: procName,
          command,
          args,
          cwd,
          env: { PLAYON_SERVER_ID: id, ...(native?.env ?? {}) },
          serverId: id,
          logRel: this.consoleLogRel(id),
        },
        timeoutMs: 60_000,
        localHandler: async () => {
          throw new Error("remote_only");
        },
      });
      this.processes.set(id, info.id);
      await this.db.update(servers).set({ status: "running" }).where(eq(servers.id, id));
      this.emitStatus(id, "running");
      return (await this.getRaw(id))!;
    }

    const docker = this.dockerSpecFromSkill(skillName, skillMeta);
    if (!docker) {
      throw new Error(
        `no_container_image: skill "${skillName || server.game || "unknown"}" has containerSupport but no dockerImage in metadata.`,
      );
    }
    const gamePort = this.gamePortForSkill(skillName, server.game);
    const rcon = await this.resolveRconConfig(server, skillName);
    const rconPort = rcon?.port ?? this.rconPortForSkill(skillName, server.game);
    const env: Record<string, string> = { ...docker.env };
    if (this.wantsMcRcon(skillName)) {
      env.ENABLE_RCON = env.ENABLE_RCON ?? "true";
      env.RCON_PORT = String(rconPort);
      env.RCON_PASSWORD = rcon?.password ?? generateRconPassword();
    }
    const name = this.containerName(id);
    const portBindings =
      docker.ports.length > 0
        ? docker.ports
            .filter((p) => p.default)
            .map((p) => ({
              host: p.default!,
              container: p.default!,
              protocol: p.protocol,
            }))
        : [{ host: gamePort, container: gamePort, protocol: "tcp" as const }];

    let containerId = name;
    try {
      const info = await dispatchNodeJob({
        nodeId,
        kind: "container_inspect",
        args: { id: name },
        localHandler: async () => {
          throw new Error("remote_only");
        },
      });
      containerId = info.id;
    } catch {
      const created = await dispatchNodeJob({
        nodeId,
        kind: "container_create",
        args: {
          name,
          image: docker.image,
          env,
          ports: portBindings,
          binds: [
            {
              hostPath: nodeServerRelPath(id, "game"),
              containerPath: docker.dataMount,
            },
          ],
        },
        timeoutMs: 180_000,
        localHandler: async () => {
          throw new Error("remote_only");
        },
      });
      containerId = created.id;
    }
    await dispatchNodeJob({
      nodeId,
      kind: "container_start",
      args: { id: containerId, serverId: id },
      localHandler: async () => {
        throw new Error("remote_only");
      },
    });
    await this.db.update(servers).set({ status: "running" }).where(eq(servers.id, id));
    this.emitStatus(id, "running");
    return (await this.getRaw(id))!;
  }

  async start(id: string): Promise<ServerRecord> {
    const server = await this.getRaw(id);
    if (!server) throw new Error(`unknown_server: ${id}`);

    const skillMeta = this.readSkillMeta(server.dataPath);
    const skillName = skillMeta.skillName || this.readSkillName(server.dataPath);
    await this.db.update(servers).set({ status: "starting" }).where(eq(servers.id, id));
    this.emitStatus(id, "starting");

    try {
      if (this.isRemoteNode(server)) {
        return await this.startRemote(server, skillName, skillMeta);
      }

      await this.ensureRuntime();
      if (this.wantsNativeRuntime(server, skillName, skillMeta.containerSupport)) {
        if (!this.sharedProcess) throw new Error("runtime_not_ready");
        const processSupervisor = this.sharedProcess;
        const existing = this.processes.get(id);
        if (existing) {
          await processSupervisor.stop(existing).catch(() => undefined);
        }
        const gameDir = path.join(server.dataPath, "game");
        const skillEntry = this.resolveSkill(skillName);
        const launch = resolveNativeLaunch({
          skillName,
          game: server.game,
          gameDir,
          metadata: skillEntry?.metadata,
        });
        if (!launch) {
          const hint = skillEntry?.metadata.steamAppId
            ? ` Run steamcmd_app_update with appId ${skillEntry.metadata.steamAppId}, then ensure start.sh or native.binary exists.`
            : " Add start.sh / start.bat or set skill metadata native.binary.";
          throw new Error(
            `native_binaries_missing: skill "${skillName}" has no startable process in game/.${hint}`,
          );
        }
        this.ensureRconConfig(server, skillName);
        const logFile = this.consoleLogAbs(server.dataPath);
        const info = await processSupervisor.start({
          name: `server-${id}`,
          command: launch.command,
          args: launch.args,
          cwd: gameDir,
          env: { PLAYON_SERVER_ID: id, ...launch.env },
          logFile,
        });
        this.processes.set(id, info.id);
        this.beginFileLogFollow(id, logFile);
        await this.db.update(servers).set({ status: "running" }).where(eq(servers.id, id));
        this.emitStatus(id, "running");
        return (await this.getRaw(id))!;
      }

      const handle = await this.openRuntime(server);
      const { id: containerId } = await handle.start();

      await this.db.update(servers).set({ status: "running" }).where(eq(servers.id, id));
      this.emitStatus(id, "running");
      await this.beginLogFollow(id, containerId);
      return (await this.getRaw(id))!;
    } catch (err) {
      await this.db.update(servers).set({ status: "error" }).where(eq(servers.id, id));
      this.emitStatus(id, "error");
      throw err;
    }
  }

  async restart(id: string): Promise<ServerRecord> {
    await this.stop(id);
    return this.start(id);
  }

  async stop(id: string): Promise<ServerRecord> {
    const server = await this.getRaw(id);
    if (!server) throw new Error(`unknown_server: ${id}`);

    await this.db.update(servers).set({ status: "stopping" }).where(eq(servers.id, id));
    this.emitStatus(id, "stopping");
    this.stopLogFollow(id);
    await this.gateway?.releaseServer(id).catch(() => undefined);

    if (this.isRemoteNode(server) && server.nodeId) {
      const processId = this.processes.get(id);
      // Always pass cwd/name so the node can kill orphans even when the tracked id
      // was lost (node-agent restart / API restart).
      await dispatchNodeJob({
        nodeId: server.nodeId,
        kind: "process_stop",
        args: {
          id: processId ?? "",
          name: `server-${id}`,
          cwd: nodeServerRelPath(id, "game"),
          serverId: id,
        },
        localHandler: async () => ({ ok: true }),
      }).catch(() => undefined);
      this.processes.delete(id);
      await dispatchNodeJob({
        nodeId: server.nodeId,
        kind: "container_stop",
        args: { id: this.containerName(id), serverId: id },
        localHandler: async () => ({ ok: true }),
      }).catch(() => undefined);
    } else {
      await this.ensureRuntime();
      const processId = this.processes.get(id);
      if (processId && this.sharedProcess) {
        await this.sharedProcess.stop(processId).catch(() => undefined);
        this.processes.delete(id);
      }
      if (server.runtimeMode === "native") {
        this.killNativeGameProcesses(server.dataPath);
      }

      if (this.usesRuntimeHandle(server)) {
        await this.openRuntime(server)
          .then((handle) => handle.stop())
          .catch(() => undefined);
      } else {
        const adapter = this.adapters.get(id) ?? this.sharedDocker;
        if (adapter) {
          await adapter.stop(this.containerName(id)).catch(() => undefined);
        }
      }
    }

    await this.db.update(servers).set({ status: "stopped" }).where(eq(servers.id, id));
    this.emitStatus(id, "stopped");
    return (await this.getRaw(id))!;
  }

  /**
   * Stop runtime, remove Docker container, wipe data dir + DB rows.
   * Leaves no server-scoped panel blocks, conversations, snapshots, or agent progress.
   */
  async remove(id: string): Promise<{ id: string; name: string }> {
    const server = await this.getRaw(id);
    if (!server) throw new Error(`unknown_server: ${id}`);

    try {
      await this.stop(id);
    } catch {
      // continue teardown even if stop fails
    }

    await this.ensureRuntime().catch(() => undefined);
    const adapter = this.adapters.get(id) ?? this.sharedDocker;
    if (adapter) {
      const name = this.containerName(id);
      await adapter.stop(name).catch(() => undefined);
      await adapter.remove(name).catch(() => undefined);
    }
    this.adapters.delete(id);
    this.processes.delete(id);
    this.stopLogFollow(id);

    const convRows = await this.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.serverId, id));
    const convIds = convRows.map((r) => r.id);
    if (convIds.length) {
      await this.db.delete(messages).where(inArray(messages.conversationId, convIds));
      await this.db
        .delete(toolInvocations)
        .where(inArray(toolInvocations.conversationId, convIds));
      await this.db.delete(conversations).where(eq(conversations.serverId, id));
    }

    await this.db.delete(snapshots).where(eq(snapshots.serverId, id));
    await this.db.delete(panelBlocks).where(eq(panelBlocks.serverId, id));
    const watcherRows = await this.db
      .select({ id: watchers.id })
      .from(watchers)
      .where(eq(watchers.serverId, id));
    if (watcherRows.length) {
      const watcherIds = watcherRows.map((r) => r.id);
      await this.db.delete(watcherRuns).where(inArray(watcherRuns.watcherId, watcherIds));
      await this.db.delete(watchers).where(eq(watchers.serverId, id));
    }
    await this.db.delete(servers).where(eq(servers.id, id));

    try {
      fs.rmSync(server.dataPath, { recursive: true, force: true });
    } catch {
      // best-effort disk wipe
    }

    this.events?.publish({ type: "server.status", serverId: id, status: "stopped" });
    return { id: server.id, name: server.name };
  }
}
