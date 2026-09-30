import {
  EXPERIENCE_NAME_PREFIX,
  ExperienceManifestSchema,
  PLAYON_MOD_JSON,
  type ExperienceManifest,
} from "@playon/shared";
import {
  ExperiencePackageError,
  applyExperienceInstall,
  buildExperienceZip,
} from "../experiences.js";
import {
  collectModsSrcTextSources,
  readPlayonModManifest,
} from "../mods-workspace.js";
import { checkPzLuaSources } from "../mods-lua-check.js";
import { ServerFileStoreError } from "../server-file-store.js";
import {
  downloadCatalogExperienceZip,
  fetchExperiencesCatalogDetailed,
  findCatalogExperience,
  resolveExperiencesCatalogUrl,
  searchExperiencesCatalog,
} from "../experiences-catalog.js";
import {
  EXPERIENCES_CATALOG_KEY,
  getSetting,
  type ExperiencesCatalogSettings,
} from "../settings.js";
import { globalTool, serverTool, type ToolModule } from "./types.js";

function toolError(err: unknown): { error: string; detail?: string; findings?: unknown } {
  if (err instanceof ExperiencePackageError) {
    return { error: err.code, detail: err.message, findings: err.findings };
  }
  if (err instanceof ServerFileStoreError) return { error: err.code, detail: err.message };
  const message = err instanceof Error ? err.message : "tool_failed";
  return { error: message };
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/**
 * experiences.* author/install + public catalog share tools (#995 / #1000). Install never creates a sibling server.
 */
export const experiencesToolModule: ToolModule = ({ plane }) => {
  const { servers, snapshots, playerPanel, db } = plane;

  async function catalogUrl(): Promise<string> {
    const stored = await getSetting<ExperiencesCatalogSettings>(db, EXPERIENCES_CATALOG_KEY);
    return resolveExperiencesCatalogUrl(
      process.env.PLAYON_EXPERIENCES_CATALOG_URL,
      stored?.catalogUrl,
    );
  }

  return [
    serverTool({
      def: {
        name: "experiences_export",
        description:
          "Build an experiences.* zip from mods-src mods + overlays + optional panel summary (jailed). Writes experiences-out/<file> and returns base64. Runs PZ lua lint. Does not publish to playon.games.",
        requiresConfirm: true,
        parameters: {
          type: "object",
          properties: {
            serverId: { type: "string" },
            name: {
              type: "string",
              description: "experiences.<id>",
            },
            version: { type: "string" },
            displayName: { type: "string" },
            baseGame: { type: "string", description: "games.* skill name" },
            modIds: {
              type: "array",
              items: { type: "string" },
              description: "mods-src/<modId>/ folders to embed",
            },
            overlays: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  path: { type: "string" },
                  content: { type: "string" },
                },
                required: ["path", "content"],
              },
            },
            panelSummary: { type: "string" },
            description: { type: "string" },
          },
          required: ["serverId", "name", "version", "displayName", "baseGame", "modIds"],
        },
      },
      surface: {
        skill: "modder",
        confirmAction: "export an experiences package from this server",
        activityVerb: "write",
      },
      handler: async (args, { serverId }) => {
        const server = await servers.get(serverId);
        if (!server) return { error: `unknown_server: ${serverId}` };
        try {
          const filesStore = await servers.files(serverId);
          const modIds = Array.isArray(args.modIds) ? args.modIds.map(String) : [];
          const packFiles: Record<string, string> = {};
          const modEntries: ExperienceManifest["mods"] = [];
          for (const modId of modIds) {
            const sources = await collectModsSrcTextSources(filesStore, modId);
            const manifest = await readPlayonModManifest(filesStore, modId);
            modEntries.push({
              modId,
              dialect: manifest.dialect,
              clientNeed: manifest.clientNeed,
            });
            if (!(PLAYON_MOD_JSON in sources)) {
              packFiles[`mods/${modId}/${PLAYON_MOD_JSON}`] = `${JSON.stringify(manifest, null, 2)}\n`;
            }
            for (const [rel, content] of Object.entries(sources)) {
              packFiles[`mods/${modId}/${rel}`] = content;
            }
          }
          const overlays = Array.isArray(args.overlays)
            ? (args.overlays as Array<{ path: string; content: string }>)
            : [];
          const manifest = ExperienceManifestSchema.parse({
            name: String(args.name),
            version: String(args.version),
            displayName: String(args.displayName),
            description: typeof args.description === "string" ? args.description : "",
            baseGame: String(args.baseGame),
            mods: modEntries,
            overlays,
            seedFiles: [],
            panel:
              typeof args.panelSummary === "string"
                ? { summary: args.panelSummary }
                : undefined,
          });
          // Pre-check PZ lua in pack
          const luaOnly: Record<string, string> = {};
          for (const [k, v] of Object.entries(packFiles)) {
            if (k.endsWith(".lua")) luaOnly[k] = v;
          }
          const luaCheck = checkPzLuaSources(luaOnly);
          if (!luaCheck.ok) {
            return {
              error: "lua_api_check_failed",
              findings: luaCheck.findings.filter((f) => f.severity === "error"),
            };
          }
          const built = buildExperienceZip({ manifest, files: packFiles });
          const outRel = `experiences-out/${built.filename}`;
          await filesStore.ensureDir("experiences-out");
          await filesStore.writeBytes(outRel, Buffer.from(built.bytes));
          return {
            serverId,
            filename: built.filename,
            path: outRel,
            bytesBase64: bytesToBase64(built.bytes),
            manifest,
            findings: built.findings,
          };
        } catch (err) {
          return toolError(err);
        }
      },
    }),

    serverTool({
      def: {
        name: "experiences_install",
        description:
          "Install an experiences.* zip onto this *existing* server (confirm + snapshot). Applies overlays and deploys embedded mods via mods_deploy path. Never creates a sibling server. Pass zipBase64 or jail-relative zipPath under experiences-out/.",
        requiresConfirm: true,
        parameters: {
          type: "object",
          properties: {
            serverId: { type: "string" },
            zipBase64: { type: "string" },
            zipPath: { type: "string" },
          },
          required: ["serverId"],
        },
      },
      surface: {
        skill: "modder",
        confirmAction: "snapshot this server and install an experience package",
        activityVerb: "write",
      },
      handler: async (args, { serverId }) => {
        const server = await servers.get(serverId);
        if (!server) return { error: `unknown_server: ${serverId}` };
        try {
          const filesStore = await servers.files(serverId);
          let zipBytes: Uint8Array;
          if (typeof args.zipBase64 === "string" && args.zipBase64.trim()) {
            zipBytes = base64ToBytes(args.zipBase64.trim());
          } else if (typeof args.zipPath === "string" && args.zipPath.trim()) {
            const rel = args.zipPath.trim().replace(/\\/g, "/");
            if (rel.includes("..") || !rel.startsWith("experiences-out/")) {
              return { error: "zip_path_must_be_under_experiences-out" };
            }
            const bin = await filesStore.readBytes(rel);
            zipBytes = new Uint8Array(bin.data);
          } else {
            return { error: "zipBase64_or_zipPath_required" };
          }
          return await applyExperienceInstall({
            serverId,
            zipBytes,
            filesStore,
            snapshots,
            playerPanel,
          });

        } catch (err) {
          return toolError(err);
        }
      },
    }),

    globalTool({
      def: {
        name: "experiences_search",
        description:
          "Search the public playon.games experiences.* catalog (beside games.*). Empty query lists the catalog. Empty/404 catalog is ok (site not published yet).",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Experience name, base game, or tags. Empty returns the full catalog.",
            },
          },
        },
      },
      surface: { skill: "modder", activityVerb: "read" },
      handler: async (args) => {
        const url = await catalogUrl();
        const q = args.query !== undefined ? String(args.query) : "";
        try {
          const fetched = await fetchExperiencesCatalogDetailed(url);
          const experiences = searchExperiencesCatalog(fetched.experiences, q);
          return {
            catalogUrl: url,
            experiences,
            warnings: fetched.warnings,
            updatedAt: fetched.updatedAt,
            unavailable: fetched.unavailable,
            note:
              fetched.unavailable === "not_found"
                ? "Experiences catalog not published on playon.games yet; Home deep links and tools are ready."
                : undefined,
          };
        } catch (err) {
          return {
            catalogUrl: url,
            experiences: [],
            error: err instanceof Error ? err.message : "catalog_unavailable",
          };
        }
      },
    }),

    serverTool({
      def: {
        name: "experiences_install_url",
        description:
          "Download an experiences.* zip from the public catalog and install onto this *existing* server (confirm + snapshot). Prefer name from experiences_search. Never creates a sibling server.",
        requiresConfirm: true,
        parameters: {
          type: "object",
          properties: {
            serverId: { type: "string" },
            name: {
              type: "string",
              description: `Catalog experience name, e.g. ${EXPERIENCE_NAME_PREFIX}demo-locker`,
            },
            downloadUrl: {
              type: "string",
              description: "Exact downloadUrl from experiences_search",
            },
          },
          required: ["serverId"],
        },
      },
      surface: {
        skill: "modder",
        confirmAction: "download an experience from the catalog and install it on this server",
        activityVerb: "write",
        xp: { xp: 15, reason: "experience_catalog_install" },
      },
      handler: async (args, { serverId }) => {
        const server = await servers.get(serverId);
        if (!server) return { error: `unknown_server: ${serverId}` };
        const name = args.name !== undefined ? String(args.name).trim() : "";
        const downloadUrl =
          args.downloadUrl !== undefined ? String(args.downloadUrl).trim() : "";
        if (!name && !downloadUrl) {
          return { error: "name_or_downloadUrl_required" };
        }
        try {
          const url = await catalogUrl();
          const fetched = await fetchExperiencesCatalogDetailed(url);
          if (fetched.unavailable === "not_found") {
            return {
              error: "experiences_catalog_not_found",
              catalogUrl: url,
              note: "playon.games experiences index not published yet",
            };
          }
          const entry = findCatalogExperience(fetched.experiences, {
            name: name || undefined,
            downloadUrl: downloadUrl || undefined,
          });
          if (!entry) {
            return { error: "catalog_experience_not_found", catalogUrl: url, name, downloadUrl };
          }
          const { bytes, sha256 } = await downloadCatalogExperienceZip(
            entry.downloadUrl,
            entry.sha256,
          );
          const filesStore = await servers.files(serverId);
          const slug = entry.name.replace(/^experiences\./, "");
          const outRel = `experiences-out/${slug}-${entry.version}.experience.zip`;
          await filesStore.ensureDir("experiences-out");
          await filesStore.writeBytes(outRel, Buffer.from(bytes));
          const result = await applyExperienceInstall({
            serverId,
            zipBytes: bytes,
            filesStore,
            snapshots,
            playerPanel,
          });
          return {
            ...result,
            catalogUrl: url,
            downloadUrl: entry.downloadUrl,
            sha256,
            zipPath: outRel,
          };
        } catch (err) {
          return toolError(err);
        }
      },
    }),

  ];
};
