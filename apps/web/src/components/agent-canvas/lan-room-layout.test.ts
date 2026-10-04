import { describe, expect, it } from "vitest";
import type { PanelBlockRow } from "../../api";
import { MAX_SEATS, serverPlayersFromPanel, stationSeats, switchSpot } from "./lan-room-layout";

function block(serverId: string | null, type: string, body: Record<string, unknown>): PanelBlockRow {
  return { id: `${type}-${serverId}`, serverId, type, title: "", body, sortOrder: 0, updatedAt: "" };
}

describe("serverPlayersFromPanel", () => {
  it("reads counts, caps and names from server_status blocks", () => {
    const players = serverPlayersFromPanel([
      block("s1", "server_status", { players: 2, maxPlayers: "16", playerList: ["Moxie", { name: "Rook" }] }),
      block("s1", "join_info", { address: "10.0.0.2" }),
      block(null, "server_status", { players: 4 }),
    ]);
    expect(players).toEqual({ s1: { count: 2, max: 16, names: ["Moxie", "Rook"] } });
  });

  it("falls back to the list length and skips blocks with no count", () => {
    expect(
      serverPlayersFromPanel([
        block("s2", "server_status", { playerList: ["Ash", ""] }),
        block("s3", "server_status", { status: "running" }),
      ]),
    ).toEqual({ s2: { count: 1, names: ["Ash"] } });
  });
});

describe("stationSeats", () => {
  it("gives one seat per player with their initial", () => {
    expect(stationSeats({ count: 2, names: ["moxie", "Rook"] }).map((s) => s.label)).toEqual(["M", "R"]);
  });

  it("draws unnamed seats when only a count is known", () => {
    expect(stationSeats({ count: 3, names: [] }).map((s) => s.label)).toEqual(["", "", ""]);
  });

  it("folds a full house into a +N seat", () => {
    const seats = stationSeats({ count: 20, names: [] });
    expect(seats).toHaveLength(MAX_SEATS);
    expect(seats.at(-1)).toMatchObject({ label: "+13", overflow: true });
  });

  it("is empty when nobody is on", () => {
    expect(stationSeats(undefined)).toEqual([]);
    expect(stationSeats({ count: 0, names: [] })).toEqual([]);
  });
});

describe("switchSpot", () => {
  const table = (x: number, y: number) => ({ x, y, w: 300, h: 200 });

  it("needs two tables", () => {
    expect(switchSpot([table(0, 0)], 56)).toBeNull();
  });

  it("sits in the gap between two rows of tables", () => {
    expect(switchSpot([table(0, 0), table(400, 0), table(200, 300)], 56)).toEqual({
      x: 350,
      y: 200,
    });
  });

  it("drops below a single row when the middle is a table", () => {
    expect(switchSpot([table(0, 0), table(320, 0), table(640, 0)], 56)).toEqual({ x: 470, y: 252 });
  });
});
