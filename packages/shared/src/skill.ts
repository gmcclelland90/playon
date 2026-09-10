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
  "project_zomboid",
  "skill_module",
]);
export type QueryDialect = z.infer<typeof QueryDialectSchema>;

/**
 * Catalog skills may still ship `queryDialect: none` after a platform dialect
 * lands. Map those known titles so *live query* (player counts) works before
 * the next catalog bump. Join-ready must not use this for `wantsQuery` —
 * a mapped miss must not become `query_offline` over `udp_join_unproven`.
 */
const SKILL_QUERY_DIALECT_DEFAULTS: Record<string, QueryDialect> = {
  "games.project-zomboid": "project_zomboid",
};

/** Prefer an explicit skill dialect; otherwise apply a known-title default. */
export function resolveQueryDialect(
  skillName: string | undefined,
  declared: QueryDialect | undefined | null,
): QueryDialect {
  if (declared && declared !== "none") return declared;
  if (skillName && SKILL_QUERY_DIALECT_DEFAULTS[skillName]) {
    return SKILL_QUERY_DIALECT_DEFAULTS[skillName]!;
  }
  return declared ?? "none";
}

/**
 * Keen Content Update #2+ dedicated servers bind only `queryPort` (default
 * 15637). Catalog `games.enshrouded` 0.1.2 still advertises obsolete
 * `gamePort` 15636; current builds delete that key and never listen there.
 */
export const ENSHROUDED_QUERY_PORT = 15637;
export const ENSHROUDED_LEGACY_GAME_PORT = 15636;

/**
 * The Isle dedicated 412680 must install the `evrima` beta on every OS.
 * Catalog `games.the-isle` 0.1.1 documents that in INSTALL.md but ships no
 * SteamCMD beta field — and `steamBetaLinux` is ignored on Windows, the only
 * OS this skill declares. Without `-beta evrima`, SteamCMD fetches the
 * abandoned Legacy `public` branch (empty on Linux; obsolete PE on Windows).
 */
export const THE_ISLE_SKILL = "games.the-isle";
export const THE_ISLE_STEAM_BETA = "evrima";

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

/**
 * YAML unquoted Steam app ids (`376030`) parse as numbers. AMP-style install
 * dirs use those digits as a path segment, so stringify finite numbers only.
 */
export function coerceSkillPathSegment(value: unknown): unknown {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return value;
}

export const SkillPathSegmentSchema = z.preprocess(coerceSkillPathSegment, z.string());

/** Native process launch declared by the skill (start.sh still wins when present). */
export const SkillNativeSchema = z.object({
  binary: z.string().min(1).optional(),
  binaryWindows: z.string().min(1).optional(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  /** Paths relative to game/ prepended to LD_LIBRARY_PATH on Linux. */
  libraryPathRelative: z.array(SkillPathSegmentSchema).default([]),
  preferStartScript: z.boolean().default(true),
  /**
   * OS working directory relative to game/ (identity cwd stays game/).
   * Required for PEs that Access-Violate when launched from the jail root
   * (Bannerlord DedicatedCustomServer.Starter → bin/Win64_Shipping_Server).
   */
  workingDirectory: SkillPathSegmentSchema.optional(),
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
  /**
   * Extra container command args (Docker `Cmd`), appended to the image ENTRYPOINT.
   * Use for images that require CLI flags (e.g. SuperTuxKart `--lan-server=…`).
   */
  dockerArgs: z.array(z.string()).default([]),
  /** Container path for the server game/ bind mount. */
  dockerDataMount: z.string().min(1).default("/data"),
  /**
   * `docker run -t`. Windows-container engines default this on at create time
   * even when unset (console images such as har0x/sbox-server).
   */
  dockerTty: z.boolean().optional(),
  /** Windows container isolation. Omit to use the daemon default. */
  dockerIsolation: z.enum(["process", "hyperv"]).optional(),
  /** SteamCMD dedicated-server app id (catalog Steam skills). */
  steamAppId: z.number().int().positive().optional(),
  /**
   * HLDS multi-mod app 90: SteamCMD `+app_set_config <appId> mod <steamMod>`
   * before `+app_update` (cstrike, czero, valve, tfc, …).
   */
  steamMod: z.string().min(1).optional(),
  /**
   * SteamCMD `+app_update <appId> -beta <name>` on every install host
   * (e.g. The Isle `evrima` — required on Windows, not a Linux-only depot).
   */
  steamBeta: z.string().min(1).optional(),
  /**
   * SteamCMD `+app_update <appId> -beta <name>` applied only on Linux install hosts
   * (e.g. HumanitZ `linuxbranch` — Windows uses the default depot).
   */
  steamBetaLinux: z.string().min(1).optional(),
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

function applyEnshroudedPortFix(meta: SkillMetadata): SkillMetadata {
  const ports = meta.ports.map((p) => {
    if (
      p.name === "game" &&
      p.protocol === "udp" &&
      p.default === ENSHROUDED_LEGACY_GAME_PORT
    ) {
      return { ...p, default: ENSHROUDED_QUERY_PORT };
    }
    return p;
  });
  const hasQuery = ports.some(
    (p) => p.name === "query" && p.protocol === "udp" && p.default === ENSHROUDED_QUERY_PORT,
  );
  return {
    ...meta,
    ports: hasQuery
      ? ports
      : [...ports, { name: "query", protocol: "udp", default: ENSHROUDED_QUERY_PORT }],
    queryPortName: meta.queryPortName?.trim() || "query",
  };
}

function applyTheIsleSteamBetaFix(meta: SkillMetadata): SkillMetadata {
  if (meta.steamBeta?.trim()) return meta;
  return { ...meta, steamBeta: THE_ISLE_STEAM_BETA };
}

/**
 * Remap known stale catalog fields before install / join / matrix.
 * Does not rewrite on-disk YAML — catalog bump can drop the overlay later.
 */
export function applyKnownSkillMetadataFixes(meta: SkillMetadata): SkillMetadata {
  let next = meta;
  if (next.name === "games.enshrouded") next = applyEnshroudedPortFix(next);
  if (next.name === THE_ISLE_SKILL) next = applyTheIsleSteamBetaFix(next);
  return next;
}

/** Parse catalog YAML/JSON and apply known-title port / dialect overlays. */
export function parseSkillMetadata(raw: unknown): SkillMetadata {
  return applyKnownSkillMetadataFixes(SkillMetadataSchema.parse(raw));
}

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
