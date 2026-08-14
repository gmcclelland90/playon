import { joinHostNotReachableResult } from "@playon/shared";
import { rconExec, rconExecWithSelfHeal } from "../rcon.js";
import { serverTool, type ToolModule } from "./types.js";

const RCON_NOT_CONFIGURED = {
  error: "rcon_not_configured",
  hint: "Start a server whose skill adminDialect supports RCON, then retry.",
} as const;

/** The live admin channel into a running server: send console commands, talk to players. */
export const rconToolModule: ToolModule = ({ plane }) => {
  const { servers, joinReady } = plane;

  return [
    serverTool({
      def: {
        name: "rcon_exec",
        description:
          "Run a Minecraft RCON command (no leading slash). Auto-heals known legacy gamerules (doDaylightCycle→advance_time, keepInventory→keep_inventory, etc.). Always-day: `time set day` then `gamerule advance_time false`. On rcon_command_failed: read body/hint, try one different approach, then explain — never spam the same failing command. Prefer rcon_say for chat.",
        parameters: {
          type: "object",
          properties: {
            serverId: { type: "string" },
            command: { type: "string" },
          },
          required: ["serverId", "command"],
        },
      },
      surface: { skill: "configurer", activityVerb: "run" },
      handler: async (args, { serverId }) => {
        const reachability = await joinReady.probe(serverId);
        if (!reachability.ready) return joinHostNotReachableResult(reachability);
        const endpoint = await servers.getRconEndpoint(serverId);
        if (!endpoint) return RCON_NOT_CONFIGURED;
        try {
          const result = await rconExecWithSelfHeal(endpoint, String(args.command));
          return { serverId, ...result };
        } catch (err) {
          return { error: err instanceof Error ? err.message : "rcon_failed" };
        }
      },
    }),

    serverTool({
      def: {
        name: "rcon_say",
        description: "Broadcast a chat message to players via RCON say",
        parameters: {
          type: "object",
          properties: {
            serverId: { type: "string" },
            message: { type: "string" },
          },
          required: ["serverId", "message"],
        },
      },
      surface: { skill: "configurer", activityVerb: "run" },
      handler: async (args, { serverId }) => {
        const reachability = await joinReady.probe(serverId);
        if (!reachability.ready) return joinHostNotReachableResult(reachability);
        const endpoint = await servers.getRconEndpoint(serverId);
        if (!endpoint) return RCON_NOT_CONFIGURED;
        const message = String(args.message);
        try {
          const result = await rconExec(endpoint, `say ${message}`);
          return { serverId, message, body: result.body };
        } catch (err) {
          return { error: err instanceof Error ? err.message : "rcon_failed" };
        }
      },
    }),
  ];
};
