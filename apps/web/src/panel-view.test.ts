import { describe, expect, it } from "vitest";
import type { PanelBlockRow } from "./api";
import { groupPanelByServer, pickJoinBlock } from "./panel-view";

function block(
  partial: Partial<PanelBlockRow> & Pick<PanelBlockRow, "id" | "type" | "title">,
): PanelBlockRow {
  return {
    serverId: null,
    body: {},
    sortOrder: 0,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("pickJoinBlock", () => {
  it("prefers join_info with an explicit port", () => {
    const picked = pickJoinBlock([
      block({
        id: "a",
        type: "join_info",
        title: "No port",
        body: { address: "1.1.1.1" },
        sortOrder: 9,
      }),
      block({
        id: "b",
        type: "join_info",
        title: "With port",
        body: { address: "1.1.1.1", port: 25565 },
        sortOrder: 1,
      }),
    ]);
    expect(picked?.id).toBe("b");
  });
});

describe("groupPanelByServer", () => {
  it("groups multiple servers and keeps per-server instructions", () => {
    const groups = groupPanelByServer([
      block({
        id: "j1",
        serverId: "srv-a",
        type: "join_info",
        title: "Join Paper",
        body: { address: "10.0.0.1", port: 25565, game: "Minecraft" },
        sortOrder: 0,
      }),
      block({
        id: "s1",
        serverId: "srv-a",
        type: "server_status",
        title: "Status",
        body: { status: "running" },
        sortOrder: 1,
      }),
      block({
        id: "g1",
        serverId: "srv-a",
        type: "guide",
        title: "Mods",
        body: { notes: "Install Fabric" },
        sortOrder: 3,
      }),
      block({
        id: "j2",
        serverId: "srv-b",
        type: "join_info",
        title: "Join Rust",
        body: { address: "10.0.0.1", port: 28015, game: "Rust" },
        sortOrder: 0,
      }),
      block({
        id: "c2",
        serverId: "srv-b",
        type: "client_setup",
        title: "How to connect",
        body: { notes: "Steam → F1 → client.connect …" },
        sortOrder: 2,
      }),
      block({
        id: "ann",
        serverId: null,
        type: "announcement",
        title: "House rules",
        body: { notes: "Be kind" },
        sortOrder: 0,
      }),
    ]);

    expect(groups).toHaveLength(3);
    const a = groups.find((g) => g.serverId === "srv-a");
    const b = groups.find((g) => g.serverId === "srv-b");
    const general = groups.find((g) => g.serverId === null);
    expect(a?.join?.title).toBe("Join Paper");
    expect(a?.rest.map((r) => r.type)).toEqual(["guide"]);
    expect(b?.rest.map((r) => r.type)).toEqual(["client_setup"]);
    expect(general?.rest.map((r) => r.id)).toEqual(["ann"]);
  });

  it("drops echo-only client_setup for that server's join", () => {
    const groups = groupPanelByServer([
      block({
        id: "j1",
        serverId: "srv-a",
        type: "join_info",
        title: "Join",
        body: { address: "10.0.0.1", port: 25565 },
      }),
      block({
        id: "echo",
        serverId: "srv-a",
        type: "client_setup",
        title: "How to connect",
        body: { notes: "10.0.0.1:25565" },
      }),
      block({
        id: "real",
        serverId: "srv-a",
        type: "client_setup",
        title: "Setup",
        body: { notes: "Install the mod pack first" },
      }),
    ]);
    expect(groups[0]?.rest.map((r) => r.id)).toEqual(["real"]);
  });
});
