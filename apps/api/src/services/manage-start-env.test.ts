import { describe, expect, it } from "vitest";
import {
  buildManagedStartEnv,
  buildManagedStartWrapper,
  formatServerNameFlag,
} from "./manage-suggest.js";

describe("managed start env/wrapper", () => {
  it("includes HOME, admin password, server name, and flag", () => {
    const env = buildManagedStartEnv({
      playonHome: "/var/lib/playon-node/servers/x/home",
      adminPassword: "secret",
      serverName: "WorldA",
      serverNameArg: "servername",
    });
    expect(env).toContain('PLAYON_HOME="/var/lib/playon-node/servers/x/home"');
    expect(env).toContain('PLAYON_ADMIN_PASSWORD="secret"');
    expect(env).toContain('PLAYON_SERVER_NAME="WorldA"');
    expect(env).toContain('PLAYON_SERVER_NAME_ARG="-servername"');
  });

  it("preserves + and -- launch flag forms", () => {
    expect(formatServerNameFlag("+server.identity")).toBe("+server.identity");
    expect(formatServerNameFlag("--start-server")).toBe("--start-server");
    expect(formatServerNameFlag("world")).toBe("-world");
    const rust = buildManagedStartWrapper("+server.identity");
    expect(rust).toContain('FLAG="${PLAYON_SERVER_NAME_ARG:-+server.identity}"');
    expect(rust).toContain("RustDedicated");
  });

  it("exports HOME/XDG and passes launch flags from env", () => {
    const sh = buildManagedStartWrapper("servername");
    expect(sh).toContain('export HOME="$PLAYON_HOME"');
    expect(sh).toContain("XDG_CONFIG_HOME");
    expect(sh).toContain('EXTRA+=(-adminpassword "$PLAYON_ADMIN_PASSWORD")');
    expect(sh).toContain('EXTRA+=("$FLAG" "$PLAYON_SERVER_NAME")');
    expect(sh).toContain("start-server.sh");
  });
});
