import { SkillThemeIdSchema } from "@playon/shared";
import { optionalServerTool, serverTool, type ToolModule } from "./types.js";

const PANEL_BLOCK_TYPE_ENUM = [
  "server_status",
  "join_info",
  "client_setup",
  "guide",
  "vote",
  "readiness",
  "announcement",
  "file_drop",
  "discovery",
] as const;

const PANEL_BODY_DESCRIPTION =
  "Typed body fields by type — guide: { summary?, notes?, instructions?, steps?, links?, url? }; " +
  "announcement: { summary?, notes?, level?: info|warn|fun }; " +
  "file_drop: { url (http/https), label?, sha256? }; " +
  "discovery: { summary?, suggestions: [{ title, detail?, skillName? }] }; " +
  "vote: { summary?, options?|choices? }; " +
  "readiness: { summary?, label? }; " +
  "join_info: { connectCommand?, steamConnectUrl?, game? } (address/port filled by control plane); " +
  "client_setup: { notes?, instructions?, steps? }; " +
  "server_status: live players/map filled by control plane — do not invent counts.";

/** Public player panel: what players see for a server. */
export const panelToolModule: ToolModule = ({ plane }) => {
  const { panel, playerPanel } = plane;

  return [
    optionalServerTool({
      def: {
        name: "panel_publish",
        description:
          "Replace all player panel blocks for a server. Always include join_info + client_setup after servers_start so players can connect. Include every block you want to keep — omitted blocks are removed. For partial updates use panel_upsert instead. Types: server_status, join_info, client_setup, guide, vote, readiness, announcement, file_drop, discovery. " +
          PANEL_BODY_DESCRIPTION +
          " Prefer skill join metadata; steamConnectUrl must be steam:// when set. Blocks are only visible on the public player panel while the server is starting or running — start the server first.",
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
                    enum: [...PANEL_BLOCK_TYPE_ENUM],
                  },
                  title: { type: "string" },
                  body: {
                    type: "object",
                    description: PANEL_BODY_DESCRIPTION,
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
        name: "panel_upsert",
        description:
          "Merge player panel blocks into the existing server panel without wiping other blocks. Matches each block by id when provided, otherwise by type for that server; unmatched blocks append. Prefer this for incremental updates (guides, votes, readiness, announcements, file_drop, discovery). Uses the same join_info / live status enrichment as panel_publish. " +
          PANEL_BODY_DESCRIPTION,
        parameters: {
          type: "object",
          properties: {
            serverId: { type: "string" },
            blocks: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string", description: "Existing block id to replace when known" },
                  type: {
                    type: "string",
                    enum: [...PANEL_BLOCK_TYPE_ENUM],
                  },
                  title: { type: "string" },
                  body: {
                    type: "object",
                    description: PANEL_BODY_DESCRIPTION,
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
        playerPanel.upsertFromAgent(serverId, Array.isArray(args.blocks) ? args.blocks : []),
    }),

    serverTool({
      def: {
        name: "panel_theme",
        description:
          "Set the public player panel theme override for a server. themeId is one of grass, ember, steel, paper, default. Optional primaryHue (0–360) tints the panel. Stored under the server data dir; takes precedence over the skill theme.",
        parameters: {
          type: "object",
          properties: {
            serverId: { type: "string" },
            themeId: {
              type: "string",
              enum: ["default", "grass", "ember", "steel", "paper"],
            },
            primaryHue: { type: "number", description: "Optional OKLCH hue 0–360" },
          },
          required: ["themeId"],
        },
      },
      surface: {
        skill: "player_panel",
        activityVerb: "panel",
        xp: { xp: 5, reason: "player_panel" },
      },
      handler: async (args, { serverId }) => {
        const themeId = SkillThemeIdSchema.parse(args.themeId);
        const primaryHue =
          typeof args.primaryHue === "number" ? args.primaryHue : undefined;
        return playerPanel.setThemeFromAgent(serverId, {
          themeId,
          ...(primaryHue !== undefined ? { primaryHue } : {}),
        });
      },
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
