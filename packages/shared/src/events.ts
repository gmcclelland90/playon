import { z } from "zod";
import { PanelBlockSchema } from "./panel.js";

export const WsEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("chat.token"),
    conversationId: z.string(),
    token: z.string(),
  }),
  z.object({
    type: z.literal("chat.tool"),
    conversationId: z.string(),
    toolName: z.string(),
    status: z.enum(["started", "completed", "failed"]),
    detail: z.record(z.unknown()).optional(),
  }),
  z.object({
    type: z.literal("server.status"),
    serverId: z.string(),
    status: z.enum(["creating", "starting", "running", "stopping", "stopped", "error"]),
  }),
  z.object({
    type: z.literal("server.log"),
    serverId: z.string(),
    line: z.string(),
    nodeId: z.string().optional(),
  }),
  z.object({
    type: z.literal("server.relocated"),
    serverId: z.string(),
    fromNodeId: z.string().nullable(),
    toNodeId: z.string(),
  }),
  z.object({
    type: z.literal("panel.updated"),
    blocks: z.array(PanelBlockSchema),
  }),
  z.object({
    type: z.literal("node.heartbeat"),
    nodeId: z.string(),
    capabilities: z.object({
      os: z.enum(["linux", "windows"]),
      docker: z.boolean(),
      native: z.boolean().optional(),
      steamcmd: z.boolean().optional(),
      freeDiskBytes: z.number().nonnegative().optional(),
    }),
  }),
  z.object({
    type: z.literal("node.metrics"),
    nodeId: z.string(),
    metrics: z.object({
      freeDiskBytes: z.number().nonnegative().optional(),
      cpuPercent: z.number().min(0).max(100).optional(),
      memUsedBytes: z.number().nonnegative().optional(),
      memTotalBytes: z.number().nonnegative().optional(),
    }),
  }),
  z.object({
    type: z.literal("confirm.required"),
    requestId: z.string(),
    toolName: z.string(),
    summary: z.string(),
  }),
  z.object({
    type: z.literal("agent.celebration"),
    serverId: z.string(),
    skill: z.string(),
    reason: z.string(),
    xpGained: z.number().int().nonnegative(),
    level: z.number().int().positive(),
    title: z.string(),
    leveledUp: z.boolean(),
  }),
  z.object({
    type: z.literal("agent.activity"),
    serverId: z.string(),
    conversationId: z.string().optional(),
    skill: z.string(),
    phase: z.enum([
      "thinking",
      "tool_start",
      "tool_done",
      "tool_fail",
      "confirm_wait",
      "idle",
    ]),
    verb: z.enum([
      "fetch",
      "search",
      "read",
      "write",
      "run",
      "snapshot",
      "panel",
      "skill",
      "other",
    ]),
    toolName: z.string().optional(),
    label: z.string().optional(),
  }),
]);

export type WsEvent = z.infer<typeof WsEventSchema>;
