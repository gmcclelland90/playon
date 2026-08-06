import { describe, expect, it } from "vitest";
import { buildManagedStartEnv, buildManagedStartWrapper } from "./manage-suggest.js";

describe("managed start env/wrapper", () => {
  it("includes HOME, admin password, and server name", () => {
    const env = buildManagedStartEnv({
      playonHome: "/var/lib/playon-node/servers/x/home",
      adminPassword: "secret",
      serverName: "WorldA",
    });
    expect(env).toContain('PLAYON_HOME="/var/lib/playon-node/servers/x/home"');
    expect(env).toContain('PLAYON_ADMIN_PASSWORD="secret"');
    expect(env).toContain('PLAYON_SERVER_NAME="WorldA"');
  });

  it("exports HOME and passes launch flags from env", () => {
    const sh = buildManagedStartWrapper("servername");
    expect(sh).toContain('export HOME="$PLAYON_HOME"');
    expect(sh).toContain('EXTRA+=(-adminpassword "$PLAYON_ADMIN_PASSWORD")');
    expect(sh).toContain('EXTRA+=(-servername "$PLAYON_SERVER_NAME")');
    expect(sh).toContain("start-server.sh");
  });
});
