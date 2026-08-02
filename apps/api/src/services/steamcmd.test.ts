import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findSteamcmdBinary, SteamcmdNotFoundError, steamcmdAppUpdate } from "./steamcmd.js";

function isolatedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "playon-steam-home-"));
  return {
    PATH: "",
    Path: "",
    HOME: home,
    USERPROFILE: home,
    PLAYON_STEAMCMD: "",
    STEAMCMD: "",
    STEAMCMD_PATH: "",
    PLAYON_STEAMCMD_AUTO: "0",
    ...extra,
  };
}

describe("steamcmd", () => {
  it("returns null when binary is absent", () => {
    const env = isolatedEnv();
    expect(findSteamcmdBinary(env)).toBeNull();
    fs.rmSync(env.HOME!, { recursive: true, force: true });
  });

  it("honors PLAYON_STEAMCMD when the path exists", () => {
    const env = isolatedEnv();
    const fake = path.join(env.HOME!, process.platform === "win32" ? "steamcmd.exe" : "steamcmd.sh");
    fs.writeFileSync(fake, "#!/bin/sh\n", "utf8");
    expect(findSteamcmdBinary({ ...env, PLAYON_STEAMCMD: fake })).toBe(path.resolve(fake));
    fs.rmSync(env.HOME!, { recursive: true, force: true });
  });

  it("fails loud with steamcmd_not_found when auto-install is disabled", async () => {
    const env = isolatedEnv();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-steam-jail-"));
    await expect(
      steamcmdAppUpdate({
        serverDataPath: root,
        appId: 90,
        autoInstall: false,
        env,
      }),
    ).rejects.toBeInstanceOf(SteamcmdNotFoundError);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(env.HOME!, { recursive: true, force: true });
  });
});
