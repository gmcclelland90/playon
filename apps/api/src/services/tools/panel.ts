import { optionalServerTool, type ToolModule } from "./types.js";

/** Public player panel: what players see for a server. */
export const panelToolModule: ToolModule = ({ plane }) => {
  const { panel, playerPanel } = plane;

  return [
    optionalServerTool({
      def: {
        name: "panel_publish",
        description:
          "Replace all player panel blocks for a server. Always include join_info + client_setup after servers_start so players can connect. Include every block you want to keep — omitted blocks are removed. Types: server_status, join_info, client_setup, guide, vote, readiness, announcement, file_drop, discovery. join_info address/port and live stats (players/map/mode) are filled from the control plane — do not invent player counts. Optional connectCommand / steamConnectUrl (steam:// only). Blocks are only visible on the public player panel while the server is starting or running — start the server first. Prefer body.notes / body.instructions / body.steps for setup.",
        parameters: {
          type: "object",
          properties: {
            serverId: { type: "string" },
            blocks: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  type: {
                    type: "string",
                    enum: [
                      "server_status",
                      "join_info",
                      "client_setup",
                      "guide",
                      "vote",
                      "readiness",
                      "announcement",
                      "file_drop",
                      "discovery",
                    ],
                  },
                  title: { type: "string" },
                  body: {
                    type: "object",
                    description:
                      "join_info: { connectCommand?: string, steamConnectUrl?: string, game?: string }. client_setup: { notes: string }. Prefer skill join metadata; steamConnectUrl must be steam:// when set.",
                  },
                  sortOrder: { type: "number" },
                },
                required: ["type", "title"],
              },
            },
          },
          required: ["blocks"],
        },
      },
      surface: {
        skill: "player_panel",
        activityVerb: "panel",
        xp: { xp: 10, reason: "player_panel" },
      },
      handler: async (args, { serverId }) =>
        playerPanel.publishFromAgent(serverId, Array.isArray(args.blocks) ? args.blocks : []),
    }),

    optionalServerTool({
      def: {
        name: "panel_list",
        description: "List player panel blocks",
        parameters: {
          type: "object",
          properties: { serverId: { type: "string" } },
        },
      },
      surface: { skill: "player_panel", activityVerb: "panel" },
      handler: async (_args, { serverId }) => panel.list(serverId),
    }),
  ];
};
