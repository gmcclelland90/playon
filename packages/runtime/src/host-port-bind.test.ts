import dgram from "node:dgram";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  HostPortInUseError,
  assertHostPortsFree,
  formatHostPortInUseError,
  holdersFromContainers,
  holdersFromListenTable,
  hostPortsFromDockerInspect,
  hostPortsFromSpec,
  parseDockerHostPortBindError,
  rewriteDockerPortBindError,
  tryExclusiveBind,
} from "./host-port-bind.js";

const DOCKER_500 =
  "(HTTP code 500) server error - failed to set up container networking: driver failed programming external connectivity on endpoint playon-2Fr8UE-I9730HS_kmkyx9 (abc): failed to bind host port 0.0.0.0:27015/tcp: address already in use";

const SS_SAMPLE = `
tcp   LISTEN 0      4096       0.0.0.0:27015      0.0.0.0:*    users:(("srcds_linux",pid=4421,fd=12))
udp   UNCONN 0      0          0.0.0.0:27015      0.0.0.0:*    users:(("srcds_linux",pid=4421,fd=13))
tcp   LISTEN 0      128        0.0.0.0:22         0.0.0.0:*    users:(("sshd",pid=1,fd=3))
`;

const leftoverSockets: Array<net.Server | dgram.Socket> = [];

afterEach(async () => {
  await Promise.all(
    leftoverSockets.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          try {
            s.close(() => resolve());
          } catch {
            resolve();
          }
        }),
    ),
  );
});

describe("parseDockerHostPortBindError", () => {
  it("reads the Docker 500 bind-address-in-use tail from #941 / #942", () => {
    expect(parseDockerHostPortBindError(new Error(DOCKER_500))).toEqual({
      host: 27015,
      protocol: "tcp",
    });
  });

  it("ignores unrelated docker errors", () => {
    expect(parseDockerHostPortBindError(new Error("no such container"))).toBeNull();
  });
});

describe("formatHostPortInUseError", () => {
  it("names the holder instead of an opaque Docker 500", () => {
    expect(
      formatHostPortInUseError(27015, "tcp", [
        { kind: "container", detail: "container playon-abc image=cm2network/cs2" },
      ]),
    ).toBe("host_port_in_use: 27015/tcp held by container playon-abc image=cm2network/cs2");
  });

  it("says holder unknown when nothing is listed", () => {
    expect(formatHostPortInUseError(27015, "udp", [])).toMatch(/holder unknown/);
  });
});

describe("hostPortsFromDockerInspect / spec", () => {
  it("reads HostConfig.PortBindings", () => {
    expect(
      hostPortsFromDockerInspect({
        HostConfig: {
          PortBindings: {
            "27015/tcp": [{ HostPort: "27015" }],
            "34197/udp": [{ HostPort: "34197" }],
          },
        },
      }),
    ).toEqual([
      { host: 27015, protocol: "tcp" },
      { host: 34197, protocol: "udp" },
    ]);
  });

  it("defaults missing spec protocol to tcp", () => {
    expect(hostPortsFromSpec([{ host: 25565 }, { host: 34197, protocol: "udp" }])).toEqual([
      { host: 25565, protocol: "tcp" },
      { host: 34197, protocol: "udp" },
    ]);
  });
});

describe("holdersFromListenTable / containers", () => {
  it("parses ss process listeners", () => {
    expect(holdersFromListenTable(SS_SAMPLE, 27015, "tcp")).toEqual([
      { kind: "process", detail: "process srcds_linux pid=4421" },
    ]);
    expect(holdersFromListenTable(SS_SAMPLE, 27015, "udp")).toEqual([
      { kind: "process", detail: "process srcds_linux pid=4421" },
    ]);
    expect(holdersFromListenTable(SS_SAMPLE, 22, "tcp")).toHaveLength(1);
  });

  it("names docker leftovers that published the host port", () => {
    expect(
      holdersFromContainers(
        [
          {
            name: "playon-old",
            image: "cm2network/cs2",
            status: "running",
            ports: [{ host: 27015, container: 27015, protocol: "tcp" }],
          },
        ],
        27015,
        "tcp",
      ),
    ).toEqual([{ kind: "container", detail: "container playon-old image=cm2network/cs2" }]);
  });
});

describe("tryExclusiveBind / assertHostPortsFree", () => {
  it("claims a free TCP port and releases it", async () => {
    const probe = net.createServer();
    const port = await new Promise<number>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "0.0.0.0", () => {
        const addr = probe.address();
        if (!addr || typeof addr === "string") reject(new Error("no addr"));
        else resolve(addr.port);
      });
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    expect(await tryExclusiveBind(port, "tcp")).toBe(true);
  });

  it("fails exclusive bind when something already listens", async () => {
    const server = net.createServer();
    leftoverSockets.push(server);
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "0.0.0.0", () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") reject(new Error("no addr"));
        else resolve(addr.port);
      });
    });
    expect(await tryExclusiveBind(port, "tcp")).toBe(false);
    await expect(
      assertHostPortsFree([{ host: port, protocol: "tcp" }], {
        listenTable: () => `tcp LISTEN 0 128 0.0.0.0:${port} 0.0.0.0:* users:(("node",pid=9,fd=1))`,
      }),
    ).rejects.toThrow(HostPortInUseError);
  });
});

describe("rewriteDockerPortBindError", () => {
  it("turns a Docker 500 into host_port_in_use with the holder", async () => {
    await expect(
      rewriteDockerPortBindError(new Error(DOCKER_500), {
        listContainers: async () => [
          {
            name: "playon-leftover",
            image: "factoriotools/factorio",
            status: "running",
            ports: [{ host: 27015, container: 27015, protocol: "tcp" }],
          },
        ],
      }),
    ).rejects.toThrow(/host_port_in_use: 27015\/tcp held by container playon-leftover/);
  });

  it("rethrows unrelated errors", async () => {
    await expect(rewriteDockerPortBindError(new Error("no such container"))).rejects.toThrow(
      "no such container",
    );
  });
});
