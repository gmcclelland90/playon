import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  createRuntime,
  type DockerAdapter,
  type LogFollowHandle,
  type ProcessSupervisor,
} from "@playon/runtime";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import {
  conversations,
  messages,
  panelBlocks,
  servers,
  snapshots,
  toolInvocations,
} from "../db/schema.js";
import type { EventHub } from "./event-hub.js";
import { PlacementService } from "./placement.js";
import {
  generateRconPassword,
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
import { isLocalNodeId, type SkillMetadata } from "@playon/shared";
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

export interface ServerRuntimeDetail {
  kind: "docker" | "native";
  containerName?: string;
  containerStatus?: string;
  imageHint?: string;
  join?: { address: string; port: number };
  logs?: string[];
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
    return 25565;
  }

  rconPortForSkill(skillName: string, _game?: string | null): number {
    const fromMeta = this.portFromSkill(skillName, "rcon", 0);
    if (fromMeta > 0) return fromMeta;
    const native = nativeRconPort(this.resolveSkill(skillName)?.metadata);
    if (native != null) return native;
    return 25575;
  }

  private wantsMcRcon(skillName: string): boolean {
    return this.resolveSkill(skillName)?.metadata.adminDialect === "mc_rcon";
  }

  /** Ensure a local RCON endpoint config exists when the skill uses Minecraft RCON. */
  ensureRconConfig(server: ServerRecord, skillName: string): RconEndpoint | null {
    if (!this.wantsMcRcon(skillName)) return readRconConfig(server.dataPath);
    const existing = readRconConfig(server.dataPath);
    if (existing) return existing;
    const endpoint: RconEndpoint = {
      host: "127.0.0.1",
      port: this.rconPortForSkill(skillName),
      password: generateRconPassword(),
    };
    writeRconConfig(server.dataPath, endpoint);
    return endpoint;
  }

  async getRconEndpoint(serverId: string): Promise<RconEndpoint | null> {
    const server = await this.get(serverId);
    if (!server) return null;
    const skillName = this.readSkillName(server.dataPath);
    return this.ensureRconConfig(server, skillName) ?? readRconConfig(server.dataPath);
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

  joinInfoFor(server: ServerRecord): { address: string; port: number } {
    const skillName = this.readSkillName(server.dataPath);
    return {
      address: this.config.advertiseHost,
      port: this.gamePortForSkill(skillName, server.game),
    };
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
    if (server.runtimeMode === "native") {
      const next = this.nativeProcessAlive(server) ? "running" : "stopped";
      if (next !== server.status) {
        await this.db.update(servers).set({ status: next }).where(eq(servers.id, server.id));
        this.emitStatus(server.id, next);
      }
      return;
    }
    await this.ensureRuntime();
    const adapter = this.adapterFor(server.id);
    try {
      const info = await adapter.inspect(this.containerName(server.id));
      const next = info.status === "running" ? "running" : "stopped";
      if (next !== server.status) {
        await this.db.update(servers).set({ status: next }).where(eq(servers.id, server.id));
        this.emitStatus(server.id, next);
      }
    } catch {
      if (server.status === "running" || server.status === "starting") {
        await this.db.update(servers).set({ status: "stopped" }).where(eq(servers.id, server.id));
        this.emitStatus(server.id, "stopped");
      }
    }
  }

  async detail(id: string): Promise<ServerDetail | null> {
    const server = await this.get(id);
    if (!server) return null;

    const skillName = this.readSkillName(server.dataPath);
    const join = this.joinInfoFor(server);
    const cached = this.readSkillMeta(server.dataPath);

    if (server.runtimeMode === "native") {
      return {
        server,
        runtime: {
          kind: "native",
          join,
          logs: [],
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
      },
    };
  }

  /** Tail runtime logs for a server (Docker adapter; native returns empty for now). */
  async tailLogs(
    id: string,
    lines = 80,
  ): Promise<{ status: string; runtime: "docker" | "native"; lines: string[] } | null> {
    const server = await this.get(id);
    if (!server) return null;
    const capped = Math.min(200, Math.max(1, Math.floor(lines)));
    if (server.runtimeMode === "native") {
      return { status: server.status, runtime: "native", lines: [] };
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
    await dispatchNodeJob({
      nodeId: server.nodeId,
      kind: "fs_ensure_dir",
      args: { path: nodeServerRelPath(server.id, "game") },
      localHandler: async () => ({ ok: true }),
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
      const info = await dispatchNodeJob<{ id: string }>({
        nodeId,
        kind: "process_start",
        args: {
          name: `server-${id}`,
          command,
          args,
          cwd: nodeServerRelPath(id, "game"),
          env: { PLAYON_SERVER_ID: id, ...(native?.env ?? {}) },
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
    const rcon = this.ensureRconConfig(server, skillName);
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
      const info = await dispatchNodeJob<{ id: string }>({
        nodeId,
        kind: "container_inspect",
        args: { id: name },
        localHandler: async () => {
          throw new Error("remote_only");
        },
      });
      containerId = info.id;
    } catch {
      const created = await dispatchNodeJob<{ id: string }>({
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
      args: { id: containerId },
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
        const info = await processSupervisor.start({
          name: `server-${id}`,
          command: launch.command,
          args: launch.args,
          cwd: gameDir,
          env: { PLAYON_SERVER_ID: id, ...launch.env },
        });
        this.processes.set(id, info.id);
        await this.db.update(servers).set({ status: "running" }).where(eq(servers.id, id));
        this.emitStatus(id, "running");
        return (await this.getRaw(id))!;
      }

      const adapter = this.adapterFor(id);
      const name = this.containerName(id);
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
        const info = await adapter.inspect(name);
        containerId = info.id;
      } catch {
        const created = await adapter.create({
          name,
          image: docker.image,
          env,
          ports: portBindings,
          binds: [
            {
              hostPath: path.join(server.dataPath, "game"),
              containerPath: docker.dataMount,
            },
          ],
        });
        containerId = created.id;
      }

      await adapter.start(containerId);
      this.adapters.set(id, adapter);

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

    if (this.isRemoteNode(server) && server.nodeId) {
      const processId = this.processes.get(id);
      if (processId) {
        await dispatchNodeJob({
          nodeId: server.nodeId,
          kind: "process_stop",
          args: { id: processId },
          localHandler: async () => ({ ok: true }),
        }).catch(() => undefined);
        this.processes.delete(id);
      }
      await dispatchNodeJob({
        nodeId: server.nodeId,
        kind: "container_stop",
        args: { id: this.containerName(id) },
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

      const adapter = this.adapters.get(id) ?? this.sharedDocker;
      if (adapter) {
        await adapter.stop(this.containerName(id)).catch(() => undefined);
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
