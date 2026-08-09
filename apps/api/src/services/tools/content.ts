import fs from "node:fs";
import path from "node:path";
import { isLocalNodeId, NODE_AUTHORITATIVE_MARKER } from "@playon/shared";
import { dispatchNodeJob, nodeServerRelPath } from "../node-runtime.js";
import { readSkillMarker } from "../skill-marker.js";
import { SteamcmdNotFoundError, steamcmdAppUpdate } from "../steamcmd.js";
import { serverTool, type ToolModule } from "./types.js";

/** SteamCMD depot syncs routinely outrun the default job timeout. */
const STEAMCMD_TIMEOUT_MS = 600_000;

/** SteamCMD is chatty and can echo credentials prompts — only a short tail leaves the plane. */
const STEAMCMD_STDOUT_TAIL = 800;

/** Header values the caller may set; everything else is dropped before the request. */
function stringHeaders(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => typeof v === "string")
      .map(([k, v]) => [k, String(v)]),
  );
}

/**
 * Getting game and mod content into a server's jail: download it, unpack it, or
 * pull it from Steam. Every tool here writes bytes the host did not review, so
 * all three are confirm-gated.
 */
export const contentToolModule: ToolModule = ({ plane }) => {
  const { archives, net, servers } = plane;

  return [
    serverTool({
      def: {
        name: "fetch_url",
        description:
          "Download an HTTP(S) URL into a path under a server data directory (jailed). Follows redirects; max 100MB. Blocks private/link-local destinations except explicit localhost/127.0.0.1.",
        requiresConfirm: true,
        parameters: {
          type: "object",
          properties: {
            serverId: { type: "string" },
            url: { type: "string" },
            destPath: { type: "string" },
            headers: {
              type: "object",
              description: "Optional request headers (Host/Content-Length and hop-by-hop headers are ignored)",
              additionalProperties: { type: "string" },
            },
          },
          required: ["serverId", "url", "destPath"],
        },
      },
      surface: {
        skill: "modder",
        confirmAction: "download a file into the server folder",
        activityVerb: "fetch",
      },
      handler: async (args, { serverId }) =>
        net.fetchUrl({
          serverId,
          url: String(args.url),
          destPath: String(args.destPath),
          headers: stringHeaders(args.headers),
        }),
    }),

    serverTool({
      def: {
        name: "archive_extract",
        description:
          "Extract a zip or tar.gz archive already in the server jail into a destination directory (path-jailed). Use after fetch_url for mod packs.",
        requiresConfirm: true,
        parameters: {
          type: "object",
          properties: {
            serverId: { type: "string" },
            archivePath: { type: "string", description: "Relative path to the archive inside the server data dir" },
            destDir: { type: "string", description: "Relative destination directory inside the server data dir" },
            stripComponents: {
              type: "number",
              description: "Strip leading path components from archive entries (like tar --strip-components)",
            },
          },
          required: ["serverId", "archivePath", "destDir"],
        },
      },
      surface: {
        skill: "installer",
        confirmAction: "extract an archive into the server folder",
        activityVerb: "write",
      },
      handler: async (args, { serverId }) =>
        archives.extract({
          serverId,
          archivePath: String(args.archivePath),
          destDir: String(args.destDir),
          stripComponents:
            args.stripComponents !== undefined ? Number(args.stripComponents) : undefined,
        }),
    }),

    serverTool({
      def: {
        name: "steamcmd_app_update",
        description:
          "Run host SteamCMD +app_update into the server jail. On Linux, auto-downloads SteamCMD into ~/steamcmd when missing (set PLAYON_STEAMCMD_AUTO=0 to disable). Prefer this before starting Steam-native games (Rust, etc.).",
        requiresConfirm: true,
        parameters: {
          type: "object",
          properties: {
            serverId: { type: "string" },
            appId: { type: "number" },
            installDir: { type: "string" },
            validate: { type: "boolean" },
            /** HLDS app 90: SteamCMD mod name (cstrike, czero, valve, tfc). */
            steamMod: { type: "string" },
            /** Linux-only SteamCMD beta (e.g. HumanitZ linuxbranch). Defaults from skill.json. */
            steamBetaLinux: { type: "string" },
          },
          required: ["serverId", "appId"],
        },
      },
      surface: {
        skill: "installer",
        confirmAction: "download or update game files via Steam",
        activityVerb: "run",
      },
      handler: async (args, { serverId }) => {
        const server = await servers.get(serverId);
        if (!server) return { error: `unknown_server: ${serverId}` };
        const appId = Number(args.appId);
        const installDirRel = args.installDir ? String(args.installDir) : undefined;
        const validate = args.validate === undefined ? true : Boolean(args.validate);
        const marker = readSkillMarker(server.dataPath);
        const steamMod =
          typeof args.steamMod === "string" && args.steamMod.trim()
            ? args.steamMod.trim()
            : typeof marker?.steamMod === "string" && marker.steamMod.trim()
              ? marker.steamMod.trim()
              : undefined;
        const steamBetaLinux =
          typeof args.steamBetaLinux === "string" && args.steamBetaLinux.trim()
            ? args.steamBetaLinux.trim()
            : typeof marker?.steamBetaLinux === "string" && marker.steamBetaLinux.trim()
              ? marker.steamBetaLinux.trim()
              : undefined;
        try {
          const result = await dispatchNodeJob({
            nodeId: server.nodeId,
            kind: "steamcmd_app_update",
            args: {
              serverRel: nodeServerRelPath(server.id),
              appId,
              installDirRel,
              validate,
              steamMod,
              steamBetaLinux,
            },
            timeoutMs: STEAMCMD_TIMEOUT_MS,
            localHandler: () =>
              steamcmdAppUpdate({
                serverDataPath: server.dataPath,
                appId,
                installDirRel,
                validate,
                steamMod,
                steamBetaLinux,
              }),
          });
          // SteamCMD writes on the node; Home's game/ stays empty. Mark the
          // tree node-authoritative so prepareRemoteStart won't push-wipe it.
          if (server.nodeId && !isLocalNodeId(server.nodeId)) {
            fs.mkdirSync(server.dataPath, { recursive: true });
            fs.writeFileSync(
              path.join(server.dataPath, NODE_AUTHORITATIVE_MARKER),
              `${server.nodeId}\n`,
              "utf8",
            );
          }
          return {
            serverId,
            appId: result.appId,
            installDir: result.installDir,
            exitCode: result.exitCode,
            stdoutTail: result.stdout.slice(-STEAMCMD_STDOUT_TAIL),
          };
        } catch (err) {
          if (err instanceof SteamcmdNotFoundError) return { error: err.message };
          return { error: err instanceof Error ? err.message : "steamcmd_failed" };
        }
      },
    }),
  ];
};
