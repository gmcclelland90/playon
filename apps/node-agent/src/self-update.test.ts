import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock child_process for Windows test only
let mockExecFileSync: any = null;
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: (cmd: string, args?: readonly string[], options?: any) => {
      if (mockExecFileSync) {
        return mockExecFileSync(cmd, args, options);
      }
      return actual.execFileSync(cmd as any, args as any, options);
    },
  };
});

import { performNodeSelfUpdate, swapInstallTree } from "./self-update.js";

afterEach(() => {
  vi.unstubAllGlobals();
  mockExecFileSync = null;
});

describe("swapInstallTree", () => {
  it("preserves data and env", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-swap-"));
    try {
      const target = path.join(root, "target");
      const source = path.join(root, "source");
      fs.mkdirSync(path.join(target, "data"), { recursive: true });
      fs.writeFileSync(path.join(target, "data", "keep.txt"), "keep");
      fs.mkdirSync(path.join(target, "env"), { recursive: true });
      fs.writeFileSync(path.join(target, "env", "secrets"), "secret");
      fs.writeFileSync(path.join(target, "old.txt"), "old");
      fs.mkdirSync(source, { recursive: true });
      fs.writeFileSync(path.join(source, "package.json"), "{}");
      fs.writeFileSync(path.join(source, "new.txt"), "new");
      fs.mkdirSync(path.join(source, "data"), { recursive: true });
      fs.writeFileSync(path.join(source, "data", "wipe.txt"), "wipe");

      const result = swapInstallTree({
        target,
        source,
        preserve: ["data", "env"],
      });
      expect(result.preserved).toContain("data");
      expect(fs.readFileSync(path.join(target, "data", "keep.txt"), "utf8")).toBe("keep");
      expect(fs.readFileSync(path.join(target, "env", "secrets"), "utf8")).toBe("secret");
      expect(fs.existsSync(path.join(target, "data", "wipe.txt"))).toBe(false);
      expect(fs.readFileSync(path.join(target, "new.txt"), "utf8")).toBe("new");
      expect(fs.existsSync(path.join(target, "old.txt"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("performNodeSelfUpdate", () => {
  it("downloads, verifies, and swaps with skipExit", async () => {
    if (process.platform === "win32") return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-self-"));
    try {
      const installRoot = path.join(root, "install");
      fs.mkdirSync(path.join(installRoot, "data"), { recursive: true });
      fs.writeFileSync(path.join(installRoot, "data", "state.db"), "db");

      const pkgDir = path.join(root, "pkg");
      const playonNode = path.join(pkgDir, "playon-node");
      fs.mkdirSync(path.join(playonNode, "apps", "node-agent", "dist"), { recursive: true });
      fs.writeFileSync(path.join(playonNode, "package.json"), JSON.stringify({ name: "playon-node", version: "0.1.5" }));
      fs.writeFileSync(path.join(playonNode, "apps", "node-agent", "dist", "index.js"), "// agent");
      const archive = path.join(root, "playon-node-0.1.5-linux-x64.tar.gz");
      const { execFileSync } = await import("node:child_process");
      execFileSync("tar", ["-czf", archive, "-C", pkgDir, "playon-node"]);
      const bytes = fs.readFileSync(archive);
      const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");

      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        })),
      );

      const result = await performNodeSelfUpdate({
        downloadUrl: "https://playon.games/home/packages/playon-node-0.1.5-linux-x64.tar.gz",
        sha256,
        version: "0.1.5",
        installRoot,
        skipExit: true,
      });
      expect(result.version).toBe("0.1.5");
      expect(result.preserved).toContain("data");
      expect(fs.readFileSync(path.join(installRoot, "data", "state.db"), "utf8")).toBe("db");
      expect(fs.existsSync(path.join(installRoot, "apps", "node-agent", "dist", "index.js"))).toBe(
        true,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves node.env and node.env.cmd by default", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-preserve-"));
    try {
      const target = path.join(root, "target");
      const source = path.join(root, "source");
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, "node.env"), "VAR=old");
      fs.writeFileSync(path.join(target, "node.env.cmd"), "set VAR=old");
      fs.mkdirSync(path.join(target, "data"), { recursive: true });
      fs.writeFileSync(path.join(target, "data", "keep.txt"), "keep");

      fs.mkdirSync(source, { recursive: true });
      fs.writeFileSync(path.join(source, "package.json"), "{}");
      fs.writeFileSync(path.join(source, "node.env"), "VAR=new");
      fs.writeFileSync(path.join(source, "node.env.cmd"), "set VAR=new");

      const result = swapInstallTree({
        target,
        source,
        preserve: ["data", "env", "node.env", "node.env.cmd"],
      });
      expect(result.preserved).toContain("data");
      expect(result.preserved).toContain("node.env");
      expect(result.preserved).toContain("node.env.cmd");
      expect(fs.readFileSync(path.join(target, "node.env"), "utf8")).toBe("VAR=old");
      expect(fs.readFileSync(path.join(target, "node.env.cmd"), "utf8")).toBe("set VAR=old");
      expect(fs.readFileSync(path.join(target, "data", "keep.txt"), "utf8")).toBe("keep");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws if Windows update helper script is missing", async () => {
    if (process.platform !== "win32") return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-win-"));
    try {
      const installRoot = path.join(root, "install");
      fs.mkdirSync(path.join(installRoot, "data"), { recursive: true });

      mockExecFileSync = (cmd: string, args?: readonly string[], options?: any) => {
        if (cmd === "powershell.exe" && args && args.some((a) => a.includes("Expand-Archive"))) {
          const cmdStr = args.join(" ");
          const destMatch = cmdStr.match(/-DestinationPath\s+'([^']+)'/);
          if (destMatch) {
            const destDir = destMatch[1];
            const extractedRoot = path.join(destDir, "playon-node");
            fs.mkdirSync(path.join(extractedRoot, "apps", "node-agent", "dist"), { recursive: true });
            fs.writeFileSync(
              path.join(extractedRoot, "package.json"),
              JSON.stringify({ name: "playon-node", version: "0.2.0" }),
            );
            fs.writeFileSync(path.join(extractedRoot, "apps", "node-agent", "dist", "index.js"), "// agent");
            return;
          }
        }
        throw new Error(`Unexpected command: ${cmd}`);
      };

      const fakeArchiveBytes = Buffer.from("fake-zip-content");
      const sha256 = crypto.createHash("sha256").update(fakeArchiveBytes).digest("hex");

      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          arrayBuffer: async () =>
            fakeArchiveBytes.buffer.slice(
              fakeArchiveBytes.byteOffset,
              fakeArchiveBytes.byteOffset + fakeArchiveBytes.byteLength,
            ),
        })),
      );

      await expect(
        performNodeSelfUpdate({
          downloadUrl: "https://playon.games/home/packages/playon-node-0.2.0-windows-x64.zip",
          sha256,
          version: "0.2.0",
          installRoot,
          skipExit: false,
        }),
      ).rejects.toThrow("update_helper_missing");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("swapInstallTree does not delete sibling processes under data tree (#837 regression)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-sibling-"));
    try {
      const target = path.join(root, "target");
      const source = path.join(root, "source");

      // Simulate a game server executable under data/ (like Moria, VRising, etc.)
      fs.mkdirSync(path.join(target, "data", "servers", "vrising"), { recursive: true });
      fs.writeFileSync(path.join(target, "data", "servers", "vrising", "server.exe"), "fake PE");
      fs.writeFileSync(path.join(target, "data", "servers", "vrising", "world.db"), "save data");

      // Other data that should be preserved
      fs.writeFileSync(path.join(target, "data", "state.db"), "agent state");

      // Old package files that should be replaced
      fs.writeFileSync(path.join(target, "old-package.json"), "{}");
      fs.mkdirSync(path.join(target, "apps"), { recursive: true });
      fs.writeFileSync(path.join(target, "apps", "old-agent.js"), "old");

      // New package files
      fs.mkdirSync(path.join(source, "apps", "node-agent", "dist"), { recursive: true });
      fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ version: "0.2.3" }));
      fs.writeFileSync(path.join(source, "apps", "node-agent", "dist", "index.js"), "new agent");

      const result = swapInstallTree({
        target,
        source,
        preserve: ["data", "env"],
      });

      expect(result.preserved).toContain("data");

      // Data tree and all sibling game server files must survive the swap
      expect(fs.existsSync(path.join(target, "data", "servers", "vrising", "server.exe"))).toBe(true);
      expect(fs.readFileSync(path.join(target, "data", "servers", "vrising", "server.exe"), "utf8")).toBe("fake PE");
      expect(fs.existsSync(path.join(target, "data", "servers", "vrising", "world.db"))).toBe(true);
      expect(fs.existsSync(path.join(target, "data", "state.db"))).toBe(true);

      // New package files should be in place
      expect(fs.existsSync(path.join(target, "apps", "node-agent", "dist", "index.js"))).toBe(true);
      expect(fs.readFileSync(path.join(target, "package.json"), "utf8")).toContain("0.2.3");

      // Old files not in source should be gone
      expect(fs.existsSync(path.join(target, "old-package.json"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("apply-self-update.ps1", () => {
  it("detaches from the agent Job object and disables RestartCount before swapping", () => {
    const helper = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "deploy",
      "windows",
      "apply-self-update.ps1",
    );
    const src = fs.readFileSync(helper, "utf8");
    expect(src).toMatch(/\[switch\]\$Detached/);
    expect(src).toMatch(/Disable-ScheduledTask/);
    expect(src).toMatch(/PlayOnNodeAgentApplyUpdate/);
    expect(src).toMatch(/Register-ScheduledTask/);
    expect(src).toMatch(/CREATE_BREAKAWAY_FROM_JOB/);
    expect(src.indexOf("Disable-ScheduledTask")).toBeLessThan(src.indexOf("Waiting for node-agent"));
    expect(src.indexOf("Register-ScheduledTask")).toBeLessThan(src.indexOf("Waiting for node-agent"));
  });
});
