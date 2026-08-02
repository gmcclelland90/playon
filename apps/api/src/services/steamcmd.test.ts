import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findSteamcmdBinary, SteamcmdNotFoundError, steamcmdAppUpdate } from "./steamcmd.js";

describe("steamcmd", () => {
  it("returns null when binary is absent", () => {
    const found = findSteamcmdBinary({
      PATH: "",
      Path: "",
      PLAYON_STEAMCMD: "",
      STEAMCMD: "",
      STEAMCMD_PATH: "",
    });
    expect(found).toBeNull();
  });

  it("honors PLAYON_STEAMCMD when the path exists", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-steam-"));
    const fake = path.join(root, process.platform === "win32" ? "steamcmd.exe" : "steamcmd.sh");
    fs.writeFileSync(fake, "#!/bin/sh\n", "utf8");
    expect(findSteamcmdBinary({ PLAYON_STEAMCMD: fake, PATH: "" })).toBe(path.resolve(fake));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("fails loud with steamcmd_not_found when missing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-steam-jail-"));
    await expect(
      steamcmdAppUpdate({
        serverDataPath: root,
        appId: 90,
        env: { PATH: "", Path: "", PLAYON_STEAMCMD: "", STEAMCMD: "" },
      }),
    ).rejects.toBeInstanceOf(SteamcmdNotFoundError);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
