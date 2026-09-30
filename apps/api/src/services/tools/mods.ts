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
  assertSafeModId,
  collectModsSrcLuaSources,
  deployAuthoredMod,
  jailRel,
  modsSrcRel,
  scaffoldModWorkspace,
} from "../mods-workspace.js";
import {
  FalAssetsError,
  extensionForContentType,
  generateFalImage,
  resolveFalApiKey,
} from "../fal-assets.js";
import { FAL_SETTINGS_KEY, getSetting, type FalSettings } from "../settings.js";
import { checkPzLuaSources } from "../mods-lua-check.js";
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
  const { servers, snapshots, db, config } = plane;

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
        name: "mods_lua_check",
        description:
          "Static B42 Lua API guard over mods-src/<modId>/ (jailed). Flags known-nil calls such as getFavoriteHeight() and InventoryItemFactory.CreateItem. Run before mods_deploy for Project Zomboid.",
        parameters: {
          type: "object",
          properties: {
            serverId: { type: "string" },
            modId: { type: "string" },
          },
          required: ["serverId", "modId"],
        },
      },
      surface: {
        skill: "modder",
        activityVerb: "read",
      },
      handler: async (args, { serverId }) => {
        const server = await servers.get(serverId);
        if (!server) return { error: `unknown_server: ${serverId}` };
        try {
          const files = await servers.files(serverId);
          const sources = await collectModsSrcLuaSources(files, String(args.modId));
          const result = checkPzLuaSources(sources);
          return {
            serverId,
            modId: String(args.modId),
            ok: result.ok,
            scannedFiles: result.scannedFiles,
            findings: result.findings,
          };
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
          if (dialect === "project-zomboid") {
            const sources = await collectModsSrcLuaSources(files, String(args.modId));
            const check = checkPzLuaSources(sources);
            if (!check.ok) {
              return {
                error: "lua_api_check_failed",
                code: "lua_api_check_failed",
                modId: String(args.modId),
                scannedFiles: check.scannedFiles,
                findings: check.findings.filter((f) => f.severity === "error"),
                hint: "Fix mods-src Lua (see findings) or run mods_lua_check; deploy refused before snapshot.",
              };
            }
          }
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

    serverTool({
      def: {
        name: "mods_assets_generate",
        description:
          "Generate an image asset with the host's BYO fal.ai key and write it under mods-src/<modId>/assets/ (jailed). Disabled until Settings → Mod assets has a fal key (hosts pay fal directly). Confirm-gated. Never echoes the key.",
        requiresConfirm: true,
        parameters: {
          type: "object",
          properties: {
            serverId: { type: "string" },
            modId: { type: "string" },
            prompt: { type: "string", description: "Text-to-image prompt" },
            fileName: {
              type: "string",
              description: "Optional filename under assets/ (default asset-<ts>.png)",
            },
            model: {
              type: "string",
              description: "Optional fal model id (default fal-ai/flux/schnell)",
            },
          },
          required: ["serverId", "modId", "prompt"],
        },
      },
      surface: {
        skill: "modder",
        confirmAction: "generate a mod asset with your fal.ai key",
        activityVerb: "write",
      },
      handler: async (args, { serverId }) => {
        const server = await servers.get(serverId);
        if (!server) return { error: `unknown_server: ${serverId}` };
        const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
        if (!prompt) return { error: "prompt_required" };
        let modId: string;
        try {
          modId = assertSafeModId(String(args.modId));
        } catch (err) {
          return toolError(err);
        }
        const stored = await getSetting<FalSettings>(db, FAL_SETTINGS_KEY);
        const apiKey = resolveFalApiKey(stored, config.sessionSecret);
        if (!apiKey) {
          return {
            error: "fal_key_missing",
            hint: "Add your fal.ai API key in Settings → Mod assets (https://fal.ai/dashboard/keys). PlayOn does not bill fal.",
          };
        }
        try {
          const files = await servers.files(serverId);
          const listing = await files.list(modsSrcRel(modId)).catch(() => null);
          if (!listing) {
            return { error: "workspace_not_found", detail: `mods-src/${modId}` };
          }
          const generated = await generateFalImage({
            apiKey,
            prompt,
            model: typeof args.model === "string" ? args.model : undefined,
          });
          const ext = extensionForContentType(generated.contentType);
          const rawName =
            typeof args.fileName === "string" && args.fileName.trim()
              ? args.fileName.trim()
              : `asset-${Date.now()}.${ext}`;
          const base = rawName.replace(/\\/g, "/").split("/").pop() || rawName;
          if (!base || base.includes("..")) return { error: "unsafe_fileName" };
          const dest = jailRel(modsSrcRel(modId), "assets", base);
          await files.ensureDir(jailRel(modsSrcRel(modId), "assets"));
          await files.writeBytes(dest, Buffer.from(generated.bytes));
          return {
            serverId,
            modId,
            path: dest,
            model: generated.model,
            bytes: generated.bytes.byteLength,
            contentType: generated.contentType,
            // Do not return fal CDN URL to avoid leaking into player panel accidentally.
          };
        } catch (err) {
          if (err instanceof FalAssetsError) {
            return { error: err.code, detail: err.message };
          }
          return toolError(err);
        }
      },
    }),
  ];
};
