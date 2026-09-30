import { normalizePlayonModDialect } from "@playon/shared";
import { readSkillMarker } from "../skill-marker.js";
import {
  dialectLogRelPaths,
  extractModErrors,
  resolveModDialect,
  type ModErrorDialect,
} from "../mods-errors.js";
import {
  PRE_MOD_DEPLOY_LABEL,
  ModsWorkspaceError,
  deployAuthoredMod,
  scaffoldModWorkspace,
} from "../mods-workspace.js";
import { ServerFileStoreError, type ServerFileStore } from "../server-file-store.js";
import { withSnapshot } from "../snapshots.js";
import { serverTool, type ToolModule } from "./types.js";

const DEFAULT_LINES = 200;
const MAX_LINES = 400;
const FILE_TAIL_CHARS = 64_000;

async function tryReadLogFile(
  files: ServerFileStore,
  relPath: string,
): Promise<string | null> {
  try {
    const result = await files.readText(relPath, { maxBytes: FILE_TAIL_CHARS });
    return result.content;
  } catch (err) {
    if (err instanceof ServerFileStoreError && err.code === "not_found") return null;
    return null;
  }
}

function resolveBoundDialect(
  override: unknown,
  skillName: string | null | undefined,
  game: string | null | undefined,
): string {
  if (typeof override === "string" && override.trim()) {
    const fromJson = normalizePlayonModDialect(override);
    if (fromJson) return fromJson;
    const fromErrors = resolveModDialect(override.trim());
    if (fromErrors !== "unknown" && fromErrors !== "none") return fromErrors;
  }
  const fromJson = normalizePlayonModDialect(skillName ?? "") ?? normalizePlayonModDialect(game ?? "");
  if (fromJson) return fromJson;
  return resolveModDialect(skillName ?? game);
}

function toolError(err: unknown): { error: string; detail?: string } {
  if (err instanceof ModsWorkspaceError) return { error: err.code, detail: err.message };
  if (err instanceof ServerFileStoreError) return { error: err.code, detail: err.message };
  const message = err instanceof Error ? err.message : "tool_failed";
  return { error: message };
}

/**
 * AI-modding tools: read-only error extract, jailed `mods-src/` scaffold, and
 * confirm-gated snapshot-then-deploy into dialect live paths.
 */
export const modsToolModule: ToolModule = ({ plane }) => {
  const { servers, snapshots } = plane;

  return [
    serverTool({
      def: {
        name: "mods_errors",
        description:
          "Extract mod/plugin load errors from a server's recent logs using the game's mod dialect (Project Zomboid Lua STACK TRACE / nil calls; Paper plugin enable/load exceptions). Read-only. Prefer after deploy/restart before guessing fixes.",
        parameters: {
          type: "object",
          properties: {
            serverId: { type: "string" },
            lines: {
              type: "number",
              description: `Runtime log lines to sample (default ${DEFAULT_LINES}, max ${MAX_LINES})`,
            },
            dialect: {
              type: "string",
              description:
                "Optional dialect override: project-zomboid | minecraft-paper | rust-oxide | garrys-mod | terraria-tmod | factorio",
            },
          },
          required: ["serverId"],
        },
      },
      surface: { skill: "modder", activityVerb: "read" },
      handler: async (args, { serverId }) => {
        const server = await servers.get(serverId);
        if (!server) return { error: `unknown_server: ${serverId}` };

        const marker = readSkillMarker(server.dataPath);
        const override =
          typeof args.dialect === "string" && args.dialect.trim()
            ? resolveModDialect(String(args.dialect).trim())
            : null;
        const dialect: ModErrorDialect =
          override && override !== "unknown"
            ? override
            : resolveModDialect(marker?.skillName ?? server.game);

        const requested =
          args.lines !== undefined ? Number(args.lines) : DEFAULT_LINES;
        const lineCount = Number.isFinite(requested)
          ? Math.min(MAX_LINES, Math.max(1, Math.floor(requested)))
          : DEFAULT_LINES;

        const tail = await servers.tailLogs(serverId, lineCount);
        if (!tail) return { error: `unknown_server: ${serverId}` };

        const chunks: string[] = [tail.lines.join("\n")];
        const logSources: string[] = ["runtime"];

        const files = await servers.files(serverId);
        for (const rel of dialectLogRelPaths(dialect)) {
          const content = await tryReadLogFile(files, rel);
          if (content && content.trim()) {
            chunks.push(content);
            logSources.push(rel);
          }
        }

        const text = chunks.join("\n");
        const errors = extractModErrors(dialect, text);

        return {
          serverId,
          dialect,
          skillName: marker?.skillName ?? null,
          errors,
          logSource: logSources.join("+"),
          linesSampled: tail.lines.length,
        };
      },
    }),

    serverTool({
      def: {
        name: "mods_scaffold",
        description:
          "Create a jailed mods-src/<modId>/ workspace with a dialect skeleton and playon-mod.json. Never on the game load path. Refuses to clobber a non-empty folder unless overwrite is confirmed.",
        requiresConfirm: true,
        parameters: {
          type: "object",
          properties: {
            serverId: { type: "string" },
            modId: { type: "string", description: "Folder name under mods-src/ (no path separators)" },
            displayName: { type: "string" },
            dialect: {
              type: "string",
              description:
                "Optional dialect override: project-zomboid | minecraft-paper | rust-oxide | garrys-mod | terraria-tmod | factorio",
            },
            clientNeed: { type: "string", description: "none | auto | manual" },
            overwrite: {
              type: "boolean",
              description: "Replace an existing non-empty workspace (still confirm-gated)",
            },
          },
          required: ["serverId", "modId"],
        },
      },
      surface: {
        skill: "modder",
        confirmAction: "create a mod workspace in this server folder",
        activityVerb: "write",
      },
      handler: async (args, { serverId }) => {
        const server = await servers.get(serverId);
        if (!server) return { error: `unknown_server: ${serverId}` };
        const marker = readSkillMarker(server.dataPath);
        const dialect = resolveBoundDialect(
          args.dialect,
          marker?.skillName,
          server.game,
        );
        try {
          const files = await servers.files(serverId);
          const result = await scaffoldModWorkspace({
            files,
            modId: String(args.modId),
            dialect,
            displayName: typeof args.displayName === "string" ? args.displayName : undefined,
            clientNeed:
              args.clientNeed === "none" ||
              args.clientNeed === "auto" ||
              args.clientNeed === "manual"
                ? args.clientNeed
                : undefined,
            overwrite: Boolean(args.overwrite),
          });
          return { serverId, ...result };
        } catch (err) {
          return toolError(err);
        }
      },
    }),

    serverTool({
      def: {
        name: "mods_deploy",
        description:
          "Snapshot the server (pre-mod-deploy), then copy mods-src/<modId>/ (minus playon-mod.json) into the dialect live path and patch enable lists. Does not restart. PZ: mods/<id>/ + Mods=; Paper: plugins/ by presence.",
        requiresConfirm: true,
        parameters: {
          type: "object",
          properties: {
            serverId: { type: "string" },
            modId: { type: "string" },
            dialect: {
              type: "string",
              description: "Optional dialect override (must not be none/unknown)",
            },
          },
          required: ["serverId", "modId"],
        },
      },
      surface: {
        skill: "modder",
        confirmAction: "snapshot this server and install the authored mod",
        activityVerb: "write",
      },
      handler: async (args, { serverId }) => {
        const server = await servers.get(serverId);
        if (!server) return { error: `unknown_server: ${serverId}` };
        const marker = readSkillMarker(server.dataPath);
        const dialect = resolveBoundDialect(
          args.dialect,
          marker?.skillName,
          server.game,
        );
        try {
          const files = await servers.files(serverId);
          let snapshotId: string | undefined;
          const deployed = await deployAuthoredMod({
            files,
            modId: String(args.modId),
            dialect,
            snapshotFirst: async (fn) =>
              withSnapshot(snapshots, serverId, PRE_MOD_DEPLOY_LABEL, async () => {
                const snaps = await snapshots.list(serverId);
                snapshotId = snaps.find((s) => s.label === PRE_MOD_DEPLOY_LABEL)?.id;
                return fn();
              }),
          });
          return {
            serverId,
            snapshotId: snapshotId ?? null,
            destPath: deployed.destPath,
            enablePatched: deployed.enablePatched,
            clientNeed: deployed.clientNeed,
            copied: deployed.copied,
            restartRequired: true as const,
          };
        } catch (err) {
          return toolError(err);
        }
      },
    }),
  ];
};
