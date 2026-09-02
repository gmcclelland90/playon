import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyWindowsNodeEnv,
  parseWindowsNodeEnvCmd,
  parseWindowsNodeEnvJson,
  serializeWindowsNodeEnvCmd,
  serializeWindowsNodeEnvJson,
  windowsLoadEnvCjsSource,
  windowsNodeEnvFileIsCrlf,
} from "./windows-node-env.js";

const sample: Record<string, string> = {
  PLAYON_API_URL: "http://172.16.0.156:8787",
  PLAYON_NODE_TOKEN: "tok",
  PLAYON_NODE_ID: "playon-win-1",
  PLAYON_NODE_NAME: "playon-win-1",
  PLAYON_DATA_ROOT: "C:\\playon-node\\data",
  PLAYON_RUNTIME: "native",
  PLAYON_INSTALL_ROOT: "C:\\playon-node",
};

describe("Windows node.env.cmd CRLF", () => {
  it("serializes leftover node.env.cmd with CRLF only (cmd.exe call hang)", () => {
    const cmd = serializeWindowsNodeEnvCmd(sample);
    expect(windowsNodeEnvFileIsCrlf(cmd)).toBe(true);
    expect(cmd).toContain("\r\n");
    expect(cmd.replace(/\r\n/g, "")).not.toContain("\n");
    expect(cmd).toMatch(/set PLAYON_API_URL=http:\/\/172\.16\.0\.156:8787/);
    expect(parseWindowsNodeEnvCmd(cmd)).toMatchObject({
      PLAYON_API_URL: "http://172.16.0.156:8787",
      PLAYON_NODE_ID: "playon-win-1",
    });
  });

  it("parses LF-only vintage files so a repaired install can rewrite them", () => {
    const lf = Object.entries(sample)
      .map(([k, v]) => `set ${k}=${v}`)
      .join("\n");
    expect(windowsNodeEnvFileIsCrlf(lf)).toBe(false);
    expect(parseWindowsNodeEnvCmd(lf).PLAYON_NODE_TOKEN).toBe("tok");
    const repaired = serializeWindowsNodeEnvCmd(parseWindowsNodeEnvCmd(lf));
    expect(windowsNodeEnvFileIsCrlf(repaired)).toBe(true);
  });

  it("does not overwrite env already set on the process", () => {
    const env: NodeJS.ProcessEnv = { PLAYON_API_URL: "http://already.set" };
    const applied = applyWindowsNodeEnv({ PLAYON_API_URL: "http://from.file", PLAYON_NODE_ID: "n1" }, env);
    expect(env.PLAYON_API_URL).toBe("http://already.set");
    expect(env.PLAYON_NODE_ID).toBe("n1");
    expect(applied).toEqual(["PLAYON_NODE_ID"]);
  });

  it("round-trips JSON wiring", () => {
    const json = serializeWindowsNodeEnvJson(sample);
    expect(parseWindowsNodeEnvJson(json)).toMatchObject({
      PLAYON_INSTALL_ROOT: "C:\\playon-node",
      PLAYON_RUNTIME: "native",
    });
  });
});

describe("shipped load-env.cjs", () => {
  it("matches the shared source so the tarball and --require stay in lockstep", () => {
    const shipped = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(new URL("./windows-node-env.ts", import.meta.url))), "..", "..", "..", "deploy", "windows", "load-env.cjs"),
      "utf8",
    );
    expect(shipped.replace(/\r\n/g, "\n").trim()).toBe(windowsLoadEnvCjsSource().replace(/\r\n/g, "\n").trim());
  });
});

describe("load-env.cjs preload", () => {
  it("loads LF node.env.cmd without hanging and tees a rotating log", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-load-env-"));
    const dataRoot = path.join(root, "data");
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(
      path.join(root, "node.env.cmd"),
      "set PLAYON_API_URL=http://home:8787\nset PLAYON_NODE_ID=win-lf\nset PLAYON_DATA_ROOT=" +
        dataRoot +
        "\n",
      "utf8",
    );
    const cjs = path.join(root, "load-env.cjs");
    fs.writeFileSync(cjs, windowsLoadEnvCjsSource(), "utf8");
    const child = path.join(root, "print.cjs");
    const status = path.join(root, "status.json");
    fs.writeFileSync(
      child,
      `require("fs");\nrequire(${JSON.stringify(cjs)});\nvar fs = require("fs");\nprocess.stdout.write("hello-from-preload\\n");\nfs.writeFileSync(${JSON.stringify(status)}, JSON.stringify({\n  api: process.env.PLAYON_API_URL,\n  id: process.env.PLAYON_NODE_ID,\n  install: process.env.PLAYON_INSTALL_ROOT,\n}));\n`,
      "utf8",
    );
    try {
      const env = { ...process.env };
      delete env.PLAYON_API_URL;
      delete env.PLAYON_NODE_ID;
      delete env.PLAYON_INSTALL_ROOT;
      delete env.PLAYON_DATA_ROOT;
      execFileSync(process.execPath, [child], { env, encoding: "utf8" });
      expect(JSON.parse(fs.readFileSync(status, "utf8"))).toEqual({
        api: "http://home:8787",
        id: "win-lf",
        install: root,
      });
      const log = fs.readFileSync(path.join(dataRoot, "agent-stdout.log"), "utf8");
      expect(log).toContain("hello-from-preload");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
