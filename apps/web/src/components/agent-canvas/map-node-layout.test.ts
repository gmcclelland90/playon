import { describe, expect, it } from "vitest";
import {
  boardCrateKind,
  boardCrateStatusText,
  clusterPadSize,
  clusterServersByNode,
  crateOffsetInCluster,
  inventoryCrateId,
  isHeroCrate,
  isPlayerGameCrate,
  mergeNodeContainerInventory,
  OTHER_SERVICES_COLLAPSE_AT,
  otherServicesStackLabel,
  placeClusterCrates,
  sortNodesForMap,
} from "./map-node-layout";
import type { ServerRow } from "../../api";

describe("map-node-layout", () => {
  it("orders local before lan before cloud", () => {
    const sorted = sortNodesForMap([
      { id: "c1", name: "vps", kind: "cloud", status: "online" },
      { id: "r1", name: "zomboid", kind: "lan", status: "online" },
      { id: "local", name: "home", kind: "local", status: "online" },
    ]);
    expect(sorted.map((n) => n.id)).toEqual(["local", "r1", "c1"]);
  });

  it("keeps empty pending nodes as clusters", () => {
    const clusters = clusterServersByNode(
      [
        { id: "local", name: "home", kind: "local", status: "online", agentVersion: "0.1.7" },
        {
          id: "node-x",
          name: "zomboid",
          kind: "lan",
          status: "offline",
          agentVersion: "pending",
          joinHost: "172.16.0.109",
        },
      ],
      [],
    );
    expect(clusters).toHaveLength(2);
    expect(clusters.find((c) => c.node.id === "node-x")?.serverIds).toEqual([]);
    expect(clusters.find((c) => c.node.id === "node-x")?.node.joinHost).toBe("172.16.0.109");
  });

  it("groups servers under their nodeId", () => {
    const clusters = clusterServersByNode(
      [
        { id: "local", name: "home", kind: "local", status: "online" },
        { id: "spare", name: "spare", kind: "lan", status: "online" },
      ],
      [
        { id: "s1", nodeId: "spare" },
        { id: "s2", nodeId: "local" },
        { id: "s3", nodeId: "spare" },
      ],
    );
    const spare = clusters.find((c) => c.node.id === "spare")!;
    expect(spare.serverIds).toEqual(["s1", "s3"]);
    expect(crateOffsetInCluster(0).y).toBeLessThan(crateOffsetInCluster(2).y);
  });

  it("adds unmanaged Windows-engine containers that PlayOn did not create", () => {
    const servers: ServerRow[] = [
      {
        id: "abc",
        name: "lab-matrix-paper",
        game: "paper",
        nodeId: "playon-win-1-wsl",
        status: "running",
        runtimeMode: "docker",
        dataPath: "/data",
      },
    ];
    const merged = mergeNodeContainerInventory(servers, [
      {
        id: "playon-win-1",
        containers: [
          { name: "lab-sbox", image: "har0x/sbox-server:public", status: "running" },
        ],
      },
      {
        id: "playon-win-1-wsl",
        containers: [
          { name: "playon-abc", image: "itzg/minecraft-server", status: "running" },
          { name: "lab-matrix-paper", image: "itzg/minecraft-server", status: "running" },
        ],
      },
    ]);
    expect(merged.some((s) => s.id === "abc")).toBe(true);
    const sbox = merged.find((s) => s.name === "lab-sbox");
    expect(sbox).toMatchObject({
      id: inventoryCrateId("playon-win-1", "lab-sbox"),
      nodeId: "playon-win-1",
      unmanaged: true,
      status: "running",
    });
    expect(merged.filter((s) => s.nodeId === "playon-win-1-wsl")).toHaveLength(1);
  });
});

function row(partial: Partial<ServerRow> & Pick<ServerRow, "id" | "name">): ServerRow {
  return {
    game: "paper",
    nodeId: "playon-dev",
    status: "stopped",
    runtimeMode: "docker",
    dataPath: "/data",
    ...partial,
  };
}

describe("board crate hierarchy", () => {
  it("treats managed games as player crates and leftovers as inventory/lab", () => {
    expect(
      boardCrateKind(row({ id: "mc", name: "Small Minecraft", game: "paper", status: "running", ready: true })),
    ).toBe("player");
    expect(
      boardCrateKind(row({ id: "nzl", name: "NewZombieLand3", game: "zomboid", status: "running", ready: true })),
    ).toBe("player");
    expect(boardCrateKind(row({ id: "ext", name: "playon-ollama", unmanaged: true }))).toBe(
      "inventory",
    );
    expect(boardCrateKind(row({ id: "ex", name: "expedition-discord", game: "expedition" }))).toBe(
      "inventory",
    );
    expect(boardCrateKind(row({ id: "img", name: "helper", game: "ollama/ollama" }))).toBe(
      "inventory",
    );
    expect(boardCrateKind(row({ id: "lab", name: "lab-soak-teeworlds", game: "teeworlds" }))).toBe(
      "lab",
    );
  });

  it("only marks join-ready player games as hero tiles", () => {
    expect(
      isHeroCrate(row({ id: "mc", name: "Small Minecraft", status: "running", ready: true })),
    ).toBe(true);
    expect(
      isHeroCrate(row({ id: "mc", name: "Small Minecraft", status: "running", ready: false })),
    ).toBe(false);
    expect(
      isHeroCrate(row({ id: "nzl", name: "NewZombieLand3", game: "zomboid", status: "stopped" })),
    ).toBe(false);
    expect(isPlayerGameCrate(row({ id: "nzl", name: "NewZombieLand3", game: "zomboid" }))).toBe(
      true,
    );
    expect(
      isHeroCrate(row({ id: "o", name: "playon-ollama", unmanaged: true, status: "running" })),
    ).toBe(false);
  });

  it("does not label inventory as Not joinable", () => {
    expect(
      boardCrateStatusText(
        row({ id: "o", name: "playon-ollama", unmanaged: true, status: "running" }),
      ),
    ).toBe("On host");
    expect(
      boardCrateStatusText(
        row({ id: "o", name: "expedition-discord", unmanaged: true, status: "stopped" }),
      ),
    ).toBe("Host leftover");
    expect(
      boardCrateStatusText(
        row({
          id: "lab",
          name: "lab-soak-teeworlds",
          game: "teeworlds",
          status: "running",
          ready: false,
        }),
      ),
    ).toBe("Lab canary");
    expect(
      boardCrateStatusText(
        row({ id: "mc", name: "Small Minecraft", status: "running", ready: true }),
      ),
    ).toBe("Running");
  });

  it("collapses many side boxes next to one running game", () => {
    const hero = row({
      id: "mc",
      name: "Small Minecraft",
      status: "running",
      ready: true,
    });
    const others = [
      row({ id: "lab", name: "lab-soak-teeworlds", game: "teeworlds", status: "running" }),
      row({ id: "e1", name: "expedition-direct", unmanaged: true }),
      row({ id: "e2", name: "expedition-stdb-postgres", unmanaged: true }),
      row({ id: "e3", name: "expedition-discord", unmanaged: true }),
      row({ id: "e4", name: "expedition-spacetime", unmanaged: true }),
      row({ id: "e5", name: "expedition-openvidu", unmanaged: true }),
      row({ id: "o", name: "playon-ollama", unmanaged: true }),
    ];
    expect(others.length).toBeGreaterThanOrEqual(OTHER_SERVICES_COLLAPSE_AT);

    const collapsed = placeClusterCrates([hero, ...others]);
    expect(collapsed).toHaveLength(2);
    expect(collapsed[0]).toMatchObject({ serverId: "mc", role: "hero" });
    expect(collapsed[1]?.role).toBe("stack");
    expect(collapsed[1]?.stackCount).toBe(7);
    expect(collapsed[1]?.stackIds).toHaveLength(7);
    expect(otherServicesStackLabel(7)).toBe("7 other services");
    expect(collapsed[0]!.offset.x).not.toBe(collapsed[1]!.offset.x);

    const expanded = placeClusterCrates([hero, ...others], { othersExpanded: true });
    expect(expanded).toHaveLength(8);
    expect(expanded.filter((p) => p.role === "hero")).toHaveLength(1);
    expect(expanded.filter((p) => p.role === "other")).toHaveLength(7);
    expect(expanded.some((p) => p.serverId === "nzl")).toBe(false);

    const pad = clusterPadSize(collapsed);
    const crowded = clusterPadSize(
      [hero, ...others].map((s, i) => ({
        serverId: s.id,
        offset: crateOffsetInCluster(i),
        role: "player" as const,
        kind: "player" as const,
      })),
    );
    expect(pad.h).toBeLessThan(crowded.h);
  });

  it("keeps a stopped player game visible instead of folding it into the stack", () => {
    const nzl = row({
      id: "nzl",
      name: "NewZombieLand3",
      game: "zomboid",
      status: "stopped",
    });
    const leftovers = [
      row({ id: "e1", name: "expedition-discord", unmanaged: true }),
      row({ id: "e2", name: "expedition-spacetime", unmanaged: true }),
      row({ id: "e3", name: "playon-ollama", unmanaged: true }),
    ];
    const placed = placeClusterCrates([nzl, ...leftovers]);
    expect(placed.some((p) => p.serverId === "nzl" && p.role === "player")).toBe(true);
    expect(placed.some((p) => p.role === "stack" && p.stackCount === 3)).toBe(true);
  });
});
