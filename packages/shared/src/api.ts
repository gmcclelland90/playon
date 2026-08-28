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

/** Start a host-file password reset. The code is never returned on the wire. */
export const PasswordResetStartSchema = z.object({
  username: z.string().min(1).max(64),
});

export const PasswordResetCompleteSchema = z
  .object({
    username: z.string().min(1).max(64),
    password: z.string().min(8).max(128),
    /** Host-file code (alias of hostFileCode). */
    code: z.string().min(1).max(128).optional(),
    hostFileCode: z.string().min(1).max(128).optional(),
    totpCode: z.string().min(1).max(128).optional(),
    backupCode: z.string().min(1).max(128).optional(),
  })
  .superRefine((value, ctx) => {
    const proofs = [value.code, value.hostFileCode, value.totpCode, value.backupCode].filter(
      (item) => Boolean(item && item.length > 0),
    );
    if (proofs.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "exactly_one_reset_proof",
        path: ["code"],
      });
    }
  });

export const PasswordResetStartResponseSchema = z.object({
  ok: z.literal(true),
  methods: z.array(z.enum(["host_file", "totp"])).min(1),
  fileName: z.string().min(1).optional(),
  expiresAt: z.string().min(1).optional(),
  /** Absolute data directory, only when the request is on loopback. */
  dataRoot: z.string().min(1).optional(),
});

export const LoginTotpSchema = z.object({
  mfaToken: z.string().min(1),
  code: z.string().min(1).max(128),
});

export const MfaEnrollConfirmSchema = z.object({
  code: z.string().min(1).max(128),
  disableHostFileReset: z.boolean().optional(),
});

export const MfaCodeSchema = z.object({
  code: z.string().min(1).max(128),
});

export const MfaHostFileResetSchema = z.object({
  enabled: z.boolean(),
  code: z.string().min(1).max(128),
});

export const MfaStatusSchema = z.object({
  totpEnabled: z.boolean(),
  hostFileResetEnabled: z.boolean(),
});

export const PASSWORD_RESET_FILE_NAME = "password-reset.txt";

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
  cpuPercent: z.number().min(0).max(100).optional(),
  memUsedBytes: z.number().nonnegative().optional(),
  memTotalBytes: z.number().nonnegative().optional(),
  /**
   * Job kinds this agent can execute. Absent on agents older than the typed
   * protocol; the control plane then falls back to optimistic dispatch.
   */
  jobKinds: z.array(NodeJobKindSchema).optional(),
});

export const NodeKindSchema = z.enum(["local", "lan", "cloud"]);

const NodeContainerPortSchema = z.object({
  host: z.number().int().min(1).max(65535).optional(),
  container: z.number().int().min(1).max(65535),
  protocol: z.enum(["tcp", "udp"]).optional(),
});

/** Read-only `docker ps` row from a node heartbeat. Never a create/start request. */
export const NodeContainerInventorySchema = z.object({
  name: z.string().min(1).max(256),
  image: z.string().min(1).max(512),
  status: z.string().min(1).max(64),
  ports: z.array(NodeContainerPortSchema).max(32).optional(),
  cpuPercent: z.number().min(0).max(10_000).optional(),
  memUsedBytes: z.number().nonnegative().optional(),
});

/** Read-only native supervisor row from a node heartbeat. */
export const NodeProcessInventorySchema = z.object({
  name: z.string().min(1).max(256),
  pid: z.number().int().positive().optional(),
  status: z.string().min(1).max(64).optional(),
  cpuPercent: z.number().min(0).max(100).optional(),
  memUsedBytes: z.number().nonnegative().optional(),
});

export const NodeHeartbeatSchema = z.object({
  nodeId: z.string().min(1),
  name: z.string().min(1),
  os: z.enum(["linux", "windows"]),
  docker: z.boolean(),
  native: z.boolean().default(true),
  steamcmd: z.boolean().default(false),
  freeDiskBytes: z.number().nonnegative().optional(),
  cpuPercent: z.number().min(0).max(100).optional(),
  memUsedBytes: z.number().nonnegative().optional(),
  memTotalBytes: z.number().nonnegative().optional(),
  agentVersion: z.string().default("0.1.0"),
  /** Optional; control plane preserves kind set at Add-node time when omitted. */
  kind: NodeKindSchema.optional(),
  /** Protocol support advertisement; see `NodeCapabilitiesSchema.jobKinds`. */
  jobKinds: z.array(NodeJobKindSchema).optional(),
  /**
   * Containers on this node's own engine (Windows named pipe on win32, Linux
   * socket on WSL/Linux). Omitted by older agents. Read-only inventory.
   */
  containers: z.array(NodeContainerInventorySchema).max(80).optional(),
  /**
   * Supervised native processes on this node. Omitted by older agents.
   * Read-only usage inventory — not a start/stop request.
   */
  processes: z.array(NodeProcessInventorySchema).max(80).optional(),
});

export type SetupStatus = z.infer<typeof SetupStatusSchema>;
export type BootstrapOwner = z.infer<typeof BootstrapOwnerSchema>;
export type LoginInput = z.infer<typeof LoginSchema>;
export type PasswordResetStart = z.infer<typeof PasswordResetStartSchema>;
export type PasswordResetComplete = z.infer<typeof PasswordResetCompleteSchema>;
export type PasswordResetStartResponse = z.infer<typeof PasswordResetStartResponseSchema>;
export type LoginTotpInput = z.infer<typeof LoginTotpSchema>;
export type MfaStatus = z.infer<typeof MfaStatusSchema>;
export type PublicUser = z.infer<typeof PublicUserSchema>;
export type NodeCapabilities = z.infer<typeof NodeCapabilitiesSchema>;
export type NodeHeartbeat = z.infer<typeof NodeHeartbeatSchema>;
export type NodeContainerInventory = z.infer<typeof NodeContainerInventorySchema>;
export type NodeProcessInventory = z.infer<typeof NodeProcessInventorySchema>;
export type NodeJobKind = z.infer<typeof NodeJobKindSchema>;
