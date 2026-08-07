import type { AdminDialect } from "@playon/shared";
import { rconBodyIndicatesFailure, rconExecWithSelfHeal } from "./rcon.js";
import type { ServerService } from "./servers.js";

export const CONSOLE_COMMAND_MAX_LEN = 2048;

export type ConsoleExecResult = {
  dialect: AdminDialect;
  ok: boolean;
  body?: string;
  error?: string;
  hint?: string;
};

type ConsoleDriver = (
  servers: ServerService,
  serverId: string,
  command: string,
) => Promise<ConsoleExecResult>;

const unsupported =
  (dialect: AdminDialect, hint: string): ConsoleDriver =>
  async () => ({
    dialect,
    ok: false,
    error: "dialect_unsupported",
    hint,
  });

const drivers: Record<AdminDialect, ConsoleDriver> = {
  none: async (_servers, _serverId, _command) => ({
    dialect: "none",
    ok: false,
    error: "console_unavailable",
    hint: "This server skill does not expose a remote admin console.",
  }),

  mc_rcon: async (servers, serverId, command) => {
    const endpoint = await servers.getRconEndpoint(serverId);
    if (!endpoint) {
      return {
        dialect: "mc_rcon",
        ok: false,
        error: "rcon_not_configured",
        hint: "Start the server so admin credentials can be provisioned, then retry.",
      };
    }
    try {
      const result = await rconExecWithSelfHeal(endpoint, command);
      if (rconBodyIndicatesFailure(result.body)) {
        return {
          dialect: "mc_rcon",
          ok: false,
          body: result.body,
          error: "command_failed",
        };
      }
      return {
        dialect: "mc_rcon",
        ok: true,
        body: result.body,
      };
    } catch (err) {
      return {
        dialect: "mc_rcon",
        ok: false,
        error: err instanceof Error ? err.message : "rcon_failed",
      };
    }
  },

  stdin: async (servers, serverId, command) => {
    try {
      await servers.writeContainerStdin(serverId, command);
      return {
        dialect: "stdin",
        ok: true,
        body: "",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "stdin_failed";
      return {
        dialect: "stdin",
        ok: false,
        error: message,
        hint:
          message === "stdin_unavailable_native"
            ? "Stdin console is only available for Docker-backed servers."
            : undefined,
      };
    }
  },

  source_rcon: unsupported(
    "source_rcon",
    "Source RCON console driver is not implemented yet.",
  ),
  rust_web_rcon: unsupported(
    "rust_web_rcon",
    "Rust web RCON console driver is not implemented yet.",
  ),
  http_rest: unsupported(
    "http_rest",
    "HTTP admin console driver is not implemented yet.",
  ),
};

/**
 * Dialect-agnostic admin console entrypoint.
 * Routes by skill adminDialect; never returns passwords or endpoint secrets.
 */
export async function execConsoleCommand(
  servers: ServerService,
  serverId: string,
  rawCommand: string,
): Promise<ConsoleExecResult> {
  const dialect = await servers.getAdminDialect(serverId);
  if (!dialect) {
    return {
      dialect: "none",
      ok: false,
      error: "unknown_server",
    };
  }

  const command = String(rawCommand ?? "").trim();
  if (!command) {
    return {
      dialect,
      ok: false,
      error: "empty_command",
    };
  }
  if (command.length > CONSOLE_COMMAND_MAX_LEN) {
    return {
      dialect,
      ok: false,
      error: "command_too_long",
      hint: `Max length is ${CONSOLE_COMMAND_MAX_LEN} characters.`,
    };
  }

  const cap = await servers.consoleCapability(serverId);
  if (!cap || cap.input === "unavailable") {
    return {
      dialect,
      ok: false,
      error: "console_unavailable",
      hint: "Server must be running with a usable admin console.",
    };
  }
  if (cap.input === "unsupported") {
    return drivers[dialect](servers, serverId, command);
  }

  return drivers[dialect](servers, serverId, command);
}
