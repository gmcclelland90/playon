import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { openServerFileStore } from "./server-file-store.js";
import { scaffoldModWorkspace } from "./mods-workspace.js";
import { ModsWorkshopError, preparePzWorkshopDryRun } from "./mods-workshop.js";

const tmpRoots: string[] = [];

afterEach(() => {
  while (tmpRoots.length) {
    const root = tmpRoots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

function tempJail() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-workshop-"));
  tmpRoots.push(root);
  const dataPath = path.join(root, "data");
  fs.mkdirSync(dataPath, { recursive: true });
  const files = openServerFileStore({ id: "srv", nodeId: "local", dataPath });
  return { dataPath, files };
}

describe("preparePzWorkshopDryRun", () => {
  it("stages a PZ workshop zip under workshop-out/ without uploading", async () => {
    const { dataPath, files } = tempJail();
    await scaffoldModWorkspace({
      files,
      modId: "Locker",
      dialect: "project-zomboid",
      displayName: "Locker Mod",
    });

    const result = await preparePzWorkshopDryRun({ files, modId: "Locker" });
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.preview.zipPath).toBe("workshop-out/Locker/Locker-workshop.zip");
    expect(result.preview.previewPath).toBe("workshop-out/Locker/workshop-preview.json");
    expect(result.preview.livePublish).toBe(false);
    expect(result.preview.entries).toContain("mods/Locker/mod.info");
    expect(result.preview.entries.some((e) => e.includes("playon-mod.json"))).toBe(false);

    const zipAbs = path.join(dataPath, "workshop-out", "Locker", "Locker-workshop.zip");
    expect(fs.existsSync(zipAbs)).toBe(true);
    const unzipped = unzipSync(new Uint8Array(fs.readFileSync(zipAbs)));
    expect(Object.keys(unzipped)).toContain("mods/Locker/mod.info");
    expect(Object.keys(unzipped).some((k) => k.includes("playon-mod.json"))).toBe(false);

    const preview = JSON.parse(
      fs.readFileSync(path.join(dataPath, "workshop-out", "Locker", "workshop-preview.json"), "utf8"),
    );
    expect(preview.title).toBe("Locker Mod");
  });

  it("returns blocked_human when livePublish is requested", async () => {
    const { files } = tempJail();
    await scaffoldModWorkspace({
      files,
      modId: "Locker",
      dialect: "project-zomboid",
    });

    const result = await preparePzWorkshopDryRun({
      files,
      modId: "Locker",
      livePublish: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected blocked live publish");
    expect(result.dryRun).toBe(true);
    expect(result.blockedHuman.error).toBe("blocked_human");
    expect(result.blockedHuman.code).toBe("steam_credentials_human_gate");
    expect(result.preview.zipPath).toBe("workshop-out/Locker/Locker-workshop.zip");
  });

  it("rejects non-PZ dialects", async () => {
    const { files } = tempJail();
    await scaffoldModWorkspace({
      files,
      modId: "PaperThing",
      dialect: "minecraft-paper",
    });
    await expect(preparePzWorkshopDryRun({ files, modId: "PaperThing" })).rejects.toMatchObject({
      code: "unsupported_dialect",
    });
  });

  it("rejects missing workspace", async () => {
    const { files } = tempJail();
    await expect(preparePzWorkshopDryRun({ files, modId: "Nope" })).rejects.toBeInstanceOf(
      ModsWorkshopError,
    );
  });
});
