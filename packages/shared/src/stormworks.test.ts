import { describe, expect, it } from "vitest";
import {
  STORMWORKS_CLIENT_APP_ID,
  STORMWORKS_DEDICATED_STUB_APP_ID,
  STORMWORKS_GAME_PORT,
  STORMWORKS_SKILL_NAME,
  isSteamDedicatedStubAppId,
  isStormworksSkill,
  parseStormworksServerConfigPort,
  resolveSteamInstallAppId,
  stormworksJailOverlayPlan,
  stormworksServerConfigXml,
  stormworksStartBat,
} from "./stormworks.js";

describe("Stormworks dedicated contract", () => {
  it("remaps discontinued tool 1247090 to client 573090", () => {
    expect(isSteamDedicatedStubAppId(STORMWORKS_DEDICATED_STUB_APP_ID)).toBe(true);
    expect(resolveSteamInstallAppId(1247090)).toBe(STORMWORKS_CLIENT_APP_ID);
    expect(resolveSteamInstallAppId(573090)).toBe(573090);
    expect(isSteamDedicatedStubAppId(1180760)).toBe(false);
  });

  it("identifies the catalog skill", () => {
    expect(isStormworksSkill(STORMWORKS_SKILL_NAME)).toBe(true);
    expect(isStormworksSkill("games.valheim")).toBe(false);
    expect(isStormworksSkill("")).toBe(false);
  });

  it("parses server_config.xml port and ignores junk", () => {
    expect(parseStormworksServerConfigPort(`<server_data port="25564" name="x"/>`)).toBe(25564);
    expect(parseStormworksServerConfigPort(`<server_data port='25570'>`)).toBe(25570);
    expect(parseStormworksServerConfigPort(stormworksServerConfigXml())).toBe(STORMWORKS_GAME_PORT);
    expect(parseStormworksServerConfigPort(`<server_data name="x"/>`)).toBeNull();
    expect(parseStormworksServerConfigPort(`<server_data port="99999"/>`)).toBeNull();
  });

  it("start.bat pins +server_dir and locates server64.exe", () => {
    const bat = stormworksStartBat();
    expect(bat).toContain("\r\n");
    expect(bat).toMatch(/\+server_dir/);
    expect(bat).toMatch(/server64\.exe/);
    expect(bat).toMatch(/PLAYON_MANAGED_FROM/);
    expect(bat).toMatch(/Steam\\steamapps\\common\\Stormworks/);
    expect(bat).not.toMatch(/\bstart\s+"/i);
  });

  it("rewrites overlay when start.bat lacks +server_dir or PE", () => {
    expect(
      stormworksJailOverlayPlan({
        startBat: "server.exe\r\n",
        configXml: "",
      }),
    ).toEqual({ writeStartBat: true, writeConfig: true });
    expect(
      stormworksJailOverlayPlan({
        startBat: stormworksStartBat(),
        configXml: stormworksServerConfigXml(),
      }),
    ).toEqual({ writeStartBat: false, writeConfig: false });
    expect(
      stormworksJailOverlayPlan({
        startBat: '"%EXE%" +server_dir "%ROOT%\\server_data"\r\n',
        configXml: `<server_data port="25570"/>`,
      }),
    ).toEqual({ writeStartBat: true, writeConfig: false });
  });
});
