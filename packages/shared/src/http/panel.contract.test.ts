import { describe, expect, it } from "vitest";
import { PanelInputRequestSchema } from "./panel.js";

describe("panel input request contract", () => {
  it("defaults the payload and keeps the block reference optional", () => {
    expect(PanelInputRequestSchema.parse({ type: "readiness" })).toEqual({
      type: "readiness",
      payload: {},
    });
    expect(PanelInputRequestSchema.parse({ type: "vote", blockId: "blk-1" }).blockId).toBe("blk-1");
  });

  it("rejects an unknown input type", () => {
    expect(PanelInputRequestSchema.safeParse({ type: "kick" }).success).toBe(false);
    expect(PanelInputRequestSchema.safeParse({}).success).toBe(false);
  });
});
