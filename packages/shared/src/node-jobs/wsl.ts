import { z } from "zod";
import { defineNodeJob, type NodeJobContractMap } from "./contract.js";

/**
 * Run ensure-wsl-runtime.ps1 on a Windows node (status / enable / repair).
 * Home embeds the script as base64 so older node trees without deploy/windows still work.
 */
export const WslEnsureArgsSchema = z
  .object({
    action: z.enum(["status", "enable", "repair"]),
    /** Sibling Linux node id (local-wsl or {windowsNodeId}-wsl). */
    wslNodeId: z.string().min(1),
    apiUrl: z.string().url(),
    nodeToken: z.string().min(1),
    /** Full ensure-wsl-runtime.ps1 contents, base64-encoded. */
    scriptBase64: z.string().min(1),
  })
  .strict();

export const WslEnsureResultSchema = z.object({
  status: z.string().min(1),
  message: z.string(),
  code: z.number().int(),
  wslNodeId: z.string().min(1),
  /** True when elevation/UAC is required but was not available — Home should offer a one-liner. */
  needsElevation: z.boolean().optional(),
});

export const WSL_NODE_JOB_CONTRACTS = {
  wsl_ensure: defineNodeJob("wsl_ensure", WslEnsureArgsSchema, WslEnsureResultSchema),
} as const satisfies NodeJobContractMap;

export type WslEnsureArgs = z.infer<typeof WslEnsureArgsSchema>;
export type WslEnsureResult = z.infer<typeof WslEnsureResultSchema>;
