import {
  PanelBlockTypeSchema,
  playerPanelStatusFromJoinReady,
  type LiveServerState,
  type PanelBlockType,
} from "@playon/shared";
import type { AppConfig } from "../config.js";
import type { PanelBlockRecord, PanelService } from "./panel.js";
import {
  resolvePanelTheme,
  writeAgentPanelTheme,
  type AgentPanelTheme,
  type PanelTheme,
} from "./panel-theme.js";
import {
  clientSetupNotes,
  enrichBlocksWithLiveStatus,
  enrichJoinInfoBody,
  isPlayerPanelLiveStatus,
  normalizePanelBlockType,
  publishServerPanel,
  resolveJoin,
  safeQueryLive,
} from "./server-panel.js";
import type { JoinReadyService } from "./join-ready.js";
import type { ServerQueryService } from "./server-query.js";
import type { ServerService } from "./servers.js";

type AgentPanelBlock = {
  type: PanelBlockType;
  title: string;
  body: Record<string, unknown>;
  sortOrder: number;
};

export type UpsertPanelBlockInput = {
  id?: string;
  type: PanelBlockType;
  title: string;
  body: Record<string, unknown>;
  sortOrder?: number;
};

/**
 * Merge incoming agent blocks into an existing panel.
 * Match by `id` when provided, otherwise by `type`; unmatched blocks append.
 */
export function mergePanelBlocksForUpsert(
  existing: Array<{
    id: string;
    type: string;
    title: string;
    body: Record<string, unknown>;
    sortOrder: number;
  }>,
  incoming: UpsertPanelBlockInput[],
): AgentPanelBlock[] {
  const merged: Array<{
    id: string;
    type: string;
    title: string;
    body: Record<string, unknown>;
    sortOrder: number;
  }> = existing.map((b) => ({
    id: b.id,
    type: b.type,
    title: b.title,
    body: b.body,
    sortOrder: b.sortOrder,
  }));

  for (const block of incoming) {
    let idx = -1;
    if (block.id) {
      idx = merged.findIndex((b) => b.id === block.id);
    }
    if (idx < 0) {
      idx = merged.findIndex((b) => b.type === block.type);
    }
    if (idx >= 0) {
      const prev = merged[idx]!;
      merged[idx] = {
        id: prev.id,
        type: block.type,
        title: block.title,
        body: block.body,
        sortOrder: typeof block.sortOrder === "number" ? block.sortOrder : prev.sortOrder,
      };
    } else {
      merged.push({
        id: "",
        type: block.type,
        title: block.title,
        body: block.body,
        sortOrder:
          typeof block.sortOrder === "number" ? block.sortOrder : merged.length,
      });
    }
  }

  return merged.map((b) => ({
    type: PanelBlockTypeSchema.parse(normalizePanelBlockType(b.type)),
    title: b.title,
    body: b.body,
    sortOrder: b.sortOrder,
  }));
}

function parseAgentBlocks(blocks: unknown[]): AgentPanelBlock[] {
  return blocks.map((block, index) => {
    const raw = block as Record<string, unknown>;
    return {
      type: PanelBlockTypeSchema.parse(normalizePanelBlockType(raw.type)),
      title: String(raw.title),
      body: (raw.body as Record<string, unknown> | undefined) ?? {},
      sortOrder: typeof raw.sortOrder === "number" ? raw.sortOrder : index,
    };
  });
}

function parseUpsertBlocks(blocks: unknown[]): UpsertPanelBlockInput[] {
  return blocks.map((block) => {
    const raw = block as Record<string, unknown>;
    const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : undefined;
    return {
      id,
      type: PanelBlockTypeSchema.parse(normalizePanelBlockType(raw.type)),
      title: String(raw.title),
      body: (raw.body as Record<string, unknown> | undefined) ?? {},
      sortOrder: typeof raw.sortOrder === "number" ? raw.sortOrder : undefined,
    };
  });
}

/** Owns what players see: publish, list, and theme for the public player panel. */
export class PlayerPanel {
  constructor(
    private readonly servers: ServerService,
    private readonly panel: PanelService,
    private readonly queries: ServerQueryService,
    private readonly config: AppConfig,
    private readonly joinReady?: JoinReadyService,
  ) {}

  async publishForStatus(
    serverId: string,
    status: "running" | "starting" | "degraded" | "stopped" | "error",
    live?: LiveServerState | null,
  ): Promise<void> {
    await publishServerPanel(this.servers, this.panel, serverId, status, live);
  }

  /**
   * Shared join_info / client_setup / live status enrichment used by publish + upsert.
   */
  private async enrichAgentBlocks(
    serverId: string,
    blocks: AgentPanelBlock[],
  ): Promise<{ blocks: AgentPanelBlock[]; serverStatus?: string }> {
    let parsedBlocks = blocks;
    let serverStatus: string | undefined;
    const detail = await this.servers.detail(serverId);
    serverStatus = detail?.server.status;
    const joinReady = this.joinReady ? await this.joinReady.probe(serverId) : null;
    if (joinReady && (detail?.server.status === "running" || detail?.server.status === "starting")) {
      serverStatus = playerPanelStatusFromJoinReady(joinReady, detail.server.status);
    }
    const join = detail?.runtime.join;
    if (join && detail) {
      const joinMeta = resolveJoin(this.servers, detail.server.dataPath);
      const existing = await this.panel.list(serverId);
      const previousStatusBody =
        existing.find((b) => b.type === "server_status")?.body ?? null;
      const live = isPlayerPanelLiveStatus(serverStatus)
        ? await safeQueryLive(
            (id) => this.queries.queryServerWithRetry(id, { attempts: 3, delayMs: 800 }),
            serverId,
          )
        : null;
      parsedBlocks = parsedBlocks.map((block) => {
        if (block.type === "join_info") {
          return {
            ...block,
            body: enrichJoinInfoBody({
              body: block.body,
              address: join.address,
              port: join.port,
              join: joinMeta,
              game: detail.server.game,
            }),
          };
        }
        return block;
      });
      // Agents sometimes omit join_info — inject control-plane join so players are never blank.
      if (!parsedBlocks.some((b) => b.type === "join_info")) {
        parsedBlocks.unshift({
          type: "join_info",
          title: detail.server.game ? `Join ${detail.server.game}` : "Join",
          body: enrichJoinInfoBody({
            body: {},
            address: join.address,
            port: join.port,
            join: joinMeta,
            game: detail.server.game,
          }),
          sortOrder: -1,
        });
      }
      if (!parsedBlocks.some((b) => b.type === "client_setup")) {
        parsedBlocks.push({
          type: "client_setup",
          title: "How to connect",
          body: {
            notes: clientSetupNotes({
              join: joinMeta,
              address: join.address,
              port: join.port,
            }),
          },
          sortOrder: parsedBlocks.length,
        });
      }
      // Live query fields are control-plane owned — merge/inject so agents cannot wipe them.
      parsedBlocks = enrichBlocksWithLiveStatus(parsedBlocks, {
        status: serverStatus ?? detail.server.status,
        runtime: detail.runtime.kind,
        game: detail.server.game,
        live,
        previousStatusBody,
      });
    }
    return { blocks: parsedBlocks, serverStatus };
  }

  /**
   * Agent panel_publish path: normalize types, inject join/client_setup,
   * enrich live status, replace (or append when no serverId).
   */
  async publishFromAgent(
    serverId: string | undefined,
    blocks: unknown[],
  ): Promise<{
    published: number;
    blocks: PanelBlockRecord[];
    mode: "replace" | "append";
    playerVisible: boolean;
    serverStatus?: string;
    hint?: string;
  }> {
    let parsedBlocks = parseAgentBlocks(blocks);

    if (!serverId) {
      const published = await this.panel.publish({
        serverId,
        blocks: parsedBlocks,
      });
      return {
        published: published.length,
        blocks: published,
        mode: "append",
        playerVisible: true,
      };
    }

    const enriched = await this.enrichAgentBlocks(serverId, parsedBlocks);
    parsedBlocks = enriched.blocks;
    const serverStatus = enriched.serverStatus;

    const published = await this.panel.replaceForServer(serverId, parsedBlocks);
    const playerVisible = isPlayerPanelLiveStatus(serverStatus);
    return {
      published: published.length,
      blocks: published,
      mode: "replace",
      playerVisible,
      serverStatus,
      hint: playerVisible
        ? undefined
        : "Blocks saved, but the public player panel only shows join info while the server is starting or running. Call servers_start (or wait for start) so players can see it.",
    };
  }

  /**
   * Agent panel_upsert path: merge by id/type into the existing panel, then
   * apply the same join/live enrichment as publish.
   */
  async upsertFromAgent(
    serverId: string | undefined,
    blocks: unknown[],
  ): Promise<{
    published: number;
    blocks: PanelBlockRecord[];
    mode: "upsert" | "append";
    playerVisible: boolean;
    serverStatus?: string;
    hint?: string;
  }> {
    const incoming = parseUpsertBlocks(blocks);

    if (!serverId) {
      const published = await this.panel.publish({
        serverId,
        blocks: incoming.map((b, index) => ({
          type: b.type,
          title: b.title,
          body: b.body,
          sortOrder: typeof b.sortOrder === "number" ? b.sortOrder : index,
        })),
      });
      return {
        published: published.length,
        blocks: published,
        mode: "append",
        playerVisible: true,
      };
    }

    const existing = await this.panel.list(serverId);
    let parsedBlocks = mergePanelBlocksForUpsert(existing, incoming);
    const enriched = await this.enrichAgentBlocks(serverId, parsedBlocks);
    parsedBlocks = enriched.blocks;
    const serverStatus = enriched.serverStatus;

    const published = await this.panel.replaceForServer(serverId, parsedBlocks);
    const playerVisible = isPlayerPanelLiveStatus(serverStatus);
    return {
      published: published.length,
      blocks: published,
      mode: "upsert",
      playerVisible,
      serverStatus,
      hint: playerVisible
        ? undefined
        : "Blocks saved, but the public player panel only shows join info while the server is starting or running. Call servers_start (or wait for start) so players can see it.",
    };
  }

  /** Persist a sandboxed agent theme override for a server. */
  async setThemeFromAgent(
    serverId: string,
    theme: AgentPanelTheme,
  ): Promise<{ ok: true; theme: AgentPanelTheme; resolved: PanelTheme }> {
    const detail = await this.servers.detail(serverId);
    if (!detail) {
      throw new Error(`server_not_found:${serverId}`);
    }
    const saved = writeAgentPanelTheme(detail.server.dataPath, theme);
    const resolved = resolvePanelTheme(this.config, [
      { serverId, type: "join_info", sortOrder: 0 },
    ]);
    return { ok: true, theme: saved, resolved };
  }

  /** List blocks for the public panel (live servers only unless serverId is set). */
  async listForPlayers(serverId?: string): Promise<PanelBlockRecord[]> {
    let blocks = await this.panel.list(serverId);
    if (!serverId) {
      const live = new Set(
        (await this.servers.list())
          .filter((s) => isPlayerPanelLiveStatus(s.status))
          .map((s) => s.id),
      );
      blocks = blocks.filter((b) => !b.serverId || live.has(b.serverId));
    }
    return blocks;
  }

  resolveTheme(
    blocks: Array<{ serverId: string | null; type?: string; sortOrder?: number }>,
  ): PanelTheme {
    return resolvePanelTheme(this.config, blocks);
  }
}
