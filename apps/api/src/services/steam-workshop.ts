/**
 * Steam Workshop integration for monitoring workshop item updates.
 * Uses Steam Web API ISteamRemoteStorage/GetPublishedFileDetails endpoint.
 */

type WorkshopItemDetail = {
  publishedfileid: string;
  title?: string;
  time_updated: number;
  result?: number;
};

type SteamApiResponse = {
  response: {
    result?: number;
    resultcount?: number;
    publishedfiledetails?: WorkshopItemDetail[];
  };
};

export type WorkshopItemInfo = {
  workshopId: string;
  title: string;
  timeUpdated: number;
};

/**
 * Query Steam Web API for workshop item details.
 * Returns time_updated and title for each requested item.
 */
export async function fetchWorkshopItems(
  workshopIds: string[],
  opts?: { apiKey?: string; timeoutMs?: number },
): Promise<WorkshopItemInfo[]> {
  if (!workshopIds.length) return [];

  // Steam Web API endpoint (POST form data)
  const url = "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/";
  const timeoutMs = opts?.timeoutMs ?? 10_000;

  // Build form data with itemcount + publishedfileids[0..N]
  const formData = new URLSearchParams();
  formData.append("itemcount", String(workshopIds.length));
  workshopIds.forEach((id, idx) => {
    formData.append(`publishedfileids[${idx}]`, id);
  });
  if (opts?.apiKey) {
    formData.append("key", opts.apiKey);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData.toString(),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`steam_api_http_${res.status}`);
    }

    const json = (await res.json()) as SteamApiResponse;
    const details = json.response.publishedfiledetails ?? [];

    return details
      .filter((item) => item.result === 1 || !item.result) // result=1 is success; missing = success
      .map((item) => ({
        workshopId: item.publishedfileid,
        title: item.title ?? `Workshop ${item.publishedfileid}`,
        timeUpdated: item.time_updated,
      }));
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error("steam_api_timeout");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Key for storing workshop watcher state in settings table.
 * JSON shape: Record<serverId, Record<workshopId, { lastSeen: number }>>
 */
export const WORKSHOP_WATCHER_STATE_KEY = "watcher.workshop_state";

export type WorkshopWatcherState = Record<
  string,
  Record<string, { lastSeen: number }>
>;
