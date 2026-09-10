import { describe, expect, it } from "vitest";
import { steamcmdBetaFlags } from "./steamcmd.js";

describe("steamcmdBetaFlags", () => {
  it("emits steamBeta on every platform (#965 The Isle evrima)", () => {
    expect(steamcmdBetaFlags({ steamBeta: "evrima" }, "win32")).toEqual(["-beta", "evrima"]);
    expect(steamcmdBetaFlags({ steamBeta: "evrima" }, "linux")).toEqual(["-beta", "evrima"]);
    expect(steamcmdBetaFlags({ steamBeta: "  evrima  " }, "win32")).toEqual(["-beta", "evrima"]);
  });

  it("emits steamBetaLinux only on Linux (HumanitZ linuxbranch)", () => {
    expect(steamcmdBetaFlags({ steamBetaLinux: "linuxbranch" }, "linux")).toEqual([
      "-beta",
      "linuxbranch",
    ]);
    expect(steamcmdBetaFlags({ steamBetaLinux: "linuxbranch" }, "win32")).toEqual([]);
  });

  it("prefers steamBeta over steamBetaLinux", () => {
    expect(
      steamcmdBetaFlags({ steamBeta: "evrima", steamBetaLinux: "linuxbranch" }, "linux"),
    ).toEqual(["-beta", "evrima"]);
  });

  it("emits nothing when no beta is set", () => {
    expect(steamcmdBetaFlags({}, "linux")).toEqual([]);
    expect(steamcmdBetaFlags({ steamBeta: "   " }, "win32")).toEqual([]);
  });
});
