import { describe, expect, it } from "vitest";
import { shouldRunWslKeepalive } from "./wsl-keepalive.js";

describe("shouldRunWslKeepalive", () => {
  it("runs only on Windows parent nodes", () => {
    expect(shouldRunWslKeepalive({ platform: "win32", nodeId: "playon-win-1", enabledEnv: "1" })).toBe(
      true,
    );
    expect(shouldRunWslKeepalive({ platform: "linux", nodeId: "playon-win-1", enabledEnv: "1" })).toBe(
      false,
    );
    expect(
      shouldRunWslKeepalive({ platform: "win32", nodeId: "playon-win-1-wsl", enabledEnv: "1" }),
    ).toBe(false);
  });

  it("honors PLAYON_WSL_KEEPALIVE=0", () => {
    expect(shouldRunWslKeepalive({ platform: "win32", nodeId: "local", enabledEnv: "0" })).toBe(false);
    expect(shouldRunWslKeepalive({ platform: "win32", nodeId: "local", enabledEnv: "false" })).toBe(
      false,
    );
  });
});
