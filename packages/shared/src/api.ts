import { z } from "zod";
import { RoleSchema } from "./roles.js";

export const SetupStatusSchema = z.object({
  needsSetup: z.boolean(),
  product: z.literal("PlayOn"),
});

export const BootstrapOwnerSchema = z.object({
  username: z.string().min(3).max(64),
  password: z.string().min(8).max(128),
  displayName: z.string().min(1).max(128).optional(),
});

export const LoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export const PublicUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  role: RoleSchema,
});

export const SessionResponseSchema = z.object({
  user: PublicUserSchema,
});

export const NodeHeartbeatSchema = z.object({
  nodeId: z.string().min(1),
  name: z.string().min(1),
  os: z.enum(["linux", "windows"]),
  docker: z.boolean(),
  freeDiskBytes: z.number().nonnegative().optional(),
  agentVersion: z.string().default("0.1.0"),
});

export type SetupStatus = z.infer<typeof SetupStatusSchema>;
export type BootstrapOwner = z.infer<typeof BootstrapOwnerSchema>;
export type LoginInput = z.infer<typeof LoginSchema>;
export type PublicUser = z.infer<typeof PublicUserSchema>;
export type NodeHeartbeat = z.infer<typeof NodeHeartbeatSchema>;
