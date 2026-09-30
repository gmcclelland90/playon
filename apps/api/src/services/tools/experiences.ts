import {
  ExperienceManifestSchema,
  PLAYON_MOD_JSON,
  type ExperienceManifest,
} from "@playon/shared";
import {
  ExperiencePackageError,
  buildExperienceZip,
  parseExperienceZip,
  planExperienceInstall,
} from "../experiences.js";
import {
  collectModsSrcTextSources,
  deployAuthoredMod,
  readPlayonModManifest,
} from "../mods-workspace.js";
import { checkPzLuaSources } from "../mods-lua-check.js";
import { ServerFileStoreError } from "../server-file-store.js";
import { withSnapshot } from "../snapshots.js";
import { serverTool, type ToolModule } from "./types.js";

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
 * experiences.* author/install tools (#995). Install never creates a sibling server.
 */
export const experiencesToolModule: ToolModule = ({ plane }) => {
  const { servers, snapshots } = plane;

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
          const parsed = parseExperienceZip(zipBytes);
          if (parsed.findings.some((f) => f.severity === "error")) {
            return {
              error: "experience_lint_failed",
              findings: parsed.findings.filter((f) => f.severity === "error"),
            };
          }
          const plan = planExperienceInstall(parsed);
          let snapshotId: string | undefined;
          await withSnapshot(snapshots, serverId, "pre-experience-install", async () => {
            const snaps = await snapshots.list(serverId);
            snapshotId = snaps.find((s) => s.label === "pre-experience-install")?.id;
            // Overlays
            for (const overlay of parsed.manifest.overlays) {
              const path = overlay.path.replace(/\\/g, "/");
              if (!path || path.includes("..")) {
                throw new ExperiencePackageError(`unsafe_overlay: ${overlay.path}`, "unsafe_path");
              }
              await filesStore.writeText(path, overlay.content);
            }
            // Seed files (non-destructive copy into jail seed/ or paths as packed)
            for (const [rel, content] of Object.entries(parsed.files)) {
              if (!rel.startsWith("seed/")) continue;
              await filesStore.ensureDir("seed");
              await filesStore.writeText(rel, content);
            }
            // Materialize mods into mods-src then dialect-deploy
            for (const mod of parsed.manifest.mods) {
              const prefix = `mods/${mod.modId}/`;
              for (const [rel, content] of Object.entries(parsed.files)) {
                if (!rel.startsWith(prefix)) continue;
                const dest = `mods-src/${mod.modId}/${rel.slice(prefix.length)}`;
                const dir = dest.includes("/") ? dest.slice(0, dest.lastIndexOf("/")) : "mods-src";
                await filesStore.ensureDir(dir);
                await filesStore.writeText(dest, content);
              }
              // Ensure playon-mod.json
              const meta = {
                dialect: mod.dialect,
                displayName: mod.modId,
                clientNeed: mod.clientNeed,
                version: parsed.manifest.version,
              };
              await filesStore.writeText(
                `mods-src/${mod.modId}/${PLAYON_MOD_JSON}`,
                `${JSON.stringify(meta, null, 2)}\n`,
              );
              await deployAuthoredMod({
                files: filesStore,
                modId: mod.modId,
                dialect: mod.dialect,
                snapshotFirst: async (fn) => fn(), // already snapshotted
              });
            }
          });
          return {
            serverId,
            snapshotId: snapshotId ?? null,
            experience: parsed.manifest.name,
            plan,
            restartRequired: true as const,
            note: "Does not create a sibling server; restart host when ready.",
          };
        } catch (err) {
          return toolError(err);
        }
      },
    }),
  ];
};
