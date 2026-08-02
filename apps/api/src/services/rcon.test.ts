import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateRconPassword, readRconConfig, writeRconConfig } from "./rcon.js";

describe("rcon config", () => {
  it("roundtrips rcon.json", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-rcon-"));
    const password = generateRconPassword();
    writeRconConfig(root, { host: "127.0.0.1", port: 25575, password });
    const loaded = readRconConfig(root);
    expect(loaded).toEqual({ host: "127.0.0.1", port: 25575, password });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("falls back to server.properties", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-rcon-"));
    fs.mkdirSync(path.join(root, "game"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "game", "server.properties"),
      ["enable-rcon=true", "rcon.port=25575", "rcon.password=secret-from-props"].join("\n"),
      "utf8",
    );
    expect(readRconConfig(root)).toEqual({
      host: "127.0.0.1",
      port: 25575,
      password: "secret-from-props",
    });
    fs.rmSync(root, { recursive: true, force: true });
  });
});
