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

/** Job kinds the control plane may enqueue onto a node-agent. */
export const NodeJobKindSchema = z.enum([
  "ping",
  "fs_list",
  "fs_ensure_dir",
  "fs_write_text",
  "fs_read_text",
  "fs_put_archive",
  "fs_get_archive",
  "fs_remove",
  "fs_rename",
  "fs_copy",
  "container_create",
  "container_start",
  "container_stop",
  "container_remove",
  "container_inspect",
  "container_logs",
  "container_stdin",
  "process_start",
  "process_stop",
  "process_status",
  "steamcmd_app_update",
  "runtime_caps",
  "net_udp_listen",
  "net_tcp_connect",
  "net_port_publish",
  "node_self_update",
  "manage_probe",
  "manage_pack",
  "manage_pack_read",
  "manage_seed",
  "manage_cutover",
  "wsl_ensure",
]);

/** Runtime capabilities advertised by a node (Local / Remote / Cloud). */
export const NodeCapabilitiesSchema = z.object({
  os: z.enum(["linux", "windows"]),
  /** Can start Docker game containers. */
  docker: z.boolean(),
  /** Can supervise native OS processes (always true for host agents). */
  native: z.boolean().default(true),
  /** SteamCMD binary present or auto-provisionable on this node. */
  steamcmd: z.boolean().default(false),
  freeDiskBytes: z.number().nonnegative().optional(),
  /**
   * Job kinds this agent can execute. Absent on agents older than the typed
   * protocol; the control plane then falls back to optimistic dispatch.
   */
  jobKinds: z.array(NodeJobKindSchema).optional(),
});

export const NodeKindSchema = z.enum(["local", "lan", "cloud"]);

export const NodeHeartbeatSchema = z.object({
  nodeId: z.string().min(1),
  name: z.string().min(1),
  os: z.enum(["linux", "windows"]),
  docker: z.boolean(),
  native: z.boolean().default(true),
  steamcmd: z.boolean().default(false),
  freeDiskBytes: z.number().nonnegative().optional(),
  agentVersion: z.string().default("0.1.0"),
  /** Optional; control plane preserves kind set at Add-node time when omitted. */
  kind: NodeKindSchema.optional(),
  /** Protocol support advertisement; see `NodeCapabilitiesSchema.jobKinds`. */
  jobKinds: z.array(NodeJobKindSchema).optional(),
});

export type SetupStatus = z.infer<typeof SetupStatusSchema>;
export type BootstrapOwner = z.infer<typeof BootstrapOwnerSchema>;
export type LoginInput = z.infer<typeof LoginSchema>;
export type PublicUser = z.infer<typeof PublicUserSchema>;
export type NodeCapabilities = z.infer<typeof NodeCapabilitiesSchema>;
export type NodeHeartbeat = z.infer<typeof NodeHeartbeatSchema>;
export type NodeJobKind = z.infer<typeof NodeJobKindSchema>;
