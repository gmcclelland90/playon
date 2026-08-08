import { z } from "zod";
import { defineNodeJob, type NodeJobContractMap } from "./contract.js";
import { NodeJailPathSchema } from "./fs.js";

/**
 * SteamCMD job kinds. `serverRel` is jail-relative to the node data root;
 * `installDirRel` is relative to that server directory, so the install always
 * lands inside the server's own tree.
 *
 * Args are strict (a typo must fail loudly); results are lenient about extra
 * fields so a newer agent can add them without breaking an older control plane.
 */

/** Where SteamCMD installs when the caller names no subdirectory. */
export const STEAMCMD_DEFAULT_INSTALL_DIR_REL = "game";

export const SteamcmdAppUpdateArgsSchema = z
  .object({
    /** Server root on the node, e.g. `servers/<serverId>`. */
    serverRel: NodeJailPathSchema,
    appId: z.number().int().positive(),
    /** Install subdirectory under the server root; defaults to `game`. */
    installDirRel: NodeJailPathSchema.default(STEAMCMD_DEFAULT_INSTALL_DIR_REL),
    /** Pass `validate` to `+app_update`; on by default, as SteamCMD installs go stale. */
    validate: z.boolean().default(true),
  })
  .strict();

export const SteamcmdAppUpdateResultSchema = z.object({
  ok: z.boolean(),
  /** Absolute path to the SteamCMD binary the agent used. */
  binary: z.string().min(1),
  exitCode: z.number().int(),
  /** Tail of the run only — SteamCMD output is trimmed before it leaves the node. */
  stdout: z.string(),
  stderr: z.string(),
  /** Absolute install path on the node. */
  installDir: z.string().min(1),
  appId: z.number().int().positive(),
  /** True when the agent had to download SteamCMD for this run. */
  provisioned: z.boolean().optional(),
});

export const STEAMCMD_NODE_JOB_CONTRACTS = {
  steamcmd_app_update: defineNodeJob(
    "steamcmd_app_update",
    SteamcmdAppUpdateArgsSchema,
    SteamcmdAppUpdateResultSchema,
  ),
} as const satisfies NodeJobContractMap;

export type SteamcmdAppUpdateArgs = z.infer<typeof SteamcmdAppUpdateArgsSchema>;
export type SteamcmdAppUpdateResult = z.infer<typeof SteamcmdAppUpdateResultSchema>;
