import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  createNativeRuntimeAdapters,
  createRuntimeAdapters,
  type DockerAdapter,
  type LogFollowHandle,
  type ProcessSupervisor,
} from "@playon/runtime";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { servers } from "../db/schema.js";
import type { EventHub } from "./event-hub.js";
import { PlacementService } from "./placement.js";
import {
  generateRconPassword,
  readRconConfig,
  writeRconConfig,
  type RconEndpoint,
} from "./rcon.js";
import { loadSkillMetadata } from "./skills.js";

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

    if (this.config.runtimeMode === "native") {
      try {
        const adapters = await createRuntimeAdapters("docker");
        this.sharedDocker = adapters.docker;
        this.sharedProcess = adapters.process;
      } catch {
        const adapters = createNativeRuntimeAdapters();
        this.sharedDocker = adapters.docker;
        this.sharedProcess = adapters.process;
      }
      return;
    }

    const adapters = await createRuntimeAdapters("docker");
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
    try {
      return (
        (JSON.parse(fs.readFileSync(path.join(dataPath, "skill.json"), "utf8")) as {
          skillName?: string;
        }).skillName ?? ""
      );
    } catch {
      return "";
    }
  }

  gamePortForSkill(skillName: string): number {
    if (skillName === "games.minecraft-paper") return 25565;
    if (skillName === "games.unreal-tournament-99" || /ut99|unreal-tournament/i.test(skillName)) {
      return 7777;
    }
    return 25565;
  }

  rconPortForSkill(skillName: string): number {
    if (skillName === "games.minecraft-paper") return 25575;
    return 25575;
  }

  /** Ensure a local RCON endpoint config exists for Paper (password never returned to panels). */
  ensureRconConfig(server: ServerRecord, skillName: string): RconEndpoint | null {
    if (skillName !== "games.minecraft-paper") return readRconConfig(server.dataPath);
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
  } {
    try {
      const raw = JSON.parse(
        fs.readFileSync(path.join(dataPath, "skill.json"), "utf8"),
      ) as { skillName?: string; containerSupport?: string };
      return {
        skillName: raw.skillName ?? "",
        containerSupport: raw.containerSupport,
      };
    } catch {
      return { skillName: "" };
    }
  }

  private isUt99Skill(skillName: string): boolean {
    return (
      skillName === "games.unreal-tournament-99" || /ut99|unreal-tournament/i.test(skillName)
    );
  }

  private wantsNativeRuntime(
    server: ServerRecord,
    skillName: string,
    containerSupport?: string,
  ): boolean {
    if (server.runtimeMode === "native") return true;
    if (containerSupport === "none") return true;
    if (this.isUt99Skill(skillName)) return true;
    return false;
  }

  private resolveUt99Launch(
    gameDir: string,
  ): { command: string; args: string[] } | null {
    const isWin = process.platform === "win32";
    const candidates = isWin
      ? ["UCC.exe", "System\\UCC.exe", "ucc.exe", "System\\ucc.exe"]
      : ["ucc-bin", "ucc", "System/ucc-bin", "System/ucc"];
    for (const rel of candidates) {
      const full = path.join(gameDir, rel);
      if (fs.existsSync(full)) {
        return {
          command: full,
          args: isWin
            ? [
                "server",
                "DM-Turbine?game=Botpack.DeathMatchPlus",
                "ini=UnrealTournament.ini",
                "port=7777",
              ]
            : ["server", "DM-Turbine", "-port=7777"],
        };
      }
    }
    return null;
  }

  joinInfoFor(server: ServerRecord): { address: string; port: number } {
    const skillName = this.readSkillName(server.dataPath);
    return {
      address: this.config.advertiseHost,
      port: this.gamePortForSkill(skillName),
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

  private async reconcileStatus(server: ServerRecord): Promise<void> {
    if (server.runtimeMode === "native") return;
    await this.ensureRuntime();
    const adapter = this.adapterFor(server.id);
    try {
      const info = await adapter.inspect(this.containerName(server.id));
      const next = info.status === "running" ? "running" : "stopped";
      if (next !== server.status) {
        await this.db.update(servers).set({ status: next }).where(eq(servers.id, server.id));
      }
    } catch {
      if (server.status === "running") {
        await this.db.update(servers).set({ status: "stopped" }).where(eq(servers.id, server.id));
      }
    }
  }

  async detail(id: string): Promise<ServerDetail | null> {
    const server = await this.get(id);
    if (!server) return null;

    const skillName = this.readSkillName(server.dataPath);
    const join = this.joinInfoFor(server);
    const paper = skillName === "games.minecraft-paper";

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
        imageHint: paper ? "itzg/minecraft-server:latest" : undefined,
        join,
        logs,
      },
    };
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
    const useNative =
      skill.metadata.containerSupport === "none" ||
      skill.metadata.name === "games.unreal-tournament-99" ||
      this.isUt99Skill(skill.metadata.name);
    const runtimeMode = useNative ? "native" : "docker";
    fs.mkdirSync(path.join(dataPath, "game"), { recursive: true });
    fs.writeFileSync(
      path.join(dataPath, "skill.json"),
      JSON.stringify(
        {
          skillName: skill.metadata.name,
          version: skill.metadata.version,
          runtimeMode,
          containerSupport: skill.metadata.containerSupport,
          nodeId: resolvedNodeId,
        },
        null,
        2,
      ),
    );

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

  async start(id: string): Promise<ServerRecord> {
    const server = await this.getRaw(id);
    if (!server) throw new Error(`unknown_server: ${id}`);

    await this.ensureRuntime();
    const skillMeta = this.readSkillMeta(server.dataPath);
    const skillName = skillMeta.skillName || this.readSkillName(server.dataPath);
    await this.db.update(servers).set({ status: "starting" }).where(eq(servers.id, id));
    this.emitStatus(id, "starting");

    try {
      if (this.wantsNativeRuntime(server, skillName, skillMeta.containerSupport)) {
        if (!this.sharedProcess) throw new Error("runtime_not_ready");
        const processSupervisor = this.sharedProcess;
        const existing = this.processes.get(id);
        if (existing) {
          await processSupervisor.stop(existing).catch(() => undefined);
        }
        const gameDir = path.join(server.dataPath, "game");

        if (this.isUt99Skill(skillName)) {
          const launch = this.resolveUt99Launch(gameDir);
          if (!launch) {
            throw new Error(
              "ut99_binaries_missing: copy OldUnreal dedicated server into game/ (need UCC.exe or ucc-bin), then start again",
            );
          }
          const info = await processSupervisor.start({
            name: `server-${id}`,
            command: launch.command,
            args: launch.args,
            cwd: gameDir,
            env: { PLAYON_SERVER_ID: id, PLAYON_GAME: "ut99" },
          });
          this.processes.set(id, info.id);
          await this.db.update(servers).set({ status: "running" }).where(eq(servers.id, id));
          this.emitStatus(id, "running");
          return (await this.getRaw(id))!;
        }

        throw new Error(
          `native_binaries_missing: skill "${skillName}" is not containerised — place server binaries in game/ or use games.unreal-tournament-99 / a Docker skill`,
        );
      }

      const adapter = this.adapterFor(id);
      const name = this.containerName(id);
      const paper = skillName === "games.minecraft-paper";
      if (!paper) {
        throw new Error(
          `no_container_image: "${skillName || server.game || "unknown"}" is not a Docker skill. Use a native skill (e.g. games.unreal-tournament-99) or games.minecraft-paper.`,
        );
      }
      const image = "itzg/minecraft-server:latest";
      const gamePort = this.gamePortForSkill(skillName);
      const rcon = this.ensureRconConfig(server, skillName);
      const rconPort = rcon?.port ?? this.rconPortForSkill(skillName);

      let containerId = name;
      try {
        const info = await adapter.inspect(name);
        containerId = info.id;
      } catch {
        const created = await adapter.create({
          name,
          image,
          env: paper
            ? {
                EULA: "TRUE",
                TYPE: "PAPER",
                ONLINE_MODE: "FALSE",
                MAX_PLAYERS: "20",
                ENABLE_RCON: "true",
                RCON_PORT: String(rconPort),
                RCON_PASSWORD: rcon?.password ?? generateRconPassword(),
              }
            : undefined,
          ports: [
            { host: gamePort, container: gamePort, protocol: "tcp" },
            ...(paper
              ? [{ host: rconPort, container: rconPort, protocol: "tcp" as const }]
              : []),
          ],
          binds: paper
            ? [{ hostPath: path.join(server.dataPath, "game"), containerPath: "/data" }]
            : undefined,
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

    await this.ensureRuntime();
    await this.db.update(servers).set({ status: "stopping" }).where(eq(servers.id, id));
    this.emitStatus(id, "stopping");
    this.stopLogFollow(id);

    const processId = this.processes.get(id);
    if (processId && this.sharedProcess) {
      await this.sharedProcess.stop(processId).catch(() => undefined);
      this.processes.delete(id);
    }

    const adapter = this.adapters.get(id) ?? this.sharedDocker;
    if (adapter) {
      await adapter.stop(this.containerName(id)).catch(() => undefined);
    }

    await this.db.update(servers).set({ status: "stopped" }).where(eq(servers.id, id));
    this.emitStatus(id, "stopped");
    return (await this.getRaw(id))!;
  }
}
