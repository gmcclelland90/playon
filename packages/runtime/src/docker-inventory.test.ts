import { describe, expect, it } from "vitest";
import { listHostContainers, mapDockerListContainer } from "./docker-inventory.js";

describe("mapDockerListContainer", () => {
  it("maps a Windows-engine sbox row without inventing a PlayOn name", () => {
    expect(
      mapDockerListContainer({
        Names: ["/lab-sbox"],
        Image: "har0x/sbox-server:public",
        State: "running",
        Ports: [
          { PrivatePort: 27150, PublicPort: 27150, Type: "tcp" },
          { PrivatePort: 27150, PublicPort: 27150, Type: "udp" },
          { PrivatePort: 27016, PublicPort: 27016, Type: "udp" },
        ],
      }),
    ).toEqual({
      name: "lab-sbox",
      image: "har0x/sbox-server:public",
      status: "running",
      ports: [
        { container: 27150, host: 27150, protocol: "tcp" },
        { container: 27150, host: 27150, protocol: "udp" },
        { container: 27016, host: 27016, protocol: "udp" },
      ],
    });
  });

  it("drops nameless rows", () => {
    expect(mapDockerListContainer({ Names: [], Image: "x", State: "running" })).toBeNull();
    expect(mapDockerListContainer(null)).toBeNull();
  });
});

describe("listHostContainers", () => {
  it("is read-only: returns mapped rows and never throws", async () => {
    await expect(
      listHostContainers({
        list: async () => [
          { Names: ["/lab-sbox"], Image: "har0x/sbox-server:public", State: "running" },
          { Names: ["/lab-matrix-paper"], Image: "itzg/minecraft-server", State: "running" },
        ],
      }),
    ).resolves.toEqual([
      {
        name: "lab-sbox",
        image: "har0x/sbox-server:public",
        status: "running",
        ports: [],
      },
      {
        name: "lab-matrix-paper",
        image: "itzg/minecraft-server",
        status: "running",
        ports: [],
      },
    ]);
    await expect(
      listHostContainers({
        list: async () => {
          throw new Error("connect ENOENT");
        },
      }),
    ).resolves.toEqual([]);
  });
});
