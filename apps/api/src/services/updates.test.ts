import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateManifest } from "@playon/shared";
import {
  clearUpdateManifestCacheForTests,
  downloadAndVerifyUpdate,
  extractUpdateArchive,
  pickAsset,
  resolveUpdateManifestUrl,
} from "./updates.js";

afterEach(() => {
  clearUpdateManifestCacheForTests();
  vi.unstubAllGlobals();
});

describe("resolveUpdateManifestUrl", () => {
  it("defaults to playon.games", () => {
    expect(resolveUpdateManifestUrl(null)).toContain("playon.games/home/latest.json");
  });
});

describe("pickAsset", () => {
  const manifest = {
    version: "0.1.5",
    channel: "stable",
    home: {
      "linux-x64": {
        downloadUrl:
          "https://github.com/gmcclelland90/playon/releases/download/v0.1.5/playon-home-0.1.5-linux-x64.tar.gz",
        sha256: "a".repeat(64),
      },
    },
    node: {},
  } satisfies UpdateManifest;

  it("returns platform asset", () => {
    const asset = pickAsset(manifest, "home", "linux-x64");
    expect(asset.sha256).toHaveLength(64);
  });

  it("rejects missing platform", () => {
    expect(() => pickAsset(manifest, "home", "windows-x64")).toThrow(/update_asset_missing/);
  });
});

describe("downloadAndVerifyUpdate", () => {
  it("writes file when sha matches", async () => {
    const body = Buffer.from("playon-update-bytes");
    const sha256 = crypto.createHash("sha256").update(body).digest("hex");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      })),
    );
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playon-upd-"));
    const dest = path.join(dir, "pkg.bin");
    try {
      const res = await downloadAndVerifyUpdate({
        downloadUrl: "https://playon.games/home/packages/pkg.bin",
        sha256,
        destFile: dest,
      });
      expect(res.sha256).toBe(sha256);
      expect(fs.readFileSync(dest).equals(body)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects sha mismatch", async () => {
    const body = Buffer.from("nope");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      })),
    );
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playon-upd-"));
    try {
      await expect(
        downloadAndVerifyUpdate({
          downloadUrl: "https://github.com/gmcclelland90/playon/releases/download/v1/x.tar.gz",
          sha256: "b".repeat(64),
          destFile: path.join(dir, "x.tar.gz"),
        }),
      ).rejects.toThrow(/update_sha256_mismatch/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("extractUpdateArchive", () => {
  it("finds playon root inside tar.gz", () => {
    if (process.platform === "win32") return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-tar-"));
    try {
      const stage = path.join(root, "stage");
      const playon = path.join(stage, "playon");
      fs.mkdirSync(playon, { recursive: true });
      fs.writeFileSync(path.join(playon, "package.json"), JSON.stringify({ name: "playon", version: "0.1.5" }));
      const archive = path.join(root, "pkg.tar.gz");
      execFileSync("tar", ["-czf", archive, "-C", stage, "playon"]);
      const dest = path.join(root, "out");
      const extracted = extractUpdateArchive(archive, dest);
      expect(fs.existsSync(path.join(extracted, "package.json"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
