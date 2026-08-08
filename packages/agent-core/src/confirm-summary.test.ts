import { describe, expect, it } from "vitest";
import { confirmActionLabel, confirmSummary } from "./confirm-summary.js";

describe("confirmSummary", () => {
  it("uses friendly copy for tools still in the overlay table", () => {
    expect(confirmSummary("steamcmd_app_update", { serverId: "s1", appId: 258550 })).toBe(
      "An agent wants to download or update game files via Steam: app 258550",
    );
    // Migrated tools are gone from the overlay, so callers must pass their action.
    expect(confirmSummary("snapshot_restore", { snapshotId: "s1" })).toBe(
      'An agent wants to run "snapshot restore".',
    );
  });

  it("prefers the action from the tool's own surface metadata", () => {
    expect(
      confirmSummary(
        "fs_write",
        { serverId: "s1", path: "server.properties" },
        { action: "change a server file" },
      ),
    ).toBe("An agent wants to change a server file: server.properties");
    expect(
      confirmSummary(
        "fs_delete",
        { path: "plugins/Old" },
        { action: "delete a server file or folder" },
      ),
    ).toBe("An agent wants to delete a server file or folder: plugins/Old");
    expect(
      confirmSummary("servers_stop", { serverId: "s1" }, { action: "stop this server" }),
    ).toBe("An agent wants to stop this server.");
    expect(
      confirmSummary(
        "servers_relocate",
        { serverId: "s1", targetNodeId: "node-2" },
        { action: "move this server to another machine" },
      ),
    ).toBe("An agent wants to move this server to another machine: to node-2");
  });

  it("includes useful detail without dumping JSON", () => {
    expect(confirmSummary("archive_extract", { archivePath: "mods.zip", destDir: "game" })).toBe(
      "An agent wants to extract an archive into the server folder: mods.zip → game",
    );
    expect(confirmSummary("fetch_url", { url: "https://example.com/m.jar", destPath: "game/m.jar" })).toBe(
      "An agent wants to download a file into the server folder: https://example.com/m.jar",
    );
    expect(
      confirmSummary(
        "skill_promote",
        { slug: "minecraft-paper" },
        { action: "promote a draft skill so it can be installed" },
      ),
    ).toBe("An agent wants to promote a draft skill so it can be installed: minecraft-paper");
    expect(
      confirmSummary(
        "skill_install_url",
        { name: "games.minecraft-paper" },
        { action: "install a skill from the public catalog" },
      ),
    ).toBe("An agent wants to install a skill from the public catalog: games.minecraft-paper");
  });

  it("falls back for unknown tools", () => {
    expect(confirmSummary("custom_wipe", {})).toBe('An agent wants to run "custom wipe".');
  });
});

describe("confirmActionLabel", () => {
  it("returns the action phrase", () => {
    expect(confirmActionLabel("archive_extract")).toBe(
      "extract an archive into the server folder",
    );
    expect(confirmActionLabel("servers_restart", "restart this server")).toBe(
      "restart this server",
    );
    expect(confirmActionLabel("snapshot_restore", "restore this server from a snapshot")).toBe(
      "restore this server from a snapshot",
    );
  });
});
