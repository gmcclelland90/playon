import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertSteamAppInstallComplete,
  clearStagedSteamDownload,
  isRetryableSteamcmdFailure,
} from "./steamcmd.js";

function writeManifest(installDir: string, appId: number, body: string): void {
  const dir = path.join(installDir, "steamapps");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `appmanifest_${appId}.acf`), body, "utf8");
}

describe("assertSteamAppInstallComplete", () => {
  it("allows installs with SizeOnDisk set", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-steam-complete-"));
    writeManifest(
      root,
      376030,
      `"AppState"\n{\n\t"appid"\t\t"376030"\n\t"SizeOnDisk"\t\t"22938933947"\n\t"InstalledDepots"\n\t{\n\t}\n}\n`,
    );
    expect(() => assertSteamAppInstallComplete(root, 376030)).not.toThrow();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("allows installs with InstalledDepots entries", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-steam-complete-"));
    writeManifest(
      root,
      376030,
      `"AppState"\n{\n\t"appid"\t\t"376030"\n\t"SizeOnDisk"\t\t"0"\n\t"InstalledDepots"\n\t{\n\t\t"376031"\n\t\t{\n\t\t\t"manifest"\t\t"1"\n\t\t}\n\t}\n}\n`,
    );
    expect(() => assertSteamAppInstallComplete(root, 376030)).not.toThrow();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rejects EmptySteamDepot / size-0 depot manifests", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-steam-complete-"));
    writeManifest(
      root,
      1180760,
      `"AppState"\n{\n\t"appid"\t\t"1180760"\n\t"SizeOnDisk"\t\t"0"\n\t"InstalledDepots"\n\t{\n\t\t"1180761"\n\t\t{\n\t\t\t"manifest"\t\t"1"\n\t\t\t"size"\t\t"0"\n\t\t}\n\t}\n}\n`,
    );
    fs.mkdirSync(path.join(root, "EmptySteamDepot"), { recursive: true });
    expect(() => assertSteamAppInstallComplete(root, 1180760)).toThrow(/steamcmd_empty_depot/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rejects staged-only manifests", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-steam-complete-"));
    writeManifest(
      root,
      376030,
      `"AppState"\n{\n\t"appid"\t\t"376030"\n\t"StateFlags"\t\t"1026"\n\t"SizeOnDisk"\t\t"0"\n\t"InstalledDepots"\n\t{\n\t}\n}\n`,
    );
    fs.mkdirSync(path.join(root, "steamapps", "downloading", "376030"), { recursive: true });
    expect(() => assertSteamAppInstallComplete(root, 376030)).toThrow(/steamcmd_incomplete_install/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("classifies empty anonymous success as no_subscription", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-steam-complete-"));
    writeManifest(
      root,
      211820,
      `"AppState"\n{\n\t"appid"\t\t"211820"\n\t"StateFlags"\t\t"4"\n\t"SizeOnDisk"\t\t"0"\n\t"BytesToDownload"\t\t"0"\n\t"InstalledDepots"\n\t{\n\t}\n}\n`,
    );
    expect(() => assertSteamAppInstallComplete(root, 211820)).toThrow(/steamcmd_no_subscription/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("no-ops when the manifest is absent", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-steam-complete-"));
    expect(() => assertSteamAppInstallComplete(root, 376030)).not.toThrow();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("steamcmd 0x602 retry helpers", () => {
  it("detects App state 0x602 tails", () => {
    expect(
      isRetryableSteamcmdFailure(
        "Update state (0x81) verifying update\nError! App '376030' state is 0x602 after update job.",
      ),
    ).toBe(true);
    expect(isRetryableSteamcmdFailure("No subscription")).toBe(false);
    expect(isRetryableSteamcmdFailure("Invalid platform")).toBe(false);
  });

  it("clears only the staged downloading/<appId> tree", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-steam-clear-"));
    const staged = path.join(root, "steamapps", "downloading", "376030");
    const other = path.join(root, "steamapps", "downloading", "740");
    fs.mkdirSync(staged, { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(staged, "chunk"), "x");
    clearStagedSteamDownload(root, 376030);
    expect(fs.existsSync(staged)).toBe(false);
    expect(fs.existsSync(other)).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
