import { describe, expect, it } from "vitest";
import {
  enrichBlocksWithLiveStatus,
  extractLivePanelFields,
  liveStateToPanelBody,
  mergeLiveIntoStatusBody,
} from "./server-panel.js";

describe("liveStateToPanelBody", () => {
  it("maps online live fields for the panel", () => {
    expect(
      liveStateToPanelBody({
        online: true,
        players: 3,
        maxPlayers: 20,
        map: "world",
        mode: "survival",
        name: "LAN",
        playerList: [{ name: "alice", score: 1 }],
      }),
    ).toEqual({
      online: true,
      players: 3,
      maxPlayers: 20,
      map: "world",
      mode: "survival",
      serverName: "LAN",
      playerList: [{ name: "alice", score: 1 }],
    });
  });

  it("returns empty for offline", () => {
    expect(liveStateToPanelBody({ online: false, error: "timeout" })).toEqual({});
  });
});

describe("mergeLiveIntoStatusBody", () => {
  it("lets a fresh online query overwrite agent status body", () => {
    const merged = mergeLiveIntoStatusBody(
      { status: "running", players: 99, map: "stale" },
      { online: true, players: 2, maxPlayers: 20, map: "world" },
      { players: 1, map: "old" },
    );
    expect(merged.players).toBe(2);
    expect(merged.maxPlayers).toBe(20);
    expect(merged.map).toBe("world");
    expect(merged.status).toBe("running");
  });

  it("retains prior live fields when query is offline so agents cannot wipe them", () => {
    const merged = mergeLiveIntoStatusBody(
      { status: "running", game: "Paper" },
      { online: false, error: "timeout" },
      { online: true, players: 4, maxPlayers: 20, map: "world" },
    );
    expect(merged).toMatchObject({
      status: "running",
      game: "Paper",
      online: true,
      players: 4,
      maxPlayers: 20,
      map: "world",
    });
  });
});

describe("enrichBlocksWithLiveStatus", () => {
  it("injects server_status with live metrics when the agent omits it", () => {
    const blocks = enrichBlocksWithLiveStatus(
      [
        {
          type: "join_info",
          title: "Join",
          body: { address: "10.0.0.1", port: 25565 },
          sortOrder: 0,
        },
      ],
      {
        status: "running",
        runtime: "docker",
        game: "Minecraft",
        live: { online: true, players: 1, maxPlayers: 20 },
      },
    );
    const status = blocks.find((b) => b.type === "server_status");
    expect(status?.body.players).toBe(1);
    expect(status?.body.maxPlayers).toBe(20);
    expect(status?.body.status).toBe("running");
  });

  it("merges live into an agent-supplied bare server_status", () => {
    const blocks = enrichBlocksWithLiveStatus(
      [
        {
          type: "server_status",
          title: "Status",
          body: { status: "running" },
          sortOrder: 1,
        },
      ],
      {
        status: "running",
        runtime: "docker",
        live: { online: true, players: 3, map: "spawn" },
        previousStatusBody: { players: 9 },
      },
    );
    expect(blocks[0]?.body.players).toBe(3);
    expect(blocks[0]?.body.map).toBe("spawn");
  });
});

describe("extractLivePanelFields", () => {
  it("keeps only reserved live keys", () => {
    expect(
      extractLivePanelFields({
        status: "running",
        players: 2,
        map: "a",
        notes: "ignore",
      }),
    ).toEqual({ players: 2, map: "a" });
  });
});
