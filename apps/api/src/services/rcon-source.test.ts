import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverSourceRconFromTree,
  parseSourceRconText,
  patchSourceRconCfgText,
  patchSourceRconConfigFiles,
  patchSourceRconIniText,
} from "./rcon.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseSourceRconText", () => {
  it("parses Zomboid-style ini keys", () => {
    expect(
      parseSourceRconText("RCONPort=27015\nRCONPassword=secret-pass\nPublic=true\n"),
    ).toEqual({ port: 27015, password: "secret-pass" });
  });

  it("parses Source server.cfg rcon_password", () => {
    expect(parseSourceRconText('rcon_password "hunter2"\nhostname "x"\n')).toEqual({
      port: 27015,
      password: "hunter2",
    });
  });

  it("returns null when password empty", () => {
    expect(parseSourceRconText("RCONPort=27015\nRCONPassword=\n")).toBeNull();
  });
});

describe("patchSourceRconIniText / cfg", () => {
  it("updates ini password and port", () => {
    const next = patchSourceRconIniText("RCONPort=1\nRCONPassword=old\n", {
      host: "127.0.0.1",
      port: 27015,
      password: "new",
    });
    expect(next).toContain("RCONPassword=new");
    expect(next).toContain("RCONPort=27015");
  });

  it("updates server.cfg rcon_password", () => {
    const next = patchSourceRconCfgText('rcon_password "old"\n', {
      host: "127.0.0.1",
      port: 27015,
      password: "new",
    });
    expect(next).toContain('rcon_password "new"');
  });
});

describe("discoverSourceRconFromTree + patch", () => {
  it("finds ini under game tree and can patch password", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-srcon-"));
    temps.push(root);
    const iniDir = path.join(root, "game", "Zomboid", "Server");
    fs.mkdirSync(iniDir, { recursive: true });
    const ini = path.join(iniDir, "servertest.ini");
    fs.writeFileSync(ini, "RCONPort=27015\nRCONPassword=old\n", "utf8");

    expect(discoverSourceRconFromTree(root)).toEqual({
      host: "127.0.0.1",
      port: 27015,
      password: "old",
    });

    expect(
      patchSourceRconConfigFiles(root, {
        host: "127.0.0.1",
        port: 27015,
        password: "new-secret",
      }),
    ).toBe(true);
    expect(fs.readFileSync(ini, "utf8")).toContain("RCONPassword=new-secret");
  });
});
