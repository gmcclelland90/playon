import { describe, expect, it } from "vitest";
import {
  VINTAGE_PACKAGED_WINDOWS_START_NODE_CMD,
  bundledWindowsStartNodeCmd,
  startNodeCmdLoadsNodeEnv,
} from "./windows-start-node-cmd.js";

describe("Windows start-node.cmd Home wiring", () => {
  it("vintage packaged launcher does not load node.env.cmd (playon-win-1 Aug 15)", () => {
    expect(startNodeCmdLoadsNodeEnv(VINTAGE_PACKAGED_WINDOWS_START_NODE_CMD)).toBe(false);
    expect(VINTAGE_PACKAGED_WINDOWS_START_NODE_CMD).not.toMatch(/call/i);
    expect(VINTAGE_PACKAGED_WINDOWS_START_NODE_CMD).not.toMatch(/node\.env\.cmd/i);
  });

  it("bundled leftover launcher calls node.env.cmd and does not redirect a locked log", () => {
    const cmd = bundledWindowsStartNodeCmd();
    expect(startNodeCmdLoadsNodeEnv(cmd)).toBe(true);
    expect(cmd).toMatch(/if exist "%~dp0node\.env\.cmd" call "%~dp0node\.env\.cmd"/);
    expect(cmd).toContain("runtime\\node\\node.exe");
    expect(cmd).toContain("apps\\node-agent\\dist\\index.js");
    expect(cmd).toContain("--require");
    expect(cmd).toContain("load-env.cjs");
    expect(cmd).not.toMatch(/>>/);
    expect(cmd).not.toMatch(/agent-stdout\.log/);
    expect(cmd.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("accepts installer-style absolute call + CRLF", () => {
    const installer = [
      "@echo off",
      'call "C:\\playon-node\\node.env.cmd"',
      'cd /d "C:\\playon-node"',
      '"C:\\playon-node\\runtime\\node\\node.exe" "C:\\playon-node\\apps\\node-agent\\dist\\index.js" >> "C:\\playon-node\\data\\agent-stdout.log" 2>&1',
    ].join("\r\n");
    expect(startNodeCmdLoadsNodeEnv(installer)).toBe(true);
  });
});
