import fs from "node:fs";
import path from "node:path";
import {
  PanelBlockTypeSchema,
  renderSkillTemplate,
  type LiveServerState,
  type SkillJoin,
  type SkillMetadata,
} from "@playon/shared";
import { PublishBlockSchema, type PanelService } from "./panel.js";
import type { ServerService } from "./servers.js";
import { loadSkillMetadata } from "./skills.js";
import type { z } from "zod";

/**
 * Keys on server_status.body owned by the live-query layer.
 * Control plane always re-applies these so agent panel_publish cannot wipe them.
 * Extend this list when new uniform live fields are added.
 */
export const LIVE_PANEL_STATUS_KEYS = [
  "online",
  "players",
  "maxPlayers",
  "map",
  "mode",
  "serverName",
  "version",
  "uptimeSeconds",
  "playerList",
] as const;

export type LivePanelStatusKey = (typeof LIVE_PANEL_STATUS_KEYS)[number];

/** Panel-safe live fields for server_status.body. */
export function liveStateToPanelBody(live?: LiveServerState | null): Record<string, unknown> {
  if (!live?.online) return {};
  const out: Record<string, unknown> = { online: true };
  if (live.players !== undefined) out.players = live.players;
  if (live.maxPlayers !== undefined) out.maxPlayers = live.maxPlayers;
  if (live.map) out.map = live.map;
  if (live.mode) out.mode = live.mode;
  if (live.name) out.serverName = live.name;
  if (live.version) out.version = live.version;
  if (live.uptimeSeconds !== undefined) out.uptimeSeconds = live.uptimeSeconds;
  if (live.playerList?.length) {
    out.playerList = live.playerList.map((p) => ({
      name: p.name,
      ...(p.score !== undefined ? { score: p.score } : {}),
    }));
  }
  return out;
}

/** Pull previously published live fields (used when a fresh query is offline). */
export function extractLivePanelFields(body: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!body) return {};
  const out: Record<string, unknown> = {};
  for (const key of LIVE_PANEL_STATUS_KEYS) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  return out;
}

/**
 * Merge lifecycle/agent status body with live query fields.
 * Fresh online query wins; otherwise retain prior live metrics so publishes cannot clear them.
 */
export function mergeLiveIntoStatusBody(
  body: Record<string, unknown>,
  live?: LiveServerState | null,
  previous?: Record<string, unknown> | null,
): Record<string, unknown> {
  const fromQuery = liveStateToPanelBody(live);
  const retained = Object.keys(fromQuery).length ? fromQuery : extractLivePanelFields(previous);
  return { ...body, ...retained };
}

type PublishBlock = z.infer<typeof PublishBlockSchema>;

function readSkillJson(dataPath: string): {
  skillName: string;
  join?: SkillJoin;
} {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataPath, "skill.json"), "utf8")) as {
      skillName?: string;
      join?: SkillJoin;
    };
    return { skillName: raw.skillName ?? "", join: raw.join };
  } catch {
    return { skillName: "" };
  }
}

export function resolveJoin(
  servers: ServerService | undefined,
  dataPath: string,
  skillName?: string,
): SkillJoin | undefined {
  const cached = readSkillJson(dataPath).join;
  if (cached) return cached;
  const name = skillName || readSkillJson(dataPath).skillName;
  if (!servers || !name) return undefined;
  return loadSkillMetadata(servers.skillsRoots, name)?.metadata.join;
}

function buildConnectCommand(join: SkillJoin | undefined, host: string, port: number): string | undefined {
  if (!join?.connectCommand?.trim()) return undefined;
  return renderSkillTemplate(join.connectCommand.trim(), { host, port });
}

function buildSteamConnectUrl(join: SkillJoin | undefined, host: string, port: number): string | undefined {
  if (!join?.steamClientAppId) return undefined;
  const endpoint = `${host}:${port}`;
  if (join.steamUrlStyle === "connect") {
    return `steam://connect/${endpoint}`;
  }
  return `steam://run/${join.steamClientAppId}//+connect%20${endpoint}`;
}

/** Full client paste string when the game needs more than host:port (agent may override). */
export function defaultConnectCommand(opts: {
  join?: SkillJoin;
  address: string;
  port: number;
}): string | undefined {
  return buildConnectCommand(opts.join, opts.address, opts.port);
}

/**
 * steam:// deep link from skill join.steamClientAppId.
 * Agent may override with any steam:// URL.
 */
export function defaultSteamConnectUrl(opts: {
  join?: SkillJoin;
  address: string;
  port: number;
}): string | undefined {
  return buildSteamConnectUrl(opts.join, opts.address, opts.port);
}

/** Only allow steam:// links onto the player panel (agent-supplied or default). */
export function sanitizeSteamConnectUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  if (!/^steam:\/\//i.test(value)) return undefined;
  if (/[\s<>"']/.test(value)) return undefined;
  return value;
}

/** Merge control-plane join with agent join_info body; keeps agent connect fields when set. */
export function enrichJoinInfoBody(opts: {
  body: Record<string, unknown>;
  address: string;
  port: number;
  join?: SkillJoin;
  game?: string | null;
}): Record<string, unknown> {
  const { body, address, port, join, game } = opts;
  const agentCmd =
    typeof body.connectCommand === "string" ? body.connectCommand.trim() : "";
  const connectCommand =
    agentCmd || defaultConnectCommand({ join, address, port });
  const steamConnectUrl =
    sanitizeSteamConnectUrl(body.steamConnectUrl) ||
    defaultSteamConnectUrl({ join, address, port });
  return {
    ...body,
    address,
    port,
    endpoint: `${address}:${port}`,
    ...(connectCommand ? { connectCommand } : {}),
    ...(steamConnectUrl ? { steamConnectUrl } : {}),
    game: body.game ?? game ?? undefined,
  };
}

export function skillNameFromDataPath(dataPath: string): string {
  return readSkillJson(dataPath).skillName;
}

export function clientSetupNotes(opts: {
  join?: SkillJoin;
  address: string;
  port: number;
}): string {
  const { join, address, port } = opts;
  const connectCommand = defaultConnectCommand({ join, address, port });
  if (join?.clientSetupNotes?.trim()) {
    return renderSkillTemplate(join.clientSetupNotes.trim(), {
      host: address,
      port,
      connectCommand,
    });
  }
  return `Connect your game client to ${address}:${port}.`;
}

/** Block types the control plane owns on start/status refresh. */
export const AUTO_PANEL_TYPES = new Set(["join_info", "server_status", "client_setup"]);

/** Agent/host content kept across auto panel refreshes. */
export const PRESERVED_PANEL_TYPES = new Set([
  "guide",
  "vote",
  "announcement",
  "readiness",
  "file_drop",
  "discovery",
]);

/** Keep guide/vote/etc. when rewriting join/status/setup for a running server. */
export function preservedPanelBlocks(
  existing: Array<{ type: string; title: string; body: Record<string, unknown> }>,
): PublishBlock[] {
  const out: PublishBlock[] = [];
  for (const block of existing) {
    if (!PRESERVED_PANEL_TYPES.has(block.type) || AUTO_PANEL_TYPES.has(block.type)) continue;
    const type = PanelBlockTypeSchema.safeParse(block.type);
    if (!type.success) continue;
    out.push({
      type: type.data,
      title: block.title,
      body: block.body,
      sortOrder: 10 + out.length,
    });
  }
  return out;
}

/** Statuses whose join blocks appear on the public player panel. */
export function isPlayerPanelLiveStatus(status: string | null | undefined): boolean {
  return status === "running" || status === "starting";
}

export async function publishServerPanel(
  servers: ServerService,
  panel: PanelService,
  serverId: string,
  status: "running" | "starting" | "stopped" | "error",
  live?: LiveServerState | null,
): Promise<void> {
  // Stopped/error servers leave the player panel — join info is only for live games.
  if (status === "stopped" || status === "error") {
    await panel.clearForServer(serverId);
    return;
  }

  const detail = await servers.detail(serverId);
  if (!detail?.runtime.join) return;
  const { address, port } = detail.runtime.join;
  const skillName = readSkillJson(detail.server.dataPath).skillName;
  const join = resolveJoin(servers, detail.server.dataPath, skillName);
  const connectCommand = defaultConnectCommand({ join, address, port });
  const steamConnectUrl = defaultSteamConnectUrl({ join, address, port });

  const existing = await panel.list(serverId);
  const preserved = preservedPanelBlocks(existing);
  const previousStatus = existing.find((b) => b.type === "server_status")?.body ?? null;
  const statusBody = mergeLiveIntoStatusBody(
    {
      status,
      runtime: detail.runtime.kind,
      game: detail.server.game,
      containerStatus: detail.runtime.containerStatus ?? status,
    },
    live,
    previousStatus,
  );

  await panel.replaceForServer(serverId, [
    {
      type: "join_info",
      title: detail.server.game ? `Join ${detail.server.game}` : "Join",
      body: {
        address,
        port,
        endpoint: `${address}:${port}`,
        ...(connectCommand ? { connectCommand } : {}),
        ...(steamConnectUrl ? { steamConnectUrl } : {}),
        runtime: detail.runtime.kind,
        game: detail.server.game,
        container: detail.runtime.containerName,
      },
      sortOrder: 0,
    },
    {
      type: "server_status",
      title: "Status",
      body: statusBody,
      sortOrder: 1,
    },
    {
      type: "client_setup",
      title: "How to connect",
      body: {
        notes: clientSetupNotes({ join, address, port }),
      },
      sortOrder: 2,
    },
    ...preserved,
  ]);
}

type PanelPublishBlock = {
  type: z.infer<typeof PanelBlockTypeSchema>;
  title: string;
  body: Record<string, unknown>;
  sortOrder: number;
};

/**
 * Ensure agent panel replaces still carry control-plane live metrics.
 * Injects server_status when omitted. Fresh online query wins; else keep prior live keys.
 */
export function enrichBlocksWithLiveStatus(
  blocks: PanelPublishBlock[],
  opts: {
    status: string;
    runtime: string;
    game?: string | null;
    live?: LiveServerState | null;
    previousStatusBody?: Record<string, unknown> | null;
  },
): PanelPublishBlock[] {
  const base = {
    status: opts.status,
    runtime: opts.runtime,
    game: opts.game ?? undefined,
  };
  let sawStatus = false;
  const next = blocks.map((block) => {
    if (block.type !== "server_status") return block;
    sawStatus = true;
    return {
      ...block,
      body: mergeLiveIntoStatusBody(
        {
          ...block.body,
          status: block.body.status ?? opts.status,
          runtime: block.body.runtime ?? opts.runtime,
          game: block.body.game ?? opts.game ?? undefined,
        },
        opts.live,
        opts.previousStatusBody,
      ),
    };
  });
  if (!sawStatus && isPlayerPanelLiveStatus(opts.status)) {
    next.splice(Math.min(1, next.length), 0, {
      type: "server_status",
      title: "Status",
      body: mergeLiveIntoStatusBody(base, opts.live, opts.previousStatusBody),
      sortOrder: 1,
    });
  }
  return next;
}

/** Query live state for panel enrichment; never throws. */
export async function safeQueryLive(
  query: (serverId: string) => Promise<LiveServerState>,
  serverId: string,
): Promise<LiveServerState | null> {
  try {
    return await query(serverId);
  } catch {
    return null;
  }
}

/** @deprecated kept for typed re-exports in tests */
export type { SkillMetadata };
