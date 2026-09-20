import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  chmodTreeWritableSync,
  isLockedFsError,
  rmTreeWithRetrySync,
} from "./rm-tree.js";

const temps: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    try {
      chmodTreeWritableSync(dir);
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("rmTreeWithRetrySync", () => {
  it("removes an ordinary tree", () => {
    const root = tempDir("playon-rm-ok-");
    fs.mkdirSync(path.join(root, "game"), { recursive: true });
    fs.writeFileSync(path.join(root, "game", "a.txt"), "x");
    rmTreeWithRetrySync(root);
    expect(fs.existsSync(root)).toBe(false);
  });

  it("recovers from mode-locked directories we own (#972)", () => {
    if (process.platform === "win32") return;

    const root = tempDir("playon-rm-mode-");
    const locked = path.join(root, "game", "save");
    fs.mkdirSync(locked, { recursive: true });
    fs.writeFileSync(path.join(locked, "world.sav"), "x");
    // Unlink needs write on the parent dir — strip it to reproduce EACCES.
    fs.chmodSync(locked, 0o555);

    expect(() => fs.rmSync(root, { recursive: true, force: true })).toThrow(/EACCES|EPERM/);

    rmTreeWithRetrySync(root);
    expect(fs.existsSync(root)).toBe(false);
  });

  it("uses docker force-remove when chmod cannot clear root-owned residue (#972)", () => {
    if (process.platform === "win32") return;

    const root = tempDir("playon-rm-docker-");
    const locked = path.join(root, "game", "nwsync");
    fs.mkdirSync(locked, { recursive: true });
    fs.writeFileSync(path.join(locked, "nwsyncmeta.sqlite3"), "x");
    fs.chmodSync(locked, 0o555);

    let dockerCalls = 0;
    rmTreeWithRetrySync(root, {
      chmodWritable: () => {
        /* pretend root-owned: chmod does nothing */
      },
      dockerAvailable: () => true,
      dockerForceRemove: (target) => {
        dockerCalls += 1;
        expect(target).toBe(root);
        chmodTreeWritableSync(target);
        fs.rmSync(target, { recursive: true, force: true });
      },
    });

    expect(dockerCalls).toBe(1);
    expect(fs.existsSync(root)).toBe(false);
  });

  it("rethrows when locked and docker is unavailable", () => {
    if (process.platform === "win32") return;

    const root = tempDir("playon-rm-stuck-");
    const locked = path.join(root, "game", "BackupSaves");
    fs.mkdirSync(locked, { recursive: true });
    fs.writeFileSync(path.join(locked, "a.bin"), "x");
    fs.chmodSync(locked, 0o555);

    expect(() =>
      rmTreeWithRetrySync(root, {
        chmodWritable: () => undefined,
        dockerAvailable: () => false,
      }),
    ).toThrow(/EACCES|EPERM/);
    expect(fs.existsSync(root)).toBe(true);

    chmodTreeWritableSync(root);
  });
});

describe("isLockedFsError", () => {
  it("detects EACCES / EPERM / EBUSY", () => {
    expect(isLockedFsError(Object.assign(new Error("x"), { code: "EACCES" }))).toBe(true);
    expect(isLockedFsError(Object.assign(new Error("x"), { code: "ENOENT" }))).toBe(false);
  });
});
