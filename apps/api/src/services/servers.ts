import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import {
  createRuntime,
  listHostContainers,
  localDockerTransport,
  localNativeTransport,
  openServerRuntime,
  parseDockerHostPortBindError,
  probeUdpListen,
  remoteDockerTransport,
  remoteNativeTransport,
  rewriteDockerPortBindError,
  type ContainerJobDispatch,
  type DockerAdapter,
  type DockerRuntimeTransport,
  type HostContainer,
  type LogFollowHandle,
  type NativeProcessIdentity,
  type NativeRuntimeTransport,
  type NodeTextReadDispatch,
  type ProcessJobDispatch,
  type ProcessSupervisor,
  type RuntimeLocality,
  type RuntimeMode,
  type ServerContainerSpec,
  type ServerProcessSpec,
  type ServerRuntimeHandle,
  type ServerRuntimeStatus,
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
import { pushServerDirToNode } from "./node-sync.js";
import {
  openServerFileStore,
  type FileStoreLocalityMode,
  type ServerFileStore,
} from "./server-file-store.js";
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
import {
  nativeGamePort,
  nativeRconPort,
  resolveNativeArgs,
  resolveNativeLaunch,
} from "./native-launch.js";
import { ServerAdoptionService } from "./server-adoption.js";
import {
  ensureSkillGameOverlay,
  listSkillGameOverlayFiles,
} from "./skill-game-overlay.js";
import {
  readSkillMarker,
} from "./skill-marker.js";
import { loadSkillMetadata, type SkillEntry } from "./skills.js";
import {
  AdminDialectSchema,
  DEFAULT_PORT_DEAD_GRACE_MS,
  decideReconcileInstance,
  decideStartInstance,
  deriveNodePresence,
  instanceGamePortFromIniTexts,
  isLocalNodeId,
  isLoopbackJoinHost,
  isWslNodeId,
  lanPublishPortsForSkill,
  NODE_AUTHORITATIVE_MARKER,
  wslParentNodeId,
  type AdminDialect,
  type HostPortsBound,
  type SkillMetadata,
} from "@playon/shared";
import { listLocalIniRelPaths } from "./instance-game-port-files.js";
import { dispatchNodeJob, nodeServerRelPath } from "./node-runtime.js";
import { checkNodeLoopbackTcp } from "./node-loopback-tcp.js";
import { ensureWslLanPublish, releaseWslLanPublish } from "./wsl-lan-publish.js";

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

function probeLocalTcpPort(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (open: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

export class ServerService {
  private readonly adapters = new Map<string, DockerAdapter>();
  private readonly logFollows = new Map<string, LogFollowHandle>();
  private sharedDocker: DockerAdapter | null = null;
  private sharedProcess: ProcessSupervisor | null = null;
  private adoption: ServerAdoptionService | null = null;
  private readonly instanceStartedAt = new Map<string, number>();
  private instanceStartedHydrated = false;
  private readonly crashRestarts = new Set<string>();
  private readonly reconciling = new Set<string>();

  /**
   * Unit tests assign this so start/reconcile do not probe the CI host.
   * Production leaves it null and probes advertised game ports on the host.
   */
  portsBoundOverride: ((server: ServerRecord) => Promise<HostPortsBound>) | null = null;
  /**
   * Unit tests assign this so bind-error rewrite does not call a live daemon.
   * Production leaves it null and lists host containers read-only.
   */
  hostPortHoldersOverride: (() => Promise<HostContainer[]>) | null = null;
  /** After this, a running process with unbound advertised ports is dead. */
  portDeadGraceMs = DEFAULT_PORT_DEAD_GRACE_MS;
  /** One clean auto-restart after a port-dead crash if the user did not stop. */
  autoRestartOnDeadInstance = true;

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

  /** Wired by ControlPlane; tests may omit and get a lazy fallback. */
  bindAdoption(adoption: ServerAdoptionService): void {
    this.adoption = adoption;
  }

  private adoptionService(): ServerAdoptionService {
    return this.adoption ?? new ServerAdoptionService(this.db, this.config, this);
  }

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

  /** Home follow via Handle; remote is a no-op (node-agent already streams). */
  private async beginRuntimeLogFollow(
    serverId: string,
    handle: ServerRuntimeHandle,
  ): Promise<void> {
    this.stopLogFollow(serverId);
    if (handle.locality === "remote") return;
    try {
      const follow = await handle.followLogs((line) => {
        this.events?.publish({ type: "server.log", serverId, line });
      });
      this.logFollows.set(serverId, follow);
    } catch {
      // follow is best-effort; REST detail still has snapshots
    }
  }

  /**
   * Log tail from the server's own runtime, whichever quadrant it lives in.
   * A runtime that cannot answer has no lines to give — never an error page.
   */
  private async logTail(server: ServerRecord, lines: number): Promise<string[]> {
    try {
      const handle = await this.openRuntime(server);
      return await handle.logs(lines);
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

  private openFiles(
    server: ServerRecord,
    opts?: { locality?: FileStoreLocalityMode },
  ): ServerFileStore {
    return openServerFileStore(server, {}, opts);
  }

  /** Only production choke point for server data-dir I/O. */
  async files(
    serverId: string,
    opts?: { locality?: FileStoreLocalityMode },
  ): Promise<ServerFileStore> {
    const server = await this.getRaw(serverId);
    if (!server) throw new Error(`unknown_server: ${serverId}`);
    return this.openFiles(server, opts);
  }

  private async syncRconJsonToNode(server: ServerRecord, endpoint: RconEndpoint): Promise<void> {
    if (!server.nodeId || isLocalNodeId(server.nodeId)) return;
    const body = JSON.stringify(
      { host: "127.0.0.1", port: endpoint.port, password: endpoint.password },
      null,
      2,
    );
    writeRconConfig(server.dataPath, endpoint);
    await this.openFiles(server, { locality: "remote" }).writeText("rcon.json", body);
  }

  private async readServerText(server: ServerRecord, relPath: string): Promise<string | null> {
    try {
      const result = await this.openFiles(server).readText(relPath, { maxBytes: 256_000 });
      return result.content;
    } catch {
      return null;
    }
  }

  private async writeServerText(
    server: ServerRecord,
    relPath: string,
    content: string,
  ): Promise<boolean> {
    try {
      await this.openFiles(server).writeText(relPath, content);
      return true;
    } catch {
      return false;
    }
  }

  private async listServerDir(
    server: ServerRecord,
    relPath: string,
  ): Promise<Array<{ name: string; type: "file" | "dir" }>> {
    try {
      return await this.openFiles(server).list(relPath);
    } catch {
      return [];
    }
  }

  /** Walk server jail for *.ini / *.cfg candidates (bounded). */
  private async collectNodeConfigCandidates(server: ServerRecord): Promise<string[]> {
    const files: string[] = [];
    const skip = new Set(["node_modules", ".git", "steamapps", "logs", "Workshop"]);
    const visit = async (rel: string, depth: number): Promise<void> => {
      if (files.length >= 40 || depth > 4) return;
      const entries = await this.listServerDir(server, rel);
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
      const text = await this.readServerText(server, rel);
      if (!text) continue;
      const parsed = parseSourceRconText(text);
      if (parsed) return { host: "127.0.0.1", ...parsed };
    }
    return null;
  }

  private async discoverMcRconOnNode(server: ServerRecord): Promise<RconEndpoint | null> {
    const text = await this.readServerText(server, "game/server.properties");
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
      const text = await this.readServerText(server, rel);
      if (!text) continue;
      const next = /\.ini$/i.test(rel)
        ? patchSourceRconIniText(text, endpoint)
        : /server\.cfg$/i.test(rel)
          ? patchSourceRconCfgText(text, endpoint)
          : null;
      if (next == null) continue;
      if (await this.writeServerText(server, rel, next)) patched = true;
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
      const nodeJson = await this.readServerText(server, "rcon.json");
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

  /** Game-port protocol from the skill. Defaults to tcp when undeclared. */
  gamePortProtocolForSkill(skillName: string): "tcp" | "udp" {
    const skill = this.resolveSkill(skillName);
    const hit = skill?.metadata.ports.find((p) => p.name === "game");
    return hit?.protocol === "udp" ? "udp" : "tcp";
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

    // stdin — the server's own runtime answers, in whichever quadrant it lives.
    if (dialect === "stdin") {
      try {
        const handle = await this.openRuntime(server);
        // A runtime with no console at all is a different answer than one that
        // has a console but is not up yet.
        if (!handle.canWriteStdin) return { input: "unsupported", dialect };
        const status = await handle.status();
        return { input: status.state === "running" ? "ready" : "unavailable", dialect };
      } catch {
        return { input: "unavailable", dialect };
      }
    }

    return { input: "unsupported", dialect };
  }

  /** Write a console line to the server's runtime stdin (any mode × locality). */
  async writeStdin(serverId: string, line: string): Promise<void> {
    await (await this.runtime(serverId)).writeStdin(line);
  }

  private readSkillMeta(dataPath: string): {
    skillName: string;
    containerSupport?: string;
    dockerImage?: string;
    dockerEnv?: Record<string, string>;
    dockerArgs?: string[];
    dockerDataMount?: string;
    dockerTty?: boolean;
    dockerIsolation?: "process" | "hyperv";
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
      dockerArgs: raw.dockerArgs,
      dockerDataMount: raw.dockerDataMount,
      dockerTty: raw.dockerTty,
      dockerIsolation: raw.dockerIsolation,
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
    cmd: string[];
    dataMount: string;
    tty?: boolean;
    isolation?: "process" | "hyperv";
    ports: SkillMetadata["ports"];
  } | null {
    const live = this.resolveSkill(skillName)?.metadata;
    const image = live?.dockerImage || cached.dockerImage;
    if (!image) return null;
    const tty = live?.dockerTty ?? cached.dockerTty;
    const isolation = live?.dockerIsolation ?? cached.dockerIsolation;
    return {
      image,
      env: { ...(live?.dockerEnv ?? cached.dockerEnv ?? {}) },
      cmd: [...(live?.dockerArgs ?? cached.dockerArgs ?? [])],
      // Sentinel "none" skips the game/ bind (some images ship defaults under the
      // data path that empty host binds would hide — e.g. Trackmania UserData).
      dataMount: live?.dockerDataMount || cached.dockerDataMount || "/data",
      ...(tty != null ? { tty } : {}),
      ...(isolation ? { isolation } : {}),
      ports: live?.ports ?? [],
    };
  }

  private wantsNativeRuntime(
    server: ServerRecord,
    _skillName: string,
    containerSupport?: string,
  ): boolean {
    if (server.runtimeMode === "native") return true;
    // containerSupport=none → OS process; full/partial → docker when the node has docker.
    if (containerSupport === "none") return true;
    // Home PLAYON_RUNTIME=native only forces process for servers that run on Home.
    // Remote Windows nodes default to native at install but can still host Windows containers.
    if (!this.isRemoteNode(server) && this.config.runtimeMode === "native") return true;
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

  private async containerSpec(
    server: ServerRecord,
    skillName: string,
    skillMeta: ReturnType<ServerService["readSkillMeta"]>,
    locality: RuntimeLocality,
  ): Promise<ServerContainerSpec> {
    const docker = this.dockerSpecFromSkill(skillName, skillMeta);
    if (!docker) {
      throw new Error(
        `no_container_image: skill "${skillName || server.game || "unknown"}" has containerSupport but no dockerImage in metadata. Add dockerImage to the skill or use a native skill.`,
      );
    }
    const gamePort = this.gamePortForSkill(skillName, server.game);
    // Remote trees may be node-authoritative, so credentials are discovered on the node.
    const rcon =
      locality === "remote"
        ? await this.resolveRconConfig(server, skillName)
        : this.ensureRconConfig(server, skillName);
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

    const skipBind = docker.dataMount === "none" || docker.dataMount === "-";
    return {
      image: docker.image,
      env,
      ...(docker.cmd.length ? { cmd: docker.cmd } : {}),
      ports,
      binds: skipBind
        ? []
        : [
            {
              // The node resolves a jail-relative host path under its own data root.
              hostPath:
                locality === "remote"
                  ? nodeServerRelPath(server.id, "game")
                  : path.join(server.dataPath, "game"),
              containerPath: docker.dataMount,
            },
          ],
      ...(docker.tty != null ? { tty: docker.tty } : {}),
      ...(docker.isolation ? { isolation: docker.isolation } : {}),
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
    const native = mode === "native";
    return openServerRuntime(
      { serverId: server.id, mode, locality },
      {
        containerName: this.containerName(server.id),
        docker: native ? undefined : await this.dockerTransport(server, locality),
        resolveContainerSpec: () =>
          this.containerSpec(server, skillName, skillMeta, locality),
        native: native ? await this.nativeTransport(server, locality) : undefined,
        processIdentity: this.processIdentity(server, locality),
        resolveProcessSpec: () => this.processSpec(server, skillName, locality),
      },
    );
  }

  private async nativeTransport(
    server: ServerRecord,
    locality: RuntimeLocality,
  ): Promise<NativeRuntimeTransport> {
    if (locality === "local") {
      await this.ensureRuntime();
      if (!this.sharedProcess) throw new Error("runtime_not_ready");
      return localNativeTransport(this.sharedProcess);
    }
    const nodeId = server.nodeId!;
    const dispatch: ProcessJobDispatch = (kind, args, opts) =>
      dispatchNodeJob({
        nodeId,
        kind,
        args,
        timeoutMs: opts?.timeoutMs,
        localHandler: () => {
          throw new Error("remote_only");
        },
      });
    // The node's console is a file, so tailing it is an fs job rather than a process one.
    const readText: NodeTextReadDispatch = (args, opts) =>
      dispatchNodeJob({
        nodeId,
        kind: "fs_read_text",
        args,
        timeoutMs: opts?.timeoutMs,
        localHandler: () => {
          throw new Error("remote_only");
        },
      });
    return remoteNativeTransport(dispatch, { serverId: server.id, readText });
  }

  /** Name/cwd the native runtime re-resolves from; the control plane stores no process id. */
  private processIdentity(
    server: ServerRecord,
    locality: RuntimeLocality,
  ): NativeProcessIdentity {
    const remote = locality === "remote";
    return {
      name: `server-${server.id}`,
      // A node resolves paths under its own data root, so remote identity is jail-relative.
      cwd: remote
        ? nodeServerRelPath(server.id, "game")
        : path.join(server.dataPath, "game"),
      logFile: remote ? this.consoleLogRel(server.id) : this.consoleLogAbs(server.dataPath),
    };
  }

  private async processSpec(
    server: ServerRecord,
    skillName: string,
    locality: RuntimeLocality,
  ): Promise<ServerProcessSpec> {
    if (locality === "remote") return this.remoteProcessSpec(server, skillName);
    const gameDir = this.processIdentity(server, "local").cwd;
    const skillEntry = this.resolveSkill(skillName);
    if (skillEntry?.path) {
      ensureSkillGameOverlay(skillEntry.path, gameDir);
    }
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
    const env: Record<string, string> = { PLAYON_SERVER_ID: server.id, ...launch.env };
    const marker = readSkillMarker(server.dataPath);
    if (marker?.managedFrom) {
      env.PLAYON_MANAGED_FROM = marker.managedFrom;
    }
    return {
      command: launch.command,
      args: launch.args,
      env,
      logFile: this.consoleLogAbs(server.dataPath),
      keepStdin: skillEntry?.metadata.adminDialect === "stdin",
    };
  }

  /**
   * Launch for a game dir Home cannot see: only the node knows what is on its
   * disk, so the spec comes from skill metadata and every path stays jail-relative.
   */
  /**
   * Push skill `files/` onto a remote node game/ jail (skip existing).
   * SteamCMD marks installs node-authoritative, so Home cannot rely on pushServerDirToNode.
   */
  private async pushSkillGameOverlayRemote(
    server: ServerRecord,
    skillPath: string,
  ): Promise<void> {
    const files = listSkillGameOverlayFiles(skillPath);
    if (!files.length) return;
    const store = this.openFiles(server, { locality: "remote" });
    for (const file of files) {
      const dest = `game/${file.relPath}`;
      const parent = dest.includes("/") ? dest.slice(0, dest.lastIndexOf("/")) : "game";
      const base = dest.slice(dest.lastIndexOf("/") + 1);
      try {
        const entries = await store.list(parent || "game");
        if (entries.some((e) => e.name === base)) continue;
      } catch {
        /* parent missing — writeBytes/ensure will create */
      }
      await store.writeBytes(dest, fs.readFileSync(file.absPath));
    }
  }

  private async remoteProcessSpec(
    server: ServerRecord,
    skillName: string,
  ): Promise<ServerProcessSpec> {
    const skillEntry = this.resolveSkill(skillName);
    if (skillEntry?.path) {
      await this.pushSkillGameOverlayRemote(server, skillEntry.path).catch(() => undefined);
    }
    const metadata = skillEntry?.metadata;
    const native = metadata?.native;
    const node = await this.nodeRow(server.nodeId);
    const nodeOs = node?.os === "windows" ? "windows" : "linux";
    const windowsOnly =
      Array.isArray(metadata?.os) &&
      metadata.os.includes("windows") &&
      !metadata.os.includes("linux");
    const binaryRaw =
      (nodeOs === "windows" && (native?.binaryWindows || native?.binary)) ||
      (windowsOnly && native?.binaryWindows) ||
      native?.binary;
    const binary = binaryRaw ? String(binaryRaw).replace(/\\/g, "/") : undefined;

    // Credentials may be node-authoritative, so discover/patch them there first.
    await this.resolveRconConfig(server, skillName).catch(() => undefined);

    const keepStdin = metadata?.adminDialect === "stdin";
    const nativeArgs = resolveNativeArgs({
      args: [...(native?.args ?? [])],
      skillName,
    });
    
    // Read managedFrom from skill marker (may be node-authoritative)
    const marker = readSkillMarker(server.dataPath);
    const baseEnv: Record<string, string> = { PLAYON_SERVER_ID: server.id, ...(native?.env ?? {}) };
    if (marker?.managedFrom) {
      baseEnv.PLAYON_MANAGED_FROM = marker.managedFrom;
    }
    
    // Windows nodes have no /bin/bash start.sh contract — PE binary, or skill start.bat / start.ps1.
    if (nodeOs === "windows") {
      const preferScript = native?.preferStartScript !== false;
      const overlayBat =
        preferScript && skillEntry?.path
          ? listSkillGameOverlayFiles(skillEntry.path).find(
              (f) => f.relPath === "start.bat" || f.relPath === "run.bat",
            )?.relPath
          : undefined;
      if (overlayBat) {
        // Bare "cmd.exe" fails with spawn ENOENT when the Windows node-agent
        // process has a stripped PATH (lab playon-win-1). Use the absolute
        // System32 path; cwd is still the game jail so `start.bat` resolves.
        return {
          command: "C:\\Windows\\System32\\cmd.exe",
          args: ["/c", overlayBat],
          env: baseEnv,
          logFile: this.consoleLogRel(server.id),
          keepStdin,
        };
      }
      const overlayPs1 =
        preferScript && skillEntry?.path
          ? listSkillGameOverlayFiles(skillEntry.path).find(
              (f) => f.relPath === "start.ps1" || f.relPath === "run.ps1",
            )?.relPath
          : undefined;
      if (overlayPs1) {
        // PowerShell scripts with absolute path to avoid spawn ENOENT on playon-win-1.
        // Standard Windows PowerShell 5.1 location; cwd is the game jail so script resolves.
        return {
          command: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
          args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", overlayPs1],
          env: baseEnv,
          logFile: this.consoleLogRel(server.id),
          keepStdin,
        };
      }
      if (!binary) {
        throw new Error(
          `native_binaries_missing: skill "${skillName}" has no Windows native.binary or start script for remote node`,
        );
      }
      return {
        command: binary,
        args: nativeArgs,
        env: baseEnv,
        logFile: this.consoleLogRel(server.id),
        keepStdin,
      };
    }

    // Linux remote: start.sh is the default contract; binary is the opt-out.
    const useBinary = native?.preferStartScript === false && !!binary;
    return {
      command: useBinary ? binary! : "/bin/bash",
      args: useBinary ? nativeArgs : ["start.sh"],
      env: baseEnv,
      logFile: this.consoleLogRel(server.id),
      keepStdin,
    };
  }

  private async dockerTransport(
    server: ServerRecord,
    locality: RuntimeLocality,
  ): Promise<DockerRuntimeTransport> {
    if (locality === "local") {
      await this.ensureRuntime();
      return localDockerTransport(this.adapterFor(server.id));
    }
    const nodeId = server.nodeId!;
    const dispatch: ContainerJobDispatch = (kind, args, opts) =>
      dispatchNodeJob({
        nodeId,
        kind,
        args,
        timeoutMs: opts?.timeoutMs,
        localHandler: () => {
          throw new Error("remote_only");
        },
      });
    return remoteDockerTransport(dispatch, { serverId: server.id });
  }

  /**
   * Join/probe host for a server:
   * - cloud → Home advertiseHost (LAN gateway)
   * - lan/local with nodes.joinHost → that host
   * - WSL sibling → parent Windows node's joinHost (or advertiseHost)
   * - else → advertiseHost
   */
  async resolveJoinAddress(server: ServerRecord): Promise<string> {
    if (!server.nodeId || isLocalNodeId(server.nodeId)) {
      return this.config.advertiseHost;
    }
    const node = await this.nodeRow(server.nodeId);
    if (!node) return this.config.advertiseHost;
    if (node.kind === "cloud") return this.config.advertiseHost;

    // WSL sibling: resolve parent Windows node's joinHost
    const parentNodeId = wslParentNodeId(server.nodeId);
    if (parentNodeId) {
      const parentNode = await this.nodeRow(parentNodeId);
      if (parentNode) {
        const parentJoinHost = parentNode.joinHost?.trim();
        if (parentJoinHost) return parentJoinHost;
      }
      // Fall back to advertise host if parent has no joinHost
      return this.config.advertiseHost;
    }

    const joinHost = node.joinHost?.trim();
    if (joinHost) return joinHost;
    return this.config.advertiseHost;
  }

  async joinInfoFor(server: ServerRecord): Promise<{ address: string; port: number }> {
    return {
      address: await this.resolveJoinAddress(server),
      port: await this.advertisedGamePort(server),
    };
  }

  /**
   * Port players join / health / reap probe. Instance DefaultPort (or UDPPort)
   * wins; skill metadata default is only the fallback when the jail has none.
   */
  async advertisedGamePort(server: ServerRecord): Promise<number> {
    const fromInstance = await this.readInstanceGamePort(server);
    if (fromInstance != null && fromInstance > 0) return fromInstance;
    return this.gamePortForSkill(this.readSkillName(server.dataPath), server.game);
  }

  private async readInstanceGamePort(server: ServerRecord): Promise<number | null> {
    const rels = await this.instanceIniRelPaths(server);
    if (!rels.length) return null;
    const texts: string[] = [];
    for (const rel of rels) {
      const text = await this.readServerText(server, rel);
      if (text) texts.push(text);
    }
    return instanceGamePortFromIniTexts(texts);
  }

  private async instanceIniRelPaths(server: ServerRecord): Promise<string[]> {
    const local = listLocalIniRelPaths(server.dataPath);
    if (local.length) return local;
    if (!this.isRemoteNode(server)) return [];
    return (await this.collectNodeConfigCandidates(server)).filter((rel) => /\.ini$/i.test(rel));
  }

  private async nodeIsOnline(nodeId: string | null | undefined): Promise<boolean> {
    const node = await this.nodeRow(nodeId);
    return !!node && deriveNodePresence(node.lastSeenAt) === "online";
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

  /**
   * WSL sibling: publish game/RCON/query on the Windows parent LAN IP so
   * resolveJoinAddress (parent join_host) is actually reachable. Syncs an
   * empty WSL join_host from the parent so the advertised path is explicit.
   */
  private async ensureWslParentPublish(server: ServerRecord, skillName: string): Promise<void> {
    if (!server.nodeId || !isWslNodeId(server.nodeId)) return;
    const parentId = wslParentNodeId(server.nodeId);
    if (!parentId) return;
    const parent = await this.nodeRow(parentId);
    const parentJoinHost = parent?.joinHost?.trim() || this.config.advertiseHost;
    await this.syncWslJoinHost(server.nodeId, parentJoinHost);

    const skill = this.resolveSkill(skillName)?.metadata ?? null;
    const extra: number[] = [];
    if (this.wantsAnyRcon(skillName)) extra.push(this.rconPortForSkill(skillName, server.game));
    const ports = lanPublishPortsForSkill(skill, extra);
    if (!ports.length) return;
    await ensureWslLanPublish({
      serverId: server.id,
      wslNodeId: server.nodeId,
      parentJoinHost,
      ports,
    });
  }

  private async syncWslJoinHost(wslNodeId: string, parentJoinHost: string): Promise<void> {
    const host = parentJoinHost.trim();
    if (!host || isLoopbackJoinHost(host)) return;
    const wsl = await this.nodeRow(wslNodeId);
    if (!wsl || wsl.joinHost?.trim()) return;
    await this.db.update(nodes).set({ joinHost: host }).where(eq(nodes.id, wslNodeId));
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

  /**
   * Change only the PlayOn display name. Id, dataPath, ports, runtime, and
   * on-disk world folders stay put — never used to rename native worlds.
   */
  async rename(id: string, name: string): Promise<ServerRecord | null> {
    const existing = await this.getRaw(id);
    if (!existing) return null;
    await this.db.update(servers).set({ name }).where(eq(servers.id, id));
    return (await this.getRaw(id))!;
  }

  /** Runtime status from the handle, or null when the runtime could not answer at all. */
  private async runtimeStatus(server: ServerRecord): Promise<ServerRuntimeStatus | null> {
    try {
      return await (await this.openRuntime(server)).status();
    } catch {
      // Home owns its own runtime, so a local one that cannot even open is running
      // nothing. A node's silence is only silence — never read it as stopped.
      return this.isRemoteNode(server) ? null : { state: "missing" };
    }
  }

  /**
   * Host-local advertised game-port bind. null = unknown / no port / probe
   * unavailable. Never uses the Home join host — WSL publish gaps are not dead
   * processes (see #877 / #843).
   */
  async hostGamePortsBound(server: ServerRecord): Promise<HostPortsBound> {
    if (this.portsBoundOverride) return this.portsBoundOverride(server);
    if (process.env.PLAYON_SKIP_HOST_PORT_PROBE === "1") return null;
    return this.probeAdvertisedGamePorts(server);
  }

  /**
   * Host-local advertised game ports for health. Alive + unbound after grace
   * is failed (not running). `starting` / still-in-grace is still binding.
   * Unknown probe (`null`) does not invent a failure. Join-path stay separate.
   */
  async evaluateHostPortsHealth(server: ServerRecord): Promise<{
    ok: boolean;
    detail: string;
  }> {
    if (server.status === "starting" || server.status === "creating") {
      return { ok: true, detail: "still binding advertised game ports" };
    }
    if (server.status !== "running") {
      return { ok: true, detail: `host port check skipped while ${server.status}` };
    }
    const bound = await this.hostGamePortsBound(server);
    if (bound === true) {
      return { ok: true, detail: "advertised game ports bound on host" };
    }
    if (bound !== false) {
      return { ok: true, detail: "host port probe skipped or unknown" };
    }
    await this.hydrateInstanceStartedAt();
    const startedAgo = this.startedAgoMs(server.id);
    if (startedAgo != null && startedAgo < this.portDeadGraceMs) {
      return { ok: true, detail: "advertised game ports still binding (grace)" };
    }
    return { ok: false, detail: "advertised game ports unbound on host" };
  }

  private async probeAdvertisedGamePorts(server: ServerRecord): Promise<HostPortsBound> {
    const skillName = this.readSkillName(server.dataPath);
    const port = await this.advertisedGamePort(server);
    if (!port) return null;
    const proto = this.gamePortProtocolForSkill(skillName);
    try {
      if (this.isRemoteNode(server)) {
        if (!(await this.nodeIsOnline(server.nodeId))) return null;
        if (proto === "udp") {
          const result = await dispatchNodeJob({
            nodeId: server.nodeId,
            kind: "net_udp_listen",
            args: { port },
            timeoutMs: 5_000,
            localHandler: () => probeUdpListen(port),
          });
          return result.listening;
        }
        const loopback = await checkNodeLoopbackTcp(server.nodeId!, port);
        if (loopback.unavailable) return null;
        return loopback.state === "open";
      }
      if (proto === "udp") {
        const result = probeUdpListen(port);
        if (result.probe === "unavailable") return null;
        return result.listening;
      }
      return probeLocalTcpPort(port);
    } catch {
      return null;
    }
  }

  /** Sweep host processes under this server's tree (game/ + home/), any mode. */
  private async reapNativeServerTree(server: ServerRecord): Promise<void> {
    const locality: RuntimeLocality = this.isRemoteNode(server) ? "remote" : "local";
    const identity = this.processIdentity(server, locality);
    if (locality === "remote") {
      await dispatchNodeJob({
        nodeId: server.nodeId,
        kind: "process_stop",
        args: { id: "", name: identity.name, cwd: identity.cwd, serverId: server.id },
        timeoutMs: 60_000,
        localHandler: async () => ({ ok: true }),
      });
      return;
    }
    await this.ensureRuntime().catch(() => undefined);
    await this.sharedProcess?.reclaim?.(identity.name, identity.cwd);
  }

  private async hydrateInstanceStartedAt(): Promise<void> {
    if (this.instanceStartedHydrated) return;
    this.instanceStartedHydrated = true;
    const rows = await this.db
      .select({ id: servers.id, at: servers.instanceStartedAt })
      .from(servers);
    for (const row of rows) {
      if (row.at && !this.instanceStartedAt.has(row.id)) {
        this.instanceStartedAt.set(row.id, row.at.getTime());
      }
    }
  }

  private async markInstanceStarted(serverId: string): Promise<void> {
    const at = Date.now();
    this.instanceStartedAt.set(serverId, at);
    await this.db
      .update(servers)
      .set({ instanceStartedAt: new Date(at) })
      .where(eq(servers.id, serverId));
  }

  private async clearInstanceStarted(serverId: string): Promise<void> {
    this.instanceStartedAt.delete(serverId);
    await this.db
      .update(servers)
      .set({ instanceStartedAt: null })
      .where(eq(servers.id, serverId));
  }

  /** `null` = no persisted start (first see). Never invent “just now”. */
  private startedAgoMs(serverId: string): number | null {
    const at = this.instanceStartedAt.get(serverId);
    if (at == null) return null;
    return Date.now() - at;
  }

  private async reapDeadInstance(server: ServerRecord): Promise<void> {
    const handle = await this.openRuntime(server).catch(() => null);
    await handle?.stop().catch(() => undefined);
    await this.reapNativeServerTree(server).catch(() => undefined);

    const mayRestart =
      this.autoRestartOnDeadInstance &&
      server.status === "running" &&
      !this.crashRestarts.has(server.id);
    if (mayRestart) {
      this.crashRestarts.add(server.id);
      try {
        await this.start(server.id);
        return;
      } catch {
        // fall through to error
      }
    }

    await this.db.update(servers).set({ status: "error" }).where(eq(servers.id, server.id));
    this.emitStatus(server.id, "error");
  }

  private async reconcileStatus(server: ServerRecord): Promise<void> {
    // A node we cannot reach cannot answer for its runtime: asking only parks
    // list()/get() behind a job that will time out, and silence is not "stopped".
    if (this.isRemoteNode(server) && !(await this.nodeIsOnline(server.nodeId))) return;
    if (this.reconciling.has(server.id)) return;
    this.reconciling.add(server.id);

    try {
      const status = await this.runtimeStatus(server);
      if (status === null) return;

      // Only docker reports "missing" (no container at all); a status the runtime
      // never created must not overwrite a create/error state.
      if (status.state === "missing") {
        if (server.status === "running" || server.status === "starting") {
          await this.db.update(servers).set({ status: "stopped" }).where(eq(servers.id, server.id));
          this.emitStatus(server.id, "stopped");
        }
        return;
      }

      await this.hydrateInstanceStartedAt();
      const processAlive = status.state === "running";
      const hostPortsBound = processAlive ? await this.hostGamePortsBound(server) : null;
      const decision = decideReconcileInstance({
        processAlive,
        hostPortsBound,
        dbStatus: server.status,
        startedAgoMs: this.startedAgoMs(server.id),
        graceMs: this.portDeadGraceMs,
      });

      if (decision === "keep") return;

      if (decision === "dead") {
        await this.reapDeadInstance(server);
        return;
      }

      if (decision === "running") this.crashRestarts.delete(server.id);
      if (decision !== server.status) {
        await this.db.update(servers).set({ status: decision }).where(eq(servers.id, server.id));
        this.emitStatus(server.id, decision);
      }
    } finally {
      this.reconciling.delete(server.id);
    }
  }

  async detail(id: string): Promise<ServerDetail | null> {
    const server = await this.get(id);
    if (!server) return null;

    const { mode, skillName, skillMeta } = this.runtimeTarget(server);
    const join = await this.joinInfoFor(server);
    const consoleCap = await this.consoleCapability(id);
    const logs = await this.logTail(server, 40);

    if (mode === "native") {
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

    // The container status behind the runtime state: docker's own word for it,
    // and "missing" when the node has no container under this name at all.
    const status = await this.runtimeStatus(server);
    return {
      server,
      runtime: {
        kind: "docker",
        containerName: this.containerName(id),
        containerStatus: status?.detail ?? status?.state ?? "missing",
        imageHint:
          this.resolveSkill(skillName)?.metadata.dockerImage ?? skillMeta.dockerImage,
        join,
        logs,
        console: consoleCap ?? undefined,
      },
    };
  }

  /** Tail runtime logs for a server, in whichever quadrant its runtime lives. */
  async tailLogs(
    id: string,
    lines = 80,
  ): Promise<{ status: string; runtime: "docker" | "native"; lines: string[] } | null> {
    const server = await this.get(id);
    if (!server) return null;
    const capped = Math.min(200, Math.max(1, Math.floor(lines)));
    return {
      status: server.status,
      runtime: this.runtimeTarget(server).mode,
      lines: await this.logTail(server, capped),
    };
  }

  async createFromSkill(args: {
    skillName: string;
    serverName?: string;
    nodeId?: string;
  }): Promise<ServerRecord> {
    return this.adoptionService().createFromSkill(args);
  }

  /**
   * Start-over in place: stop/remove runtime, wipe server files, re-bind skill.
   * Keeps the same server id (and conversation binding). Clears snapshots + panel.
   * Dir + marker materialization goes through ServerAdoptionService.
   */
  async reinstallFromSkill(
    id: string,
    args: { skillName: string; serverName?: string; nodeId?: string },
  ): Promise<ServerRecord> {
    const existing = await this.getRaw(id);
    if (!existing) throw new Error(`unknown_server: ${id}`);

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
    this.stopLogFollow(id);

    try {
      fs.rmSync(existing.dataPath, { recursive: true, force: true });
    } catch {
      // best-effort
    }

    const target = await this.adoptionService().rematerializeForReinstall(existing, {
      skillName: args.skillName,
      nodeId: args.nodeId,
    });

    await this.db.delete(snapshots).where(eq(snapshots.serverId, id));
    await this.db.delete(panelBlocks).where(eq(panelBlocks.serverId, id));

    const name = args.serverName ?? target.skill.metadata.game ?? target.skill.metadata.name;
    await this.db
      .update(servers)
      .set({
        name,
        game: target.skill.metadata.game ?? target.skill.metadata.name,
        nodeId: target.nodeId,
        runtimeMode: target.runtimeMode,
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
    await this.openFiles(server).ensureDir("game");
  }

  /** Get the node's copy of the server tree (and any cloud forwards) ready to run. */
  private async prepareRemoteStart(server: ServerRecord, skillName: string): Promise<void> {
    await this.provisionRemoteDirs(server);
    // Manage-seeded servers keep game files on the node; don't wipe them with an empty Home tree.
    const nodeAuthoritative = fs.existsSync(
      path.join(server.dataPath, NODE_AUTHORITATIVE_MARKER),
    );
    if (!nodeAuthoritative) {
      await pushServerDirToNode({
        nodeId: server.nodeId!,
        serverId: server.id,
        localDataPath: server.dataPath,
      }).catch(() => undefined);
    }
    await this.ensureCloudGateway(server, skillName);
    await this.ensureWslParentPublish(server, skillName);
  }

  async start(id: string): Promise<ServerRecord> {
    const server = await this.getRaw(id);
    if (!server) throw new Error(`unknown_server: ${id}`);

    const skillMeta = this.readSkillMeta(server.dataPath);
    const skillName = skillMeta.skillName || this.readSkillName(server.dataPath);
    await this.db.update(servers).set({ status: "starting" }).where(eq(servers.id, id));
    this.emitStatus(id, "starting");

    const remote = this.isRemoteNode(server);

    try {
      if (remote) {
        await this.prepareRemoteStart(server, skillName);
      }

      const handle = await this.openRuntime(server);
      const runtime = await handle.status().catch(() => null);
      const processAlive = runtime?.state === "running";
      const hostPortsBound = await this.hostGamePortsBound(server);
      const decision = decideStartInstance({ processAlive, hostPortsBound });

      if (decision === "reuse") {
        this.crashRestarts.delete(id);
        await this.db.update(servers).set({ status: "running" }).where(eq(servers.id, id));
        this.emitStatus(id, "running");
        await this.beginRuntimeLogFollow(id, handle);
        return (await this.getRaw(id))!;
      }

      if (decision === "reap_then_start") {
        await handle.stop().catch(() => undefined);
        await this.reapNativeServerTree(server).catch(() => undefined);
      } else if (handle.mode === "docker") {
        // Native leftovers (skill start.sh / managed-start) must not sit beside
        // the named container. Native start already reclaims inside the supervisor.
        await this.reapNativeServerTree(server).catch(() => undefined);
      }
      await handle.start();

      await this.markInstanceStarted(id);
      await this.db.update(servers).set({ status: "running" }).where(eq(servers.id, id));
      this.emitStatus(id, "running");
      await this.beginRuntimeLogFollow(id, handle);
      return (await this.getRaw(id))!;
    } catch (err) {
      await this.db.update(servers).set({ status: "error" }).where(eq(servers.id, id));
      this.emitStatus(id, "error");
      if (parseDockerHostPortBindError(err)) {
        await rewriteDockerPortBindError(err, {
          listContainers: this.hostPortHoldersOverride ?? (() => listHostContainers()),
        });
      }
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
    await releaseWslLanPublish({ serverId: id, wslNodeId: server.nodeId }).catch(() => undefined);

    await this.openRuntime(server)
      .then((handle) => handle.stop())
      .catch(() => undefined);

    await this.clearInstanceStarted(id);
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

    // Wipe the node jail before dropping the DB row (needs server identity for jobs).
    if (this.isRemoteNode(server)) {
      try {
        await this.openFiles(server, { locality: "remote" }).delete(".");
      } catch {
        // best-effort — orphans are worse than a failed delete
      }
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
