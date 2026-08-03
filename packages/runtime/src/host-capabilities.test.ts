import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectHostOs, probeHostCapabilities, steamcmdAvailable } from "./host-capabilities.js";

describe("host-capabilities", () => {
  it("reports os and native always true", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-caps-"));
    const caps = probeHostCapabilities(root);
    expect(caps.os).toBe(detectHostOs());
    expect(caps.native).toBe(true);
    expect(typeof caps.docker).toBe("boolean");
    expect(typeof caps.steamcmd).toBe("boolean");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("steamcmdAvailable respects PLAYON_STEAMCMD_AUTO=0 when binary missing", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "playon-steam-caps-"));
    expect(
      steamcmdAvailable({
        HOME: home,
        USERPROFILE: home,
        PATH: "",
        Path: "",
        PLAYON_STEAMCMD: "",
        PLAYON_STEAMCMD_AUTO: "0",
      }),
    ).toBe(false);
    fs.rmSync(home, { recursive: true, force: true });
  });
});
