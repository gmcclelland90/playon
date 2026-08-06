import { describe, expect, it } from "vitest";
import { clusterServersByNode, crateOffsetInCluster, sortNodesForMap } from "./map-node-layout";

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
});
