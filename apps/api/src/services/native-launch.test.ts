import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SkillMetadataSchema } from "@playon/shared";
import {
  ensureLinuxSteamSdk32,
  resolveNativeArgs,
  resolveNativeLaunch,
} from "./native-launch.js";

const rustMeta = SkillMetadataSchema.parse({
  name: "games.rust",
  version: "0.1.0",
  containerSupport: "none",
  native: {
    binary: "RustDedicated",
    binaryWindows: "RustDedicated.exe",
    preferStartScript: true,
    libraryPathRelative: ["RustDedicated_Data/Plugins", "RustDedicated_Data/Plugins/x86_64"],
  },
});

describe("native-launch", () => {
  it("prefers start.sh when metadata asks for scripts", () => {
    if (process.platform === "win32") return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-rust-"));
    const gameDir = path.join(root, "game");
    fs.mkdirSync(gameDir, { recursive: true });
    fs.writeFileSync(path.join(gameDir, "RustDedicated"), "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(path.join(gameDir, "start.sh"), "#!/bin/bash\n./RustDedicated\n");

    const launch = resolveNativeLaunch({
      skillName: "games.rust",
      game: "Rust",
      gameDir,
      metadata: rustMeta,
    });
    expect(launch?.kind).toBe("script");
    expect(launch?.command).toBe("/bin/bash");
    expect(launch?.args).toEqual([path.join(gameDir, "start.sh")]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("launches binary from skill native metadata when no script", () => {
    if (process.platform === "win32") return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-bin-"));
    const gameDir = path.join(root, "game");
    fs.mkdirSync(gameDir, { recursive: true });
    fs.writeFileSync(path.join(gameDir, "RustDedicated"), "#!/bin/sh\n", { mode: 0o755 });

    const launch = resolveNativeLaunch({
      skillName: "games.rust",
      gameDir,
      metadata: rustMeta,
    });
    expect(launch?.kind).toBe("native");
    expect(launch?.command).toBe(path.join(gameDir, "RustDedicated"));
    expect(launch?.env.LD_LIBRARY_PATH).toContain("RustDedicated_Data");

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("resolves native.binary paths that contain spaces", () => {
    if (process.platform === "win32") return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-space-bin-"));
    const gameDir = path.join(root, "game");
    fs.mkdirSync(gameDir, { recursive: true });
    fs.writeFileSync(path.join(gameDir, "Holdfast NaW"), "#!/bin/sh\n", { mode: 0o755 });

    const meta = SkillMetadataSchema.parse({
      name: "games.holdfast",
      version: "0.1.1",
      containerSupport: "none",
      native: {
        binary: "Holdfast NaW",
        preferStartScript: false,
        args: ["-startserver", "--serverheadless"],
      },
    });
    const launch = resolveNativeLaunch({
      skillName: "games.holdfast",
      gameDir,
      metadata: meta,
    });
    expect(launch?.kind).toBe("native");
    expect(launch?.command).toBe(path.join(gameDir, "Holdfast NaW"));
    expect(launch?.args).toEqual(["-startserver", "--serverheadless"]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("prefers vendor LaunchServer.sh when present", () => {
    if (process.platform === "win32") return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-launchserver-"));
    const gameDir = path.join(root, "game");
    fs.mkdirSync(gameDir, { recursive: true });
    fs.writeFileSync(path.join(gameDir, "Holdfast NaW"), "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(path.join(gameDir, "LaunchServer.sh"), "#!/bin/bash\n");

    const meta = SkillMetadataSchema.parse({
      name: "games.holdfast",
      version: "0.1.1",
      containerSupport: "none",
      native: {
        binary: "Holdfast NaW",
        preferStartScript: true,
      },
    });
    const launch = resolveNativeLaunch({
      skillName: "games.holdfast",
      gameDir,
      metadata: meta,
    });
    expect(launch?.kind).toBe("script");
    expect(launch?.args).toEqual([path.join(gameDir, "LaunchServer.sh")]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("launches metadata .sh binary via bash with native.args", () => {
    if (process.platform === "win32") return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-sh-"));
    const gameDir = path.join(root, "game");
    fs.mkdirSync(gameDir, { recursive: true });
    fs.writeFileSync(path.join(gameDir, "startserver.sh"), "#!/bin/sh\n", { mode: 0o644 });
    fs.writeFileSync(path.join(gameDir, "serverconfig.xml"), "<ServerSettings/>\n");

    const meta = SkillMetadataSchema.parse({
      name: "games.7-days-to-die",
      version: "0.1.1",
      containerSupport: "none",
      native: {
        binary: "startserver.sh",
        preferStartScript: true,
        args: ["-configfile=serverconfig.xml"],
      },
    });
    const launch = resolveNativeLaunch({
      skillName: "games.7-days-to-die",
      gameDir,
      metadata: meta,
    });
    expect(launch?.kind).toBe("script");
    expect(launch?.command).toBe("/bin/bash");
    expect(launch?.args).toEqual([
      path.join(gameDir, "startserver.sh"),
      "-configfile=serverconfig.xml",
    ]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("falls back to generic start.sh without metadata", () => {
    if (process.platform === "win32") return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-native-"));
    const gameDir = path.join(root, "game");
    fs.mkdirSync(gameDir, { recursive: true });
    fs.writeFileSync(path.join(gameDir, "start.sh"), "#!/bin/bash\necho hi\n");

    const launch = resolveNativeLaunch({ skillName: "custom.game", gameDir });
    expect(launch?.kind).toBe("script");
    expect(launch?.command).toBe("/bin/bash");

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("copies steamclient into ~/.steam/sdk32 for HLDS launches", () => {
    if (process.platform === "win32") return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-hlds-"));
    const gameDir = path.join(root, "game");
    const fakeHome = path.join(root, "home");
    fs.mkdirSync(gameDir, { recursive: true });
    fs.mkdirSync(fakeHome, { recursive: true });
    fs.writeFileSync(path.join(gameDir, "hlds_run"), "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(path.join(gameDir, "steamclient.so"), "hlds-so");

    const prevHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      ensureLinuxSteamSdk32(gameDir);
      const link = path.join(fakeHome, ".steam", "sdk32", "steamclient.so");
      expect(fs.readFileSync(link, "utf8")).toBe("hlds-so");

      const meta = SkillMetadataSchema.parse({
        name: "games.css-cz",
        version: "0.1.4",
        containerSupport: "none",
        steamAppId: 90,
        steamMod: "czero",
        native: {
          binary: "hlds_run",
          preferStartScript: false,
          args: ["-game", "czero", "+sv_lan", "1", "-insecure"],
        },
      });
      const launch = resolveNativeLaunch({
        skillName: "games.css-cz",
        gameDir,
        metadata: meta,
      });
      expect(launch?.command).toBe("/bin/bash");
      expect(launch?.args[0]).toBe(path.join(gameDir, "hlds_run"));
      expect(launch?.args).toContain("-insecure");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("strips CRLF from srcds_run before launch (SteamCMD depot)", () => {
    if (process.platform === "win32") return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-srcds-crlf-"));
    const gameDir = path.join(root, "game");
    fs.mkdirSync(gameDir, { recursive: true });
    fs.writeFileSync(path.join(gameDir, "srcds_run"), "#!/bin/sh\r\necho ok\r\n", {
      mode: 0o755,
    });

    const meta = SkillMetadataSchema.parse({
      name: "games.insurgency",
      version: "0.1.1",
      containerSupport: "none",
      steamAppId: 237410,
      native: {
        binary: "srcds_run",
        preferStartScript: false,
        args: ["-game", "insurgency"],
      },
    });
    const launch = resolveNativeLaunch({
      skillName: "games.insurgency",
      gameDir,
      metadata: meta,
    });
    expect(launch?.command).toBe("/bin/bash");
    expect(launch?.args[0]).toBe(path.join(gameDir, "srcds_run"));
    const body = fs.readFileSync(path.join(gameDir, "srcds_run"), "utf8");
    expect(body).not.toContain("\r");
    expect(body.startsWith("#!/bin/sh\n")).toBe(true);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("prefers SteamCMD steamclient for SRCDS sdk32 setup", () => {
    if (process.platform === "win32") return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-srcds-"));
    const gameDir = path.join(root, "game");
    const fakeHome = path.join(root, "home");
    const steamcmd = path.join(root, "steamcmd", "linux32");
    fs.mkdirSync(path.join(gameDir, "bin"), { recursive: true });
    fs.mkdirSync(steamcmd, { recursive: true });
    fs.mkdirSync(fakeHome, { recursive: true });
    fs.writeFileSync(path.join(gameDir, "srcds_run"), "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(path.join(gameDir, "bin", "steamclient.so"), "game-so");
    fs.writeFileSync(path.join(steamcmd, "steamclient.so"), "steamcmd-so");

    const prevHome = process.env.HOME;
    const prevSteamcmd = process.env.PLAYON_STEAMCMD;
    process.env.HOME = fakeHome;
    process.env.PLAYON_STEAMCMD = path.join(root, "steamcmd", "steamcmd.sh");
    try {
      const meta = SkillMetadataSchema.parse({
        name: "games.fistful-of-frags",
        version: "0.1.1",
        containerSupport: "none",
        steamAppId: 295230,
        native: {
          binary: "srcds_run",
          preferStartScript: false,
          args: ["-game", "fof", "+map", "fof_depot"],
        },
      });
      const launch = resolveNativeLaunch({
        skillName: "games.fistful-of-frags",
        gameDir,
        metadata: meta,
      });
      expect(launch?.command).toBe("/bin/bash");
      expect(launch?.args[0]).toBe(path.join(gameDir, "srcds_run"));
      const link = path.join(fakeHome, ".steam", "sdk32", "steamclient.so");
      expect(fs.readFileSync(link, "utf8")).toBe("steamcmd-so");
      expect(fs.readlinkSync(path.join(fakeHome, ".steam", "steam"))).toBe(
        path.join(root, "steamcmd"),
      );
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevSteamcmd === undefined) delete process.env.PLAYON_STEAMCMD;
      else process.env.PLAYON_STEAMCMD = prevSteamcmd;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("injects Bannerlord auth token from env into native args", () => {
    const prev = process.env.PLAYON_BANNERLORD_AUTH_TOKEN;
    process.env.PLAYON_BANNERLORD_AUTH_TOKEN = "tok-abc";
    try {
      const args = resolveNativeArgs({
        skillName: "games.bannerlord",
        args: ["_MODULES_*Native*Multiplayer*_MODULES_", "/port", "7210"],
      });
      expect(args).toEqual([
        "_MODULES_*Native*Multiplayer*_MODULES_",
        "/port",
        "7210",
        "/dedicatedcustomserverauthtoken",
        "tok-abc",
      ]);
      expect(
        resolveNativeArgs({
          skillName: "games.hurtworld",
          args: ["-batchmode"],
        }),
      ).toEqual(["-batchmode"]);
    } finally {
      if (prev === undefined) delete process.env.PLAYON_BANNERLORD_AUTH_TOKEN;
      else process.env.PLAYON_BANNERLORD_AUTH_TOKEN = prev;
    }
  });

  it("resolves Windows batch scripts via ComSpec cmd.exe", () => {
    if (process.platform !== "win32") return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-win-bat-"));
    const gameDir = path.join(root, "game");
    fs.mkdirSync(gameDir, { recursive: true });
    fs.writeFileSync(path.join(gameDir, "start.bat"), "@echo off\necho hi\n");

    try {
      const launch = resolveNativeLaunch({ skillName: "test.game", gameDir });
      expect(launch?.kind).toBe("script");
      expect(launch?.command).toBeTruthy();
      expect(launch?.command.toLowerCase()).toMatch(/cmd\.exe$/);
      expect(launch?.args).toContain("/c");
      expect(launch?.args.some((a) => a.includes("start.bat"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves Windows PowerShell scripts with proper args", () => {
    if (process.platform !== "win32") return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-win-ps1-"));
    const gameDir = path.join(root, "game");
    fs.mkdirSync(gameDir, { recursive: true });
    fs.writeFileSync(path.join(gameDir, "start.ps1"), "Write-Host 'Server starting'\n");

    try {
      const launch = resolveNativeLaunch({ skillName: "test.game", gameDir });
      expect(launch?.kind).toBe("script");
      expect(launch?.command).toBeTruthy();
      expect(launch?.command.toLowerCase()).toMatch(/p(ower)?s(hell)?\.exe$/);
      expect(launch?.args).toContain("-NoProfile");
      expect(launch?.args).toContain("-ExecutionPolicy");
      expect(launch?.args).toContain("Bypass");
      expect(launch?.args).toContain("-File");
      expect(launch?.args.some((a) => a.includes("start.ps1"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("prefers batch over PowerShell on Windows", () => {
    if (process.platform !== "win32") return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-win-both-"));
    const gameDir = path.join(root, "game");
    fs.mkdirSync(gameDir, { recursive: true });
    fs.writeFileSync(path.join(gameDir, "start.bat"), "@echo off\n");
    fs.writeFileSync(path.join(gameDir, "start.ps1"), "Write-Host 'PS'\n");

    try {
      const launch = resolveNativeLaunch({ skillName: "test.game", gameDir });
      expect(launch?.kind).toBe("script");
      expect(launch?.command.toLowerCase()).toMatch(/cmd\.exe$/);
      expect(launch?.args.some((a) => a.includes("start.bat"))).toBe(true);
      expect(launch?.args.some((a) => a.includes("start.ps1"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to PowerShell when only .ps1 exists on Windows", () => {
    if (process.platform !== "win32") return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-win-ps1only-"));
    const gameDir = path.join(root, "game");
    fs.mkdirSync(gameDir, { recursive: true });
    fs.writeFileSync(path.join(gameDir, "run.ps1"), "# PowerShell only\n");

    try {
      const launch = resolveNativeLaunch({ skillName: "test.game", gameDir });
      expect(launch?.kind).toBe("script");
      expect(launch?.command.toLowerCase()).toMatch(/p(ower)?s(hell)?\.exe$/);
      expect(launch?.args.some((a) => a.includes("run.ps1"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves scripts in priority order: .bat before .ps1 on Windows", () => {
    if (process.platform !== "win32") return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-win-order-"));
    const gameDir = path.join(root, "game");
    fs.mkdirSync(gameDir, { recursive: true });
    
    // Test 1: start.bat preferred over start.ps1
    fs.writeFileSync(path.join(gameDir, "start.bat"), "@echo off\n");
    fs.writeFileSync(path.join(gameDir, "start.ps1"), "Write-Host 'PS'\n");
    try {
      const launch1 = resolveNativeLaunch({ skillName: "test.game", gameDir });
      expect(launch1?.command.toLowerCase()).toMatch(/cmd\.exe$/);
      expect(launch1?.args.some((a) => a.includes("start.bat"))).toBe(true);
    } finally {
      fs.unlinkSync(path.join(gameDir, "start.bat"));
      fs.unlinkSync(path.join(gameDir, "start.ps1"));
    }

    // Test 2: run.bat preferred over run.ps1
    fs.writeFileSync(path.join(gameDir, "run.bat"), "@echo off\n");
    fs.writeFileSync(path.join(gameDir, "run.ps1"), "Write-Host 'PS'\n");
    try {
      const launch2 = resolveNativeLaunch({ skillName: "test.game", gameDir });
      expect(launch2?.command.toLowerCase()).toMatch(/cmd\.exe$/);
      expect(launch2?.args.some((a) => a.includes("run.bat"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
