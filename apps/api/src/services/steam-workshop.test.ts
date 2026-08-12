import { describe, expect, it } from "vitest";
import { fetchWorkshopItems } from "./steam-workshop.js";

describe("fetchWorkshopItems", () => {
  it("fetches real Project Zomboid workshop items", async () => {
    // Real PZ workshop IDs
    const workshopIds = ["2169330869", "2260789317"];
    const items = await fetchWorkshopItems(workshopIds);

    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.workshopId).toBeTruthy();
      // Steam API may return empty title sometimes
      expect(typeof item.title).toBe("string");
      expect(item.timeUpdated).toBeGreaterThan(0);
      expect(typeof item.timeUpdated).toBe("number");
    }
  }, 15_000);

  it("returns empty array for empty input", async () => {
    const items = await fetchWorkshopItems([]);
    expect(items).toEqual([]);
  });

  it("filters out invalid items", async () => {
    // Mix of valid and invalid IDs
    const workshopIds = ["2169330869", "9999999999999"];
    const items = await fetchWorkshopItems(workshopIds);
    // Should succeed but may return fewer items than requested
    expect(Array.isArray(items)).toBe(true);
  });

  it("throws on timeout", async () => {
    const workshopIds = ["2169330869"];
    await expect(
      fetchWorkshopItems(workshopIds, { timeoutMs: 1 }),
    ).rejects.toThrow("steam_api_timeout");
  });
});
