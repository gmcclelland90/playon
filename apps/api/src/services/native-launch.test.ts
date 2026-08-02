import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SkillMetadataSchema } from "@playon/shared";
import { resolveNativeLaunch } from "./native-launch.js";

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
});
