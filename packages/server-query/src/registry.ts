import type { QueryDialect } from "@playon/shared";
import { createGamedigConnector } from "./gamedig-adapter.js";
import { minecraftStatusConnector } from "./connectors/minecraft-status.js";
import { createSkillModuleConnector } from "./skill-module/loader.js";
import type { Connector, SkillModuleResolve } from "./types.js";

const builtIns: Record<Exclude<QueryDialect, "none" | "skill_module">, Connector> = {
  minecraft_status: minecraftStatusConnector,
  a2s: createGamedigConnector({ id: "a2s", gamedigType: "rust", gameLabel: "Rust" }),
  valheim: createGamedigConnector({
    id: "valheim",
    gamedigType: "valheim",
    useQueryPort: true,
    gameLabel: "Valheim",
  }),
  unreal: createGamedigConnector({
    id: "unreal",
    gamedigType: "unrealtournament",
    useQueryPort: true,
    gameLabel: "Unreal Tournament",
  }),
  terraria: createGamedigConnector({
    id: "terraria",
    gamedigType: "terrariatshock",
    gameLabel: "Terraria",
  }),
  factorio: createGamedigConnector({ id: "factorio", gamedigType: "factorio", gameLabel: "Factorio" }),
};

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
    return builtIns[args.queryDialect] ?? null;
  }

  listBuiltInDialects(): QueryDialect[] {
    return Object.keys(builtIns) as QueryDialect[];
  }
}

export const defaultRegistry = new ConnectorRegistry();
