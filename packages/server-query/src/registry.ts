import type { QueryDialect } from "@playon/shared";
import { createGamedigConnector } from "./gamedig-adapter.js";
import { minecraftStatusConnector } from "./connectors/minecraft-status.js";
import { createSkillModuleConnector } from "./skill-module/loader.js";
import type { Connector, SkillModuleResolve } from "./types.js";

/** Built-in dialects only — `none` and `skill_module` are special cases outside this set. */
export type BuiltInQueryDialect = Exclude<QueryDialect, "none" | "skill_module">;

/** Which advertised port the connector should probe first. */
export type PortPreference = "game" | "query";

export type DialectDescriptor = {
  id: BuiltInQueryDialect;
  portPreference: PortPreference;
  connector: Connector;
};

const descriptors: DialectDescriptor[] = [
  {
    id: "minecraft_status",
    portPreference: "game",
    connector: minecraftStatusConnector,
  },
  {
    id: "a2s",
    portPreference: "query",
    connector: createGamedigConnector({ id: "a2s", gamedigType: "rust", gameLabel: "Rust" }),
  },
  {
    id: "valheim",
    portPreference: "query",
    connector: createGamedigConnector({
      id: "valheim",
      gamedigType: "valheim",
      useQueryPort: true,
      gameLabel: "Valheim",
    }),
  },
  {
    id: "unreal",
    portPreference: "query",
    connector: createGamedigConnector({
      id: "unreal",
      gamedigType: "unrealtournament",
      useQueryPort: true,
      gameLabel: "Unreal Tournament",
    }),
  },
  {
    id: "terraria",
    portPreference: "query",
    connector: createGamedigConnector({
      id: "terraria",
      gamedigType: "terrariatshock",
      gameLabel: "Terraria",
    }),
  },
  {
    id: "factorio",
    portPreference: "query",
    connector: createGamedigConnector({ id: "factorio", gamedigType: "factorio", gameLabel: "Factorio" }),
  },
];

const byId = Object.fromEntries(descriptors.map((d) => [d.id, d])) as Record<
  BuiltInQueryDialect,
  DialectDescriptor
>;

/** Stable list of built-in dialect ids (excludes `none` / `skill_module`). */
export const builtInDialectIds: BuiltInQueryDialect[] = descriptors.map((d) => d.id);

export function listDialectDescriptors(): readonly DialectDescriptor[] {
  return descriptors;
}

export function getDialectDescriptor(id: BuiltInQueryDialect): DialectDescriptor | undefined {
  return byId[id];
}

/**
 * Port preference for a dialect. Built-ins come from the descriptor;
 * `skill_module` / `none` / unknown default to query port.
 */
export function portPreferenceForDialect(dialect: QueryDialect): PortPreference {
  if (dialect === "none" || dialect === "skill_module") return "query";
  return byId[dialect as BuiltInQueryDialect]?.portPreference ?? "query";
}

/** Pick game vs query port for a dialect using the registry descriptor. */
export function primaryPortForDialect(
  dialect: QueryDialect,
  ports: { gamePort: number; queryPort: number },
): number {
  return portPreferenceForDialect(dialect) === "game" ? ports.gamePort : ports.queryPort;
}

/** Tool / schema enum: built-ins plus the two special cases. */
export function queryDialectToolEnum(): QueryDialect[] {
  return ["none", ...builtInDialectIds, "skill_module"];
}

export type ResolveConnectorArgs = {
  queryDialect: QueryDialect;
  /** Required when queryDialect is skill_module. */
  skillModule?: SkillModuleResolve;
};

export class ConnectorRegistry {
  resolve(args: ResolveConnectorArgs): Connector | null {
    if (args.queryDialect === "none") return null;
    if (args.queryDialect === "skill_module") {
      if (!args.skillModule?.skillDir) {
        throw new Error("skill_module_requires_skill_dir");
      }
      return createSkillModuleConnector(args.skillModule);
    }
    return byId[args.queryDialect]?.connector ?? null;
  }

  listBuiltInDialects(): BuiltInQueryDialect[] {
    return [...builtInDialectIds];
  }

  listDialectDescriptors(): readonly DialectDescriptor[] {
    return listDialectDescriptors();
  }

  portPreference(dialect: QueryDialect): PortPreference {
    return portPreferenceForDialect(dialect);
  }
}

export const defaultRegistry = new ConnectorRegistry();
