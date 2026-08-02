import { describe, expect, it } from "vitest";
import type { SkillJoin } from "@playon/shared";
import {
  clientSetupNotes,
  defaultConnectCommand,
  defaultSteamConnectUrl,
  enrichJoinInfoBody,
  isPlayerPanelLiveStatus,
  preservedPanelBlocks,
  sanitizeSteamConnectUrl,
} from "./server-panel.js";

const rustJoin: SkillJoin = {
  connectCommand: "client.connect {{endpoint}}",
  steamClientAppId: 252490,
  steamUrlStyle: "run_connect",
  clientSetupNotes: [
    "1. Install/launch Rust from Steam (same branch as the host).",
    "2. From the main menu press F1 to open the console.",
    "3. Run: {{connectCommand}}",
  ].join("\n"),
};

const paperJoin: SkillJoin = {
  steamUrlStyle: "run_connect",
  clientSetupNotes:
    "Open Minecraft Java Edition → Multiplayer → Direct Connection → {{endpoint}}",
};

describe("defaultConnectCommand", () => {
  it("renders connectCommand from skill join metadata", () => {
    expect(
      defaultConnectCommand({
        join: rustJoin,
        address: "172.16.0.155",
        port: 28015,
      }),
    ).toBe("client.connect 172.16.0.155:28015");
  });

  it("omits command when skill has no connectCommand", () => {
    expect(
      defaultConnectCommand({
        join: paperJoin,
        address: "172.16.0.155",
        port: 25565,
      }),
    ).toBeUndefined();
  });
});

describe("defaultSteamConnectUrl", () => {
  it("builds steam://run deep link from join.steamClientAppId", () => {
    expect(
      defaultSteamConnectUrl({
        join: rustJoin,
        address: "172.16.0.155",
        port: 28015,
      }),
    ).toBe("steam://run/252490//+connect%20172.16.0.155:28015");
  });

  it("omits steam link when skill has no steamClientAppId", () => {
    expect(
      defaultSteamConnectUrl({
        join: paperJoin,
        address: "172.16.0.155",
        port: 25565,
      }),
    ).toBeUndefined();
  });
});

describe("sanitizeSteamConnectUrl", () => {
  it("accepts steam:// and rejects other schemes", () => {
    expect(sanitizeSteamConnectUrl("steam://connect/1.2.3.4:27015")).toBe(
      "steam://connect/1.2.3.4:27015",
    );
    expect(sanitizeSteamConnectUrl("https://evil.example")).toBeUndefined();
    expect(sanitizeSteamConnectUrl("javascript:alert(1)")).toBeUndefined();
  });
});

describe("enrichJoinInfoBody", () => {
  it("keeps agent connectCommand and steamConnectUrl over defaults", () => {
    const body = enrichJoinInfoBody({
      body: {
        connectCommand: "client.connect custom:28015",
        steamConnectUrl: "steam://connect/custom:28015",
      },
      address: "172.16.0.155",
      port: 28015,
      join: rustJoin,
      game: "Rust",
    });
    expect(body.connectCommand).toBe("client.connect custom:28015");
    expect(body.steamConnectUrl).toBe("steam://connect/custom:28015");
    expect(body.endpoint).toBe("172.16.0.155:28015");
  });

  it("fills join defaults when agent omits connect fields", () => {
    const body = enrichJoinInfoBody({
      body: {},
      address: "172.16.0.155",
      port: 28015,
      join: rustJoin,
      game: "Rust",
    });
    expect(body.connectCommand).toBe("client.connect 172.16.0.155:28015");
    expect(body.steamConnectUrl).toBe(
      "steam://run/252490//+connect%20172.16.0.155:28015",
    );
  });
});

describe("isPlayerPanelLiveStatus", () => {
  it("treats running and starting as live for the player panel", () => {
    expect(isPlayerPanelLiveStatus("running")).toBe(true);
    expect(isPlayerPanelLiveStatus("starting")).toBe(true);
    expect(isPlayerPanelLiveStatus("stopped")).toBe(false);
    expect(isPlayerPanelLiveStatus("error")).toBe(false);
    expect(isPlayerPanelLiveStatus(undefined)).toBe(false);
  });
});

describe("preservedPanelBlocks", () => {
  it("keeps guide/vote/announcement and drops auto join/status/setup", () => {
    const preserved = preservedPanelBlocks([
      { type: "join_info", title: "Join", body: { address: "1.2.3.4" } },
      { type: "server_status", title: "Status", body: { status: "running" } },
      { type: "client_setup", title: "How to connect", body: { notes: "go" } },
      {
        type: "guide",
        title: "Mod pack",
        body: { steps: ["Install X", "Launch Y"] },
      },
      { type: "vote", title: "Map", body: { options: ["A", "B"] } },
      { type: "announcement", title: "Note", body: { notes: "Be nice" } },
    ]);
    expect(preserved.map((b) => b.type)).toEqual(["guide", "vote", "announcement"]);
    expect(preserved[0]?.title).toBe("Mod pack");
    expect(preserved[0]?.sortOrder).toBe(10);
  });
});

describe("clientSetupNotes", () => {
  it("renders skill join.clientSetupNotes with templates", () => {
    const notes = clientSetupNotes({
      join: rustJoin,
      address: "172.16.0.155",
      port: 28015,
    });
    expect(notes).toContain("client.connect 172.16.0.155:28015");
    expect(notes).toMatch(/Steam/i);
    expect(notes).not.toMatch(/Minecraft/i);
  });

  it("renders Minecraft-style notes from skill join", () => {
    const notes = clientSetupNotes({
      join: paperJoin,
      address: "172.16.0.155",
      port: 25565,
    });
    expect(notes).toMatch(/Minecraft/i);
    expect(notes).toContain("25565");
  });
});
