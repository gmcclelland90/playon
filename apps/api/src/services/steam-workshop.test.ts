import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWorkshopItems } from "./steam-workshop.js";

function steamDetailsResponse(
  details: Array<{
    publishedfileid: string;
    title?: string;
    time_updated: number;
    result?: number;
  }>,
): Response {
  return new Response(
    JSON.stringify({
      response: {
        result: 1,
        resultcount: details.length,
        publishedfiledetails: details,
      },
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

describe("fetchWorkshopItems", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps Steam publishedfiledetails into workshop items", async () => {
    const workshopIds = ["2169330869", "2260789317"];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        steamDetailsResponse([
          {
            publishedfileid: "2169330869",
            title: "Mod A",
            time_updated: 1_700_000_000,
            result: 1,
          },
          {
            publishedfileid: "2260789317",
            title: "Mod B",
            time_updated: 1_700_000_100,
            result: 1,
          },
        ]),
      ),
    );

    const items = await fetchWorkshopItems(workshopIds);

    expect(items).toEqual([
      {
        workshopId: "2169330869",
        title: "Mod A",
        timeUpdated: 1_700_000_000,
      },
      {
        workshopId: "2260789317",
        title: "Mod B",
        timeUpdated: 1_700_000_100,
      },
    ]);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("returns empty array for empty input", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const items = await fetchWorkshopItems([]);
    expect(items).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("filters out invalid items", async () => {
    const workshopIds = ["2169330869", "9999999999999"];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        steamDetailsResponse([
          {
            publishedfileid: "2169330869",
            title: "Valid",
            time_updated: 1_700_000_000,
            result: 1,
          },
          {
            publishedfileid: "9999999999999",
            time_updated: 0,
            result: 9,
          },
        ]),
      ),
    );

    const items = await fetchWorkshopItems(workshopIds);
    expect(items).toEqual([
      {
        workshopId: "2169330869",
        title: "Valid",
        timeUpdated: 1_700_000_000,
      },
    ]);
  });

  it("throws on timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("missing_abort_signal"));
            return;
          }
          if (signal.aborted) {
            reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
            return;
          }
          signal.addEventListener("abort", () => {
            reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
          });
        });
      }),
    );

    const workshopIds = ["2169330869"];
    await expect(
      fetchWorkshopItems(workshopIds, { timeoutMs: 1 }),
    ).rejects.toThrow("steam_api_timeout");
  });

  it("throws steam_api_http_* on non-OK responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 503 })),
    );
    await expect(fetchWorkshopItems(["2169330869"])).rejects.toThrow(
      "steam_api_http_503",
    );
  });
});
