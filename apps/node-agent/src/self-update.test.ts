import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { performNodeSelfUpdate, swapInstallTree } from "./self-update.js";

afterEach(() => {
  vi.unstubAllGlobals();
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
});
