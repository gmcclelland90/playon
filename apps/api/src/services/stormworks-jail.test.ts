import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stormworksServerConfigXml, stormworksStartBat } from "@playon/shared";
import { ensureStormworksGameJail, stormworksJailOverlayFiles } from "./stormworks-jail.js";

describe("ensureStormworksGameJail", () => {
  it("writes start.bat with +server_dir and port-25564 config when missing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-sw-jail-"));
    const gameDir = path.join(root, "game");
    const written = ensureStormworksGameJail(gameDir);
    expect(written).toEqual(["start.bat", "server_data/server_config.xml"]);
    expect(fs.readFileSync(path.join(gameDir, "start.bat"), "utf8")).toContain("+server_dir");
    expect(fs.readFileSync(path.join(gameDir, "server_data", "server_config.xml"), "utf8")).toContain(
      'port="25564"',
    );
    expect(ensureStormworksGameJail(gameDir)).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("replaces a stub start.bat that launches server.exe without +server_dir", () => {
    const files = stormworksJailOverlayFiles({
      startBat: "@echo off\r\nserver.exe\r\n",
      configXml: stormworksServerConfigXml(),
    });
    expect(files.map((f) => f.relPath)).toEqual(["start.bat"]);
    expect(files[0]?.content).toBe(stormworksStartBat());
  });

  it("keeps a host config that already declares a port", () => {
    const files = stormworksJailOverlayFiles({
      startBat: stormworksStartBat(),
      configXml: `<server_data port="25570" name="custom"/>`,
    });
    expect(files).toEqual([]);
  });
});
