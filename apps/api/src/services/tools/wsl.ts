import { LOCAL_NODE_ID } from "@playon/shared";
import { globalTool, type ToolModule } from "./types.js";

/**
 * WSL Linux runtime tools — target a Windows node (Home may be any OS).
 * Enable/status/repair via ensure-wsl-runtime.ps1 (local UAC or elevated one-liner).
 */
export const wslToolModule: ToolModule = ({ plane }) => {
  const { wslRuntime } = plane;

  const nodeIdProp = {
    type: "string" as const,
    description:
      "Windows node id to enable WSL on (default: local). Sibling Linux node will be local-wsl or {nodeId}-wsl.",
  };

  return [
    globalTool({
      def: {
        name: "wsl_status",
        description:
          "Check WSL Linux runtime status on a Windows node. Returns installation state, sibling node id, and whether a one-liner is needed. Works from any Home OS.",
        parameters: {
          type: "object",
          properties: { nodeId: nodeIdProp },
          required: [],
        },
      },
      surface: { skill: "installer", activityVerb: "search" },
      handler: async (args) => {
        const nodeId =
          typeof args.nodeId === "string" && args.nodeId.trim()
            ? args.nodeId.trim()
            : LOCAL_NODE_ID;
        return wslRuntime.status(nodeId);
      },
    }),

    globalTool({
      def: {
        name: "wsl_enable",
        description:
          "Enable WSL Linux runtime on a Windows node. On Windows Home local, prompts UAC; otherwise returns an elevated PowerShell one-liner to run on that host. Creates sibling local-wsl or {nodeId}-wsl.",
        requiresConfirm: true,
        parameters: {
          type: "object",
          properties: { nodeId: nodeIdProp },
          required: [],
        },
      },
      surface: {
        skill: "installer",
        confirmAction: "enable WSL Linux runtime on this Windows node",
        activityVerb: "run",
      },
      handler: async (args) => {
        const nodeId =
          typeof args.nodeId === "string" && args.nodeId.trim()
            ? args.nodeId.trim()
            : LOCAL_NODE_ID;
        return wslRuntime.enable(nodeId);
      },
    }),

    globalTool({
      def: {
        name: "wsl_repair",
        description:
          "Repair WSL Linux runtime on a Windows node. Re-runs setup with -Repair (local UAC or elevated one-liner).",
        requiresConfirm: true,
        parameters: {
          type: "object",
          properties: { nodeId: nodeIdProp },
          required: [],
        },
      },
      surface: {
        skill: "installer",
        confirmAction: "repair WSL Linux runtime on this Windows node",
        activityVerb: "run",
      },
      handler: async (args) => {
        const nodeId =
          typeof args.nodeId === "string" && args.nodeId.trim()
            ? args.nodeId.trim()
            : LOCAL_NODE_ID;
        return wslRuntime.repair(nodeId);
      },
    }),
  ];
};
