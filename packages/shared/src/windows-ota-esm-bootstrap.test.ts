import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseNodeJobArgs } from "./node-jobs/registry.js";
import {
  NODE_SELF_UPDATE_VIA_ESM_BOOTSTRAP,
  VINTAGE_023_WINDOWS_SPAWN_HELPER,
  WINDOWS_ESM_REQUIRE_BROKEN_FROM,
  WINDOWS_ESM_REQUIRE_FIXED_IN,
  WINDOWS_OTA_ESM_BOOTSTRAP_PROCESS_NAME,
  WINDOWS_OTA_ESM_BOOTSTRAP_REL,
  isEsmBootstrapSelfUpdateArgs,
  windowsAgentNeedsEsmOtaBootstrap,
  windowsOtaEsmBootstrapScript,
  windowsOtaEsmBootstrapStartArgs,
  windowsOtaEsmBootstrapWriteArgs,
} from "./windows-ota-esm-bootstrap.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

describe("0.2.3-shaped Windows update helper / ESM path (#885)", () => {
  it("throws require is not defined when the vintage spawn line runs as ESM", () => {
    expect(VINTAGE_023_WINDOWS_SPAWN_HELPER).toContain('require("node:child_process")');
    try {
      execFileSync(process.execPath, ["--input-type=module", "-e", VINTAGE_023_WINDOWS_SPAWN_HELPER], {
        encoding: "utf8",
      });
      expect.unreachable("vintage ESM helper should throw");
    } catch (err) {
      const stderr = err instanceof Error && "stderr" in err ? String((err as { stderr: unknown }).stderr) : "";
      const message = err instanceof Error ? err.message : String(err);
      expect(`${stderr}\n${message}`).toMatch(/require is not defined/);
    }
  });

  it("the same require() works as CommonJS (.cjs / --input-type=commonjs)", () => {
    const out = execFileSync(
      process.execPath,
      [
        "--input-type=commonjs",
        "-e",
        `${VINTAGE_023_WINDOWS_SPAWN_HELPER}process.stdout.write(typeof spawn);`,
      ],
      { encoding: "utf8" },
    );
    expect(out).toBe("function");
  });

  it("shipped spawn-apply-update.cjs is CommonJS so require() is defined", () => {
    const helper = path.join(repoRoot, "deploy", "windows", "spawn-apply-update.cjs");
    const src = fs.readFileSync(helper, "utf8");
    expect(helper.endsWith(".cjs")).toBe(true);
    expect(src).toMatch(/require\("node:child_process"\)/);
    expect(src).toMatch(/^"use strict";/m);
    const probe = execFileSync(
      process.execPath,
      [
        "--input-type=commonjs",
        "-e",
        `const { spawn } = require("node:child_process"); process.stdout.write(typeof spawn);`,
      ],
      { encoding: "utf8" },
    );
    expect(probe).toBe("function");
  });
});

describe("windowsAgentNeedsEsmOtaBootstrap", () => {
  it("is true only for Windows 0.2.3 and 0.2.4", () => {
    expect(WINDOWS_ESM_REQUIRE_BROKEN_FROM).toBe("0.2.3");
    expect(WINDOWS_ESM_REQUIRE_FIXED_IN).toBe("0.2.5");
    expect(windowsAgentNeedsEsmOtaBootstrap({ os: "windows", agentVersion: "0.2.3" })).toBe(true);
    expect(windowsAgentNeedsEsmOtaBootstrap({ os: "windows", agentVersion: "0.2.4" })).toBe(true);
    expect(windowsAgentNeedsEsmOtaBootstrap({ os: "windows", agentVersion: "v0.2.3" })).toBe(true);
    expect(windowsAgentNeedsEsmOtaBootstrap({ os: "windows", agentVersion: "0.2.5" })).toBe(false);
    expect(windowsAgentNeedsEsmOtaBootstrap({ os: "windows", agentVersion: "0.2.8" })).toBe(false);
    expect(windowsAgentNeedsEsmOtaBootstrap({ os: "windows", agentVersion: "0.2.2" })).toBe(false);
    expect(windowsAgentNeedsEsmOtaBootstrap({ os: "linux", agentVersion: "0.2.3" })).toBe(false);
  });
});

describe("Home vintage Windows bootstrap jobs", () => {
  it("bootstrap script has no require() and launches apply-self-update.ps1", () => {
    const script = windowsOtaEsmBootstrapScript();
    expect(script).not.toMatch(/\brequire\s*\(/);
    expect(script).toMatch(/apply-self-update\.ps1/);
    expect(script).toMatch(/--force-local/);
    expect(script).toMatch(/ParentProcessId/);
    expect(script).toMatch(/Get-FileHash/);
    const shipped = fs.readFileSync(
      path.join(repoRoot, "deploy", "windows", "ota-esm-bootstrap.ps1"),
      "utf8",
    );
    expect(shipped.replace(/\r\n/g, "\n")).toBe(script);
  });

  it("write + start args are 0.2.3-shaped (jail-relative, no extra process_start keys)", () => {
    const write = windowsOtaEsmBootstrapWriteArgs();
    expect(write.path).toBe(WINDOWS_OTA_ESM_BOOTSTRAP_REL);
    expect(write.path).not.toMatch(/^[\\/]/);
    expect(write.path).not.toMatch(/\.\./);
    const parsedWrite = parseNodeJobArgs("fs_write_text", write);
    expect(parsedWrite.path).toBe(WINDOWS_OTA_ESM_BOOTSTRAP_REL);
    expect(parsedWrite.content).toContain("apply-self-update.ps1");

    const start = windowsOtaEsmBootstrapStartArgs({
      downloadUrl: "https://playon.games/home/packages/playon-node-0.2.8-windows-x64.tar.gz",
      sha256: "a".repeat(64),
      version: "0.2.8",
    });
    expect(start.name).toBe(WINDOWS_OTA_ESM_BOOTSTRAP_PROCESS_NAME);
    expect(start.command).toBe("powershell.exe");
    expect(start.cwd).toBe(".");
    expect(start.args).toContain("-File");
    expect(start.args).toContain("-DownloadUrl");
    const parsedStart = parseNodeJobArgs("process_start", start);
    expect(parsedStart).toMatchObject({
      name: WINDOWS_OTA_ESM_BOOTSTRAP_PROCESS_NAME,
      command: "powershell.exe",
      cwd: ".",
    });
    expect(parsedStart).not.toHaveProperty("keepStdin");
  });

  it("marks the Home-tracked self-update so the vintage agent must not claim it", () => {
    expect(
      isEsmBootstrapSelfUpdateArgs({ via: NODE_SELF_UPDATE_VIA_ESM_BOOTSTRAP }),
    ).toBe(true);
    expect(isEsmBootstrapSelfUpdateArgs({ via: "agent" })).toBe(false);
    const parsed = parseNodeJobArgs("node_self_update", {
      downloadUrl: "https://playon.games/home/packages/playon-node-0.2.8-windows-x64.tar.gz",
      sha256: "b".repeat(64),
      version: "0.2.8",
      via: NODE_SELF_UPDATE_VIA_ESM_BOOTSTRAP,
    });
    expect(parsed.via).toBe("esm-bootstrap");
  });
});
