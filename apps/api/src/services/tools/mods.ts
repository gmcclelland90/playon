import { readSkillMarker } from "../skill-marker.js";
import {
  dialectLogRelPaths,
  extractModErrors,
  resolveModDialect,
  type ModErrorDialect,
} from "../mods-errors.js";
import { ServerFileStoreError, type ServerFileStore } from "../server-file-store.js";
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

/**
 * AI-modding read path: extract structured mod/plugin errors from a server's
 * runtime logs (and well-known dialect log files when present).
 */
export const modsToolModule: ToolModule = ({ plane }) => {
  const { servers } = plane;

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
  ];
};
