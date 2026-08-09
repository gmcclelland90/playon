import { describe, expect, it } from "vitest";
import { mergePanelBlocksForUpsert } from "./player-panel.js";

describe("mergePanelBlocksForUpsert", () => {
  const existing = [
    {
      id: "b1",
      type: "join_info",
      title: "Join",
      body: { address: "10.0.0.1", port: 25565 },
      sortOrder: 0,
    },
    {
      id: "b2",
      type: "guide",
      title: "How to play",
      body: { summary: "old" },
      sortOrder: 2,
    },
    {
      id: "b3",
      type: "announcement",
      title: "News",
      body: { level: "info" },
      sortOrder: 3,
    },
  ];

  it("replaces by id and keeps unmatched blocks", () => {
    const merged = mergePanelBlocksForUpsert(existing, [
      {
        id: "b2",
        type: "guide",
        title: "Updated guide",
        body: { summary: "new", steps: ["One"] },
      },
    ]);
    expect(merged).toHaveLength(3);
    expect(merged.find((b) => b.type === "join_info")?.body).toEqual({
      address: "10.0.0.1",
      port: 25565,
    });
    expect(merged.find((b) => b.type === "guide")).toMatchObject({
      title: "Updated guide",
      body: { summary: "new", steps: ["One"] },
      sortOrder: 2,
    });
    expect(merged.find((b) => b.type === "announcement")?.title).toBe("News");
  });

  it("replaces by type when id is omitted", () => {
    const merged = mergePanelBlocksForUpsert(existing, [
      {
        type: "announcement",
        title: "LAN tonight",
        body: { level: "fun", summary: "Bring snacks" },
        sortOrder: 5,
      },
    ]);
    const announcement = merged.find((b) => b.type === "announcement");
    expect(announcement).toMatchObject({
      title: "LAN tonight",
      body: { level: "fun", summary: "Bring snacks" },
      sortOrder: 5,
    });
    expect(merged).toHaveLength(3);
  });

  it("appends when neither id nor type matches", () => {
    const merged = mergePanelBlocksForUpsert(existing, [
      {
        type: "vote",
        title: "Map vote",
        body: { options: ["A", "B"] },
      },
    ]);
    expect(merged).toHaveLength(4);
    expect(merged.find((b) => b.type === "vote")).toMatchObject({
      title: "Map vote",
      body: { options: ["A", "B"] },
    });
  });
});
