import { globalTool, type ToolModule } from "./types.js";

/**
 * WSL Linux runtime tools for Windows Home hosts.
 * Enable, status, and repair of the local-wsl node via ensure-wsl-runtime.ps1.
 */
export const wslToolModule: ToolModule = ({ plane }) => {
  const { wslRuntime } = plane;

  return [
    globalTool({
      def: {
        name: "wsl_status",
        description:
          "Check WSL Linux runtime status on Windows Home. Returns installation state, distro name, and node availability. Only works on Windows.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      surface: { skill: "installer", activityVerb: "search" },
      handler: async () => wslRuntime.status(),
    }),

    globalTool({
      def: {
        name: "wsl_enable",
        description:
          "Enable WSL Linux runtime on Windows Home. Installs WSL2, sets up the PlayOn distro, Docker, and the node agent. Requires UAC elevation. Only works on Windows.",
        requiresConfirm: true,
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      surface: {
        skill: "installer",
        confirmAction: "enable WSL Linux runtime on this Windows machine",
        activityVerb: "run",
      },
      handler: async () => wslRuntime.enable(),
    }),

    globalTool({
      def: {
        name: "wsl_repair",
        description:
          "Repair WSL Linux runtime on Windows Home. Re-runs setup with the -Repair flag to fix broken installations. Requires UAC elevation. Only works on Windows.",
        requiresConfirm: true,
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      surface: {
        skill: "installer",
        confirmAction: "repair WSL Linux runtime on this Windows machine",
        activityVerb: "run",
      },
      handler: async () => wslRuntime.repair(),
    }),
  ];
};
