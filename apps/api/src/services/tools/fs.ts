import { serverTool, type ToolModule } from "./types.js";

/** Path-jailed file tools for the chat's bound server. */
export const fsToolModule: ToolModule = ({ plane }) => {
  const { servers } = plane;

  return [
    serverTool({
      def: {
        name: "fs_list",
        description: "List files under a server data directory (path-jailed)",
        parameters: {
          type: "object",
          properties: {
            serverId: { type: "string" },
            path: { type: "string", description: "Relative path inside the server data dir" },
          },
          required: ["serverId"],
        },
      },
      surface: { skill: "troubleshooter", activityVerb: "read" },
      handler: async (args, { serverId }) =>
        (await servers.files(serverId)).list(args.path ? String(args.path) : "."),
    }),

    serverTool({
      def: {
        name: "fs_read",
        description:
          "Read a text file under a server data directory (path-jailed). Optional offset/maxBytes for large files (max 512KB per read).",
        parameters: {
          type: "object",
          properties: {
            serverId: { type: "string" },
            path: { type: "string" },
            offset: { type: "number", description: "Byte offset to start reading from" },
            maxBytes: { type: "number", description: "Max bytes to return (capped at 512KB)" },
          },
          required: ["serverId", "path"],
        },
      },
      surface: { skill: "troubleshooter", activityVerb: "read" },
      handler: async (args, { serverId }) =>
        (await servers.files(serverId)).readText(String(args.path), {
          offset: args.offset !== undefined ? Number(args.offset) : undefined,
          maxBytes: args.maxBytes !== undefined ? Number(args.maxBytes) : undefined,
        }),
    }),

    serverTool({
      def: {
        name: "fs_write",
        description: "Write a text file under a server data directory (path-jailed)",
        requiresConfirm: true,
        parameters: {
          type: "object",
          properties: {
            serverId: { type: "string" },
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["serverId", "path", "content"],
        },
      },
      surface: {
        skill: "configurer",
        confirmAction: "change a server file",
        activityVerb: "write",
      },
      handler: async (args, { serverId }) =>
        (await servers.files(serverId)).writeText(String(args.path), String(args.content)),
    }),

    serverTool({
      def: {
        name: "fs_delete",
        description:
          "Delete a file or directory under a server data directory (path-jailed, recursive for dirs)",
        requiresConfirm: true,
        parameters: {
          type: "object",
          properties: {
            serverId: { type: "string" },
            path: { type: "string" },
          },
          required: ["serverId", "path"],
        },
      },
      surface: {
        skill: "configurer",
        confirmAction: "delete a server file or folder",
        activityVerb: "write",
      },
      handler: async (args, { serverId }) => (await servers.files(serverId)).delete(String(args.path)),
    }),

    serverTool({
      def: {
        name: "fs_rename",
        description: "Rename or move a path inside a server data directory (path-jailed)",
        requiresConfirm: true,
        parameters: {
          type: "object",
          properties: {
            serverId: { type: "string" },
            from: { type: "string" },
            to: { type: "string" },
            overwrite: { type: "boolean" },
          },
          required: ["serverId", "from", "to"],
        },
      },
      surface: {
        skill: "configurer",
        confirmAction: "rename or move a server path",
        activityVerb: "write",
      },
      handler: async (args, { serverId }) =>
        (await servers.files(serverId)).rename(String(args.from), String(args.to), {
          overwrite: Boolean(args.overwrite),
        }),
    }),

    serverTool({
      def: {
        name: "fs_copy",
        description: "Copy a file or directory tree inside a server data directory (path-jailed)",
        requiresConfirm: true,
        parameters: {
          type: "object",
          properties: {
            serverId: { type: "string" },
            from: { type: "string" },
            to: { type: "string" },
            overwrite: { type: "boolean" },
          },
          required: ["serverId", "from", "to"],
        },
      },
      surface: {
        skill: "configurer",
        confirmAction: "copy a server file or folder",
        activityVerb: "write",
      },
      handler: async (args, { serverId }) =>
        (await servers.files(serverId)).copy(String(args.from), String(args.to), {
          overwrite: Boolean(args.overwrite),
        }),
    }),
  ];
};
