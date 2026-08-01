import { describe, expect, it } from "vitest";
import { normalizePanelBlockType } from "./tools.js";

describe("normalizePanelBlockType", () => {
  it("maps common aliases", () => {
    expect(normalizePanelBlockType("status")).toBe("server_status");
    expect(normalizePanelBlockType("Join")).toBe("join_info");
    expect(normalizePanelBlockType("client-setup")).toBe("client_setup");
  });

  it("passes through canonical types", () => {
    expect(normalizePanelBlockType("server_status")).toBe("server_status");
    expect(normalizePanelBlockType("announcement")).toBe("announcement");
  });
});
