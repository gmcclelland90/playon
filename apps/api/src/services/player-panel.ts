import { PanelBlockTypeSchema, type LiveServerState } from "@playon/shared";
import type { AppConfig } from "../config.js";
import type { PanelBlockRecord, PanelService } from "./panel.js";
import { resolvePanelTheme, type PanelTheme } from "./panel-theme.js";
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
import type { ServerQueryService } from "./server-query.js";
import type { ServerService } from "./servers.js";

/** Owns what players see: publish, list, and theme for the public player panel. */
export class PlayerPanel {
  constructor(
    private readonly servers: ServerService,
    private readonly panel: PanelService,
    private readonly queries: ServerQueryService,
    private readonly config: AppConfig,
  ) {}

  async publishForStatus(
    serverId: string,
    status: "running" | "starting" | "stopped" | "error",
    live?: LiveServerState | null,
  ): Promise<void> {
    await publishServerPanel(this.servers, this.panel, serverId, status, live);
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
    let parsedBlocks = blocks.map((block, index) => {
      const raw = block as Record<string, unknown>;
      return {
        type: PanelBlockTypeSchema.parse(normalizePanelBlockType(raw.type)),
        title: String(raw.title),
        body: (raw.body as Record<string, unknown> | undefined) ?? {},
        sortOrder: typeof raw.sortOrder === "number" ? raw.sortOrder : index,
      };
    });

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

    // Prefer control-plane join (advertise host + skill port) over LLM-invented ports.
    // Preserve agent connectCommand / steamConnectUrl; fill game defaults when missing.
    let serverStatus: string | undefined;
    const detail = await this.servers.detail(serverId);
    serverStatus = detail?.server.status;
    const join = detail?.runtime.join;
    if (join && detail) {
      const joinMeta = resolveJoin(this.servers, detail.server.dataPath);
      const existing = await this.panel.list(serverId);
      const previousStatusBody =
        existing.find((b) => b.type === "server_status")?.body ?? null;
      const live = isPlayerPanelLiveStatus(detail.server.status)
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
        status: detail.server.status,
        runtime: detail.runtime.kind,
        game: detail.server.game,
        live,
        previousStatusBody,
      });
    }

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
