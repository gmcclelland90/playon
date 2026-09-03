import { describe, expect, it } from "vitest";
import {
  isIsolatedLabMatrixRoot,
  isProtectedPlayonContainer,
  leftoverPlayonContainers,
  protectNamesFromServerIds,
} from "./leftover-port-holders.js";

const leftover = {
  name: "playon-2Fr8UE-I9730HS_kmkyx9",
  image: "cm2network/cs2",
  status: "running",
  ports: [{ host: 27015, container: 27015, protocol: "tcp" as const }],
};

const factorio = {
  name: "playon-JMsW1ek7YQZ1OP6I58eMV",
  image: "factoriotools/factorio",
  status: "running",
  ports: [
    { host: 34197, container: 34197, protocol: "udp" as const },
    { host: 27015, container: 27015, protocol: "tcp" as const },
  ],
};

const homeCs2 = {
  name: "playon-homeCs2Live",
  image: "cm2network/cs2",
  status: "running",
  ports: [{ host: 27015, container: 27015, protocol: "tcp" as const }],
};

const ollama = {
  name: "playon-ollama",
  image: "ollama/ollama",
  status: "running",
  ports: [{ host: 11434, container: 11434, protocol: "tcp" as const }],
};

const friend = {
  name: "playon-NewZombieLand3",
  image: "unrelated",
  status: "running",
  ports: [{ host: 16261, container: 16261, protocol: "udp" as const }],
};

describe("isIsolatedLabMatrixRoot", () => {
  it("recognizes matrix temp data roots", () => {
    expect(isIsolatedLabMatrixRoot("/tmp/playon-lab-matrix-ab12/")).toBe(true);
    expect(isIsolatedLabMatrixRoot("/home/playon/src/playon/apps/api/data")).toBe(false);
    expect(isIsolatedLabMatrixRoot("/tmp/playon-runtime-handle-xyz")).toBe(false);
  });
});

describe("isProtectedPlayonContainer", () => {
  it("never reaps non-playon, ollama, or NZL-shaped names", () => {
    expect(isProtectedPlayonContainer("lab-sbox")).toBe(true);
    expect(isProtectedPlayonContainer("playon-ollama")).toBe(true);
    expect(isProtectedPlayonContainer("playon-NewZombieLand3")).toBe(true);
    expect(isProtectedPlayonContainer("playon-abc", [])).toBe(false);
    expect(isProtectedPlayonContainer("playon-abc", ["playon-abc"])).toBe(true);
  });
});

describe("leftoverPlayonContainers", () => {
  it("reaps unlabeled matrix leftovers when Home protect list loaded", () => {
    const protect = protectNamesFromServerIds(["homeCs2Live"]);
    const reap = leftoverPlayonContainers([leftover, factorio, homeCs2, ollama, friend], {
      protectNames: protect,
      protectListLoaded: true,
      ports: [{ host: 27015, protocol: "tcp" }],
    });
    expect(reap.map((c) => c.name).sort()).toEqual([leftover.name, factorio.name].sort());
  });

  it("does not guess when Home inventory is unavailable", () => {
    expect(
      leftoverPlayonContainers([leftover, homeCs2], {
        protectListLoaded: false,
        ports: [{ host: 27015, protocol: "tcp" }],
      }),
    ).toEqual([]);
  });

  it("still reaps known stale-matrix names when Home is down", () => {
    expect(
      leftoverPlayonContainers([leftover, homeCs2], {
        protectListLoaded: false,
        knownLeftoverNames: [leftover.name],
        ports: [{ host: 27015, protocol: "tcp" }],
      }).map((c) => c.name),
    ).toEqual([leftover.name]);
  });

  it("does not treat Factorio game 34197 as a 27015 leftover when filtering ports", () => {
    const onlyGame = {
      ...factorio,
      ports: [{ host: 34197, container: 34197, protocol: "udp" as const }],
    };
    expect(
      leftoverPlayonContainers([onlyGame], {
        protectListLoaded: true,
        ports: [{ host: 27015, protocol: "tcp" }],
      }),
    ).toEqual([]);
  });
});
