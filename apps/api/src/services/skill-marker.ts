import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  AdminDialectSchema,
  ContainerSupportSchema,
  QueryDialectSchema,
  SkillJoinSchema,
  SkillNativeSchema,
  type AdminDialect,
  type ContainerSupport,
  type QueryDialect,
  type SkillJoin,
  type SkillNative,
} from "@playon/shared";
import type { SkillEntry } from "./skills.js";

/** Per-server `skill.json` pin written at provision / import / reinstall. */
export type SkillMarker = {
  skillName: string;
  version: string;
  runtimeMode: string;
  containerSupport: ContainerSupport;
  dockerImage?: string;
  dockerEnv?: Record<string, string>;
  dockerArgs?: string[];
  dockerDataMount?: string;
  dockerTty?: boolean;
  dockerIsolation?: "process" | "hyperv";
  steamAppId?: number;
  steamMod?: string;
  steamBetaLinux?: string;
  adminDialect?: AdminDialect;
  queryDialect?: QueryDialect;
  queryPortName?: string;
  queryConnector?: string;
  join?: SkillJoin;
  native?: SkillNative;
  dependencies?: string[];
  minRamMb?: number;
  nodeId: string | null;
  managedFrom?: string;
  managedAt?: string;
  nodeAuthoritative?: boolean;
};

export const SkillMarkerSchema = z.object({
  skillName: z.string().min(1),
  version: z.string().min(1),
  runtimeMode: z.string().min(1),
  containerSupport: ContainerSupportSchema,
  dockerImage: z.string().min(1).optional(),
  dockerEnv: z.record(z.string(), z.string()).optional(),
  dockerArgs: z.array(z.string()).optional(),
  dockerDataMount: z.string().min(1).optional(),
  dockerTty: z.boolean().optional(),
  dockerIsolation: z.enum(["process", "hyperv"]).optional(),
  steamAppId: z.number().int().positive().optional(),
  steamMod: z.string().min(1).optional(),
  steamBetaLinux: z.string().min(1).optional(),
  adminDialect: AdminDialectSchema.optional(),
  queryDialect: QueryDialectSchema.optional(),
  queryPortName: z.string().min(1).optional(),
  queryConnector: z.string().min(1).optional(),
  join: SkillJoinSchema.optional(),
  native: SkillNativeSchema.optional(),
  dependencies: z.array(z.string()).optional(),
  minRamMb: z.number().int().positive().optional(),
  nodeId: z.string().nullable(),
  managedFrom: z.string().min(1).optional(),
  managedAt: z.string().min(1).optional(),
  nodeAuthoritative: z.boolean().optional(),
});

const skillJsonPath = (dataPath: string) => path.join(dataPath, "skill.json");

/** Build the marker object written by ServerService.createFromSkill / reinstall. */
export function buildSkillMarker(
  skill: SkillEntry,
  runtimeMode: string,
  nodeId: string | null,
): SkillMarker {
  const m = skill.metadata;
  return {
    skillName: m.name,
    version: m.version,
    runtimeMode,
    containerSupport: m.containerSupport,
    dockerImage: m.dockerImage,
    dockerEnv: m.dockerEnv,
    dockerArgs: m.dockerArgs,
    dockerDataMount: m.dockerDataMount,
    dockerTty: m.dockerTty,
    dockerIsolation: m.dockerIsolation,
    steamAppId: m.steamAppId,
    steamMod: m.steamMod,
    steamBetaLinux: m.steamBetaLinux,
    adminDialect: m.adminDialect,
    queryDialect: m.queryDialect,
    queryPortName: m.queryPortName,
    queryConnector: m.queryConnector,
    join: m.join,
    native: m.native,
    dependencies: m.dependencies,
    minRamMb: m.minRamMb,
    nodeId,
  };
}

export function validateSkillMarker(raw: unknown): SkillMarker {
  return SkillMarkerSchema.parse(raw);
}

/** Read `skill.json`; null when missing or unreadable. Partial when older/incomplete. */
export function readSkillMarker(dataPath: string): Partial<SkillMarker> | null {
  try {
    const raw = JSON.parse(fs.readFileSync(skillJsonPath(dataPath), "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return null;
    return raw as Partial<SkillMarker>;
  } catch {
    return null;
  }
}

export function writeSkillMarker(
  dataPath: string,
  marker: SkillMarker,
  extras?: Record<string, unknown>,
): void {
  fs.mkdirSync(path.join(dataPath, "game"), { recursive: true });
  const payload = extras ? { ...marker, ...extras } : marker;
  fs.writeFileSync(skillJsonPath(dataPath), JSON.stringify(payload, null, 2));
}

/** Same shape as the former ServerService.writeSkillMarker. */
export function writeSkillMarkerFromSkill(
  dataPath: string,
  skill: SkillEntry,
  runtimeMode: string,
  nodeId: string | null,
  extras?: Record<string, unknown>,
): void {
  writeSkillMarker(dataPath, buildSkillMarker(skill, runtimeMode, nodeId), extras);
}
