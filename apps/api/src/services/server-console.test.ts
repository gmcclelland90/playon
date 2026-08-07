import { describe, expect, it, vi } from "vitest";
import type { AdminDialect } from "@playon/shared";
import { CONSOLE_COMMAND_MAX_LEN, execConsoleCommand } from "./server-console.js";
import type { ServerService } from "./servers.js";

function mockServers(opts: {
  dialect: AdminDialect | null;
  input?: "ready" | "unsupported" | "unavailable";
  rcon?: { host: string; port: number; password: string } | null;
  writeStdin?: () => Promise<void>;
}): ServerService {
  return {
    getAdminDialect: vi.fn(async () => opts.dialect),
    consoleCapability: vi.fn(async () =>
      opts.dialect
        ? { dialect: opts.dialect, input: opts.input ?? "ready" }
        : null,
    ),
    getRconEndpoint: vi.fn(async () => opts.rcon ?? null),
    writeContainerStdin: vi.fn(opts.writeStdin ?? (async () => undefined)),
  } as unknown as ServerService;
}

describe("execConsoleCommand", () => {
  it("rejects unknown servers", async () => {
    const servers = mockServers({ dialect: null });
    const result = await execConsoleCommand(servers, "missing", "list");
    expect(result).toMatchObject({ ok: false, error: "unknown_server" });
  });

  it("rejects empty commands", async () => {
    const servers = mockServers({ dialect: "mc_rcon", input: "ready" });
    const result = await execConsoleCommand(servers, "s1", "   ");
    expect(result).toMatchObject({
      dialect: "mc_rcon",
      ok: false,
      error: "empty_command",
    });
  });

  it("rejects oversized commands", async () => {
    const servers = mockServers({ dialect: "stdin", input: "ready" });
    const result = await execConsoleCommand(
      servers,
      "s1",
      "x".repeat(CONSOLE_COMMAND_MAX_LEN + 1),
    );
    expect(result).toMatchObject({ ok: false, error: "command_too_long" });
  });

  it("returns unavailable when console input is not ready", async () => {
    const servers = mockServers({ dialect: "mc_rcon", input: "unavailable" });
    const result = await execConsoleCommand(servers, "s1", "list");
    expect(result).toMatchObject({
      dialect: "mc_rcon",
      ok: false,
      error: "console_unavailable",
    });
  });

  it("routes none dialect to unavailable", async () => {
    const servers = mockServers({ dialect: "none", input: "unavailable" });
    const result = await execConsoleCommand(servers, "s1", "list");
    expect(result.error).toBe("console_unavailable");
  });

  it("returns unsupported for source_rcon", async () => {
    const servers = mockServers({ dialect: "source_rcon", input: "unsupported" });
    const result = await execConsoleCommand(servers, "s1", "status");
    expect(result).toMatchObject({
      dialect: "source_rcon",
      ok: false,
      error: "dialect_unsupported",
    });
  });

  it("writes stdin for stdin dialect", async () => {
    const writeStdin = vi.fn(async () => undefined);
    const servers = mockServers({ dialect: "stdin", input: "ready", writeStdin });
    const result = await execConsoleCommand(servers, "s1", "help");
    expect(result).toEqual({ dialect: "stdin", ok: true, body: "" });
    expect(writeStdin).toHaveBeenCalledOnce();
    expect(servers.writeContainerStdin).toHaveBeenCalledWith("s1", "help");
  });

  it("returns rcon_not_configured when mc_rcon has no endpoint", async () => {
    const servers = mockServers({ dialect: "mc_rcon", input: "ready", rcon: null });
    // Bypass capability gate so the driver path is exercised.
    vi.mocked(servers.consoleCapability).mockResolvedValue({
      dialect: "mc_rcon",
      input: "ready",
    });
    const result = await execConsoleCommand(servers, "s1", "list");
    expect(result).toMatchObject({
      dialect: "mc_rcon",
      ok: false,
      error: "rcon_not_configured",
    });
  });
});
