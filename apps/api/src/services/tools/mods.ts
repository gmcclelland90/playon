import { readSkillMarker } from "../skill-marker.js";
import {
  dialectLogRelPaths,
  extractModErrors,
  type ModErrorDialect,
} from "../mods-errors.js";
import {
  assertModId,
  dialectDeployDest,
  modsSrcRel,
  playonModJsonRel,
  patchFactorioModList,
  patchPzModsIni,
  resolveDialectForServer,
  scaffoldFiles,
  type PlayOnModMeta,
} from "../mods-workspace.js";
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

async function pathExists(files: ServerFileStore, relPath: string): Promise<boolean> {
  try {
    const parent = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : ".";
    const base = relPath.includes("/") ? relPath.slice(relPath.lastIndexOf("/") + 1) : relPath;
    const entries = await files.list(parent || ".");
    return entries.some((e) => e.name === base);
  } catch {
    return false;
  }
}

async function copyTree(
  files: ServerFileStore,
  fromDir: string,
  toDir: string,
  skipNames: Set<string>,
): Promise<string[]> {
  const copied: string[] = [];
  const entries = await files.list(fromDir);
  await files.ensureDir(toDir);
  for (const entry of entries) {
    if (skipNames.has(entry.name)) continue;
    const from = `${fromDir}/${entry.name}`;
    const to = `${toDir}/${entry.name}`;
    if (entry.type === "dir") {
      copied.push(...(await copyTree(files, from, to, skipNames)));
    } else {
      await files.copy(from, to, { overwrite: true });
      copied.push(to);
    }
  }
  return copied;
}

async function findPzServerIni(files: ServerFileStore): Promise<string | null> {
  const candidates = [
    "Server/servertest.ini",
    "servertest.ini",
    "Zomboid/Server/servertest.ini",
    "server.ini",
  ];
  for (const c of candidates) {
    if (await pathExists(files, c)) return c;
  }
  // shallow search under Server/
  try {
    const entries = await files.list("Server");
    const ini = entries.find((e) => e.type === "file" && e.name.endsWith(".ini"));
    if (ini) return `Server/${ini.name}`;
  } catch {
    /* no Server/ */
  }
  return null;
}

/**
 * AI-modding tools: errors (read-only), scaffold, and confirm-gated deploy.
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
        const dialect: ModErrorDialect = resolveDialectForServer(
          marker?.skillName ?? server.game,
          typeof args.dialect === "string" ? args.dialect : null,
        );

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

        return {
          serverId,
          dialect,
          skillName: marker?.skillName ?? null,
          errors: extractModErrors(dialect, chunks.join("\n")),
          logSource: logSources.join("+"),
          linesSampled: tail.lines.length,
        };
      },
    }),

    serverTool({
      def: {
        name: "mods_scaffold",
        description:
          "Create a jailed mods-src/<modId>/ workspace with dialect skeleton and playon-mod.json. Does not install into the live game tree — use mods_deploy after editing.",
        requiresConfirm: true,
        parameters: {
          type: "object",
          properties: {
            serverId: { type: "string" },
            modId: {
              type: "string",
              description: "Folder id (letters/digits/_/-)",
            },
            displayName: { type: "string" },
            dialect: {
              type: "string",
              description: "Override dialect when skill mapping is unknown",
            },
            overwrite: {
              type: "boolean",
              description: "Replace an existing non-empty mods-src/<modId>/",
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

        let modId: string;
        try {
          modId = assertModId(String(args.modId));
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }

        const marker = readSkillMarker(server.dataPath);
        const dialect = resolveDialectForServer(
          marker?.skillName ?? server.game,
          typeof args.dialect === "string" ? args.dialect : null,
        );
        if (dialect === "none" || dialect === "unknown") {
          return {
            error: "unsupported_dialect",
            skillName: marker?.skillName ?? server.game,
            hint: "Pass dialect explicitly (project-zomboid, minecraft-paper, …)",
          };
        }

        const root = modsSrcRel(modId);
        const files = await servers.files(serverId);
        const exists = await pathExists(files, root);
        if (exists) {
          const listing = await files.list(root).catch(() => []);
          if (listing.length > 0 && !args.overwrite) {
            return {
              error: "mods_src_exists",
              path: root,
              hint: "Pass overwrite=true with confirm to replace",
            };
          }
        }

        const displayName =
          typeof args.displayName === "string" && args.displayName.trim()
            ? args.displayName.trim()
            : modId;
        const skeleton = scaffoldFiles(dialect, modId, displayName);
        await files.ensureDir(root);
        const written: string[] = [];
        for (const [rel, content] of Object.entries(skeleton)) {
          const full = `${root}/${rel}`;
          const parent = full.includes("/") ? full.slice(0, full.lastIndexOf("/")) : root;
          await files.ensureDir(parent);
          await files.writeText(full, content);
          written.push(full);
        }

        return {
          serverId,
          modId,
          dialect,
          path: root,
          files: written,
        };
      },
    }),

    serverTool({
      def: {
        name: "mods_deploy",
        description:
          "Snapshot the server, then copy mods-src/<modId>/ (except playon-mod.json) into the dialect live path and patch enable lists (PZ Mods=, Factorio mod-list.json). Does not restart — call servers_restart after.",
        requiresConfirm: true,
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
        confirmAction: "snapshot this server and install the authored mod",
        activityVerb: "write",
        xp: { xp: 25, reason: "mod_deploy" },
      },
      handler: async (args, { serverId }) => {
        const server = await servers.get(serverId);
        if (!server) return { error: `unknown_server: ${serverId}` };

        let modId: string;
        try {
          modId = assertModId(String(args.modId));
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }

        const files = await servers.files(serverId);
        const srcRoot = modsSrcRel(modId);
        if (!(await pathExists(files, srcRoot))) {
          return { error: "mods_src_missing", path: srcRoot };
        }

        let meta: PlayOnModMeta | null = null;
        try {
          const raw = await files.readText(playonModJsonRel(modId));
          meta = JSON.parse(raw.content) as PlayOnModMeta;
        } catch {
          /* optional */
        }

        const marker = readSkillMarker(server.dataPath);
        const dialect: ModErrorDialect =
          meta?.dialect && meta.dialect !== "unknown"
            ? meta.dialect
            : resolveDialectForServer(marker?.skillName ?? server.game);

        const dest = dialectDeployDest(dialect, modId);
        if (!dest.destDir || dest.enable === "unsupported") {
          return { error: "unsupported_dialect", dialect };
        }

        // Refuse obvious Workshop cache targets
        if (/workshop/i.test(dest.destDir)) {
          return { error: "refuse_workshop_cache", destPath: dest.destDir };
        }

        const snap = await snapshots.create(serverId, "pre-mod-deploy");

        const copied = await copyTree(
          files,
          srcRoot,
          dest.destDir,
          new Set(["playon-mod.json"]),
        );

        let enablePatched = false;
        if (dest.enable === "mods_ini") {
          const iniPath = await findPzServerIni(files);
          if (iniPath) {
            const current = await files.readText(iniPath);
            const { content, patched } = patchPzModsIni(current.content, modId);
            if (patched) {
              await files.writeText(iniPath, content);
              enablePatched = true;
            }
          }
        } else if (dest.enable === "mod_list_json") {
          const listPath = "mods/mod-list.json";
          let current = '{"mods":[]}';
          try {
            current = (await files.readText(listPath)).content;
          } catch {
            await files.ensureDir("mods");
          }
          const { content, patched } = patchFactorioModList(current, modId);
          if (patched) {
            await files.writeText(listPath, content);
            enablePatched = true;
          }
        } else if (dest.enable === "presence") {
          enablePatched = copied.length > 0;
        }

        return {
          serverId,
          modId,
          dialect,
          snapshotId: snap.id,
          destPath: dest.destDir,
          copied,
          enablePatched,
          clientNeed: meta?.clientNeed ?? "none",
          restartRequired: true,
        };
      },
    }),
  ];
};
