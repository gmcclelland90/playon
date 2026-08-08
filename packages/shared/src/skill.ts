import { z } from "zod";
import { SkillWatcherTemplateSchema } from "./watcher.js";

export const ContainerSupportSchema = z.enum(["full", "partial", "none"]);
export type ContainerSupport = z.infer<typeof ContainerSupportSchema>;

export const HealthCheckSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["process_running", "tcp_port", "query_responding"]),
  /** For tcp_port: uses skill port name or explicit port. */
  portName: z.string().optional(),
  port: z.number().int().positive().optional(),
  host: z.string().optional(),
  /** Known failure → remediation action the monitor may auto-run. */
  onFail: z.enum(["none", "restart", "escalate"]).default("escalate"),
});

export type HealthCheck = z.infer<typeof HealthCheckSchema>;

/** Read-only live query dialect (separate from adminDialect / RCON). */
export const QueryDialectSchema = z.enum([
  "none",
  "minecraft_status",
  "a2s",
  "valheim",
  "unreal",
  "terraria",
  "factorio",
  "skill_module",
]);
export type QueryDialect = z.infer<typeof QueryDialectSchema>;

export const SkillThemeIdSchema = z.enum(["default", "grass", "ember", "steel", "paper"]);
export type SkillThemeId = z.infer<typeof SkillThemeIdSchema>;

export const SkillThemeSchema = z.object({
  id: SkillThemeIdSchema.default("default"),
  /** Optional OKLCH hue for --primary on the player panel (0–360). */
  primaryHue: z.number().min(0).max(360).optional(),
});
export type SkillTheme = z.infer<typeof SkillThemeSchema>;

/** How the agent / runtime should administer the running server. */
export const AdminDialectSchema = z.enum([
  "none",
  "mc_rcon",
  "source_rcon",
  "rust_web_rcon",
  "http_rest",
  "stdin",
]);
export type AdminDialect = z.infer<typeof AdminDialectSchema>;

/**
 * Player join UX declared by the skill (not the control plane).
 * Templates may use {{host}}, {{port}}, {{endpoint}}, {{connectCommand}}.
 */
export const SkillJoinSchema = z.object({
  connectCommand: z.string().optional(),
  /** Steam *client* app id for steam://run/<id>/… deep links. */
  steamClientAppId: z.number().int().positive().optional(),
  steamUrlStyle: z.enum(["run_connect", "connect"]).default("run_connect"),
  clientSetupNotes: z.string().optional(),
});
export type SkillJoin = z.infer<typeof SkillJoinSchema>;

/** Native process launch declared by the skill (start.sh still wins when present). */
export const SkillNativeSchema = z.object({
  binary: z.string().min(1).optional(),
  binaryWindows: z.string().min(1).optional(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  /** Paths relative to game/ prepended to LD_LIBRARY_PATH on Linux. */
  libraryPathRelative: z.array(z.string()).default([]),
  preferStartScript: z.boolean().default(true),
});
export type SkillNative = z.infer<typeof SkillNativeSchema>;

export const SkillMetadataSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  game: z.string().min(1).optional(),
  description: z.string().default(""),
  tags: z.array(z.string()).default([]),
  theme: SkillThemeSchema.optional(),
  os: z.array(z.enum(["linux", "windows"])).default(["linux", "windows"]),
  arch: z.array(z.string()).default(["amd64"]),
  containerSupport: ContainerSupportSchema.default("none"),
  /** Docker image when containerSupport is full/partial (e.g. itzg/minecraft-server:latest). */
  dockerImage: z.string().min(1).optional(),
  /** Static container env; runtime may inject RCON_* when adminDialect needs it. */
  dockerEnv: z.record(z.string(), z.string()).default({}),
  /** Container path for the server game/ bind mount. */
  dockerDataMount: z.string().min(1).default("/data"),
  /** SteamCMD dedicated-server app id (catalog Steam skills). */
  steamAppId: z.number().int().positive().optional(),
  adminDialect: AdminDialectSchema.default("none"),
  /** Live stats query protocol; skill_module loads query/connector.mjs from the skill. */
  queryDialect: QueryDialectSchema.default("none"),
  /** Port name for query (default "query", else "game"). */
  queryPortName: z.string().min(1).optional(),
  /** Relative path under the skill dir for skill_module (default query/connector.mjs). */
  queryConnector: z.string().min(1).optional(),
  join: SkillJoinSchema.optional(),
  native: SkillNativeSchema.optional(),
  /** Soft requirement for capacity warnings (party-box multi-server). */
  minRamMb: z.number().int().positive().optional(),
  requiredTools: z.array(z.string()).default([]),
  ports: z
    .array(
      z.object({
        name: z.string(),
        protocol: z.enum(["tcp", "udp"]).default("tcp"),
        default: z.number().int().positive().optional(),
      }),
    )
    .default([]),
  /** Other skill names this skill expects (usually platform.*). */
  dependencies: z.array(z.string()).default([]),
  healthChecks: z.array(HealthCheckSchema).default([]),
  /** Optional watcher templates seeded (usually disabled) when a server is created from this skill. */
  watchers: z.array(SkillWatcherTemplateSchema).default([]),
});

export type SkillMetadata = z.infer<typeof SkillMetadataSchema>;

/** Expand {{host}} {{port}} {{endpoint}} {{connectCommand}} in skill join templates. */
export function renderSkillTemplate(
  template: string,
  vars: { host: string; port: number; connectCommand?: string },
): string {
  const endpoint = `${vars.host}:${vars.port}`;
  return template
    .replaceAll("{{host}}", vars.host)
    .replaceAll("{{port}}", String(vars.port))
    .replaceAll("{{endpoint}}", endpoint)
    .replaceAll("{{connectCommand}}", vars.connectCommand ?? "");
}
