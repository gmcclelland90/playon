import { describe, expect, it } from "vitest";
import { dnsRunArgs, monolithicRunArgs, LANCACHE_CONTAINER, LANCACHE_IMAGE } from "./lancache-docker.js";

describe("lancache-docker args", () => {
  it("builds monolithic run args with data bind and ports", () => {
    const args = monolithicRunArgs("/var/lib/playon/lancache");
    expect(args).toContain(LANCACHE_CONTAINER);
    expect(args).toContain(LANCACHE_IMAGE);
    expect(args).toContain("80:80");
    expect(args).toContain("443:443");
    expect(args).toContain("/var/lib/playon/lancache:/data/cache");
    expect(args).toContain("unless-stopped");
  });

  it("builds dns run args with LANCACHE_IP", () => {
    const args = dnsRunArgs("10.0.0.5");
    expect(args).toContain("LANCACHE_IP=10.0.0.5");
    expect(args).toContain("53:53/udp");
  });
});
