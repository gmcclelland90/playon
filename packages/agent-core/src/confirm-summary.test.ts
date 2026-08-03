import { describe, expect, it } from "vitest";
import { confirmActionLabel, confirmSummary } from "./confirm-summary.js";

describe("confirmSummary", () => {
  it("uses friendly copy for known tools", () => {
    expect(confirmSummary("servers_stop", { serverId: "s1" })).toBe(
      "An agent wants to stop this server.",
    );
    expect(confirmSummary("servers_delete", {})).toBe(
      "An agent wants to permanently delete this server.",
    );
  });

  it("includes useful detail without dumping JSON", () => {
    expect(confirmSummary("fs_write", { serverId: "s1", path: "server.properties" })).toBe(
      "An agent wants to change a server file: server.properties",
    );
    expect(confirmSummary("fs_delete", { path: "plugins/Old" })).toBe(
      "An agent wants to delete a server file or folder: plugins/Old",
    );
    expect(confirmSummary("archive_extract", { archivePath: "mods.zip", destDir: "game" })).toBe(
      "An agent wants to extract an archive into the server folder: mods.zip → game",
    );
    expect(confirmSummary("fetch_url", { url: "https://example.com/m.jar", destPath: "game/m.jar" })).toBe(
      "An agent wants to download a file into the server folder: https://example.com/m.jar",
    );
    expect(confirmSummary("skill_promote", { slug: "minecraft-paper" })).toBe(
      "An agent wants to promote a draft skill so it can be installed: minecraft-paper",
    );
    expect(confirmSummary("skill_install_url", { name: "games.minecraft-paper" })).toBe(
      "An agent wants to install a skill from the public catalog: games.minecraft-paper",
    );
  });

  it("falls back for unknown tools", () => {
    expect(confirmSummary("custom_wipe", {})).toBe('An agent wants to run "custom wipe".');
  });
});

describe("confirmActionLabel", () => {
  it("returns the action phrase", () => {
    expect(confirmActionLabel("servers_restart")).toBe("restart this server");
  });
});
