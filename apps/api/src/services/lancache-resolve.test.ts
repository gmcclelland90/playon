import { describe, expect, it } from "vitest";
import { resolveCacheIpForNode } from "./lancache.js";

describe("resolveCacheIpForNode", () => {
  it("prefers joinHost then overlay then advertise", () => {
    expect(
      resolveCacheIpForNode(
        { joinHost: "10.0.0.2:22", overlayIp: "10.77.0.2" },
        "192.168.1.1",
      ),
    ).toBe("10.0.0.2");
    expect(resolveCacheIpForNode({ overlayIp: "10.77.0.3" }, "192.168.1.1")).toBe("10.77.0.3");
    expect(resolveCacheIpForNode({}, "192.168.1.1")).toBe("192.168.1.1");
  });
});
