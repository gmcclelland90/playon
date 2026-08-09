import { describe, expect, it } from "vitest";
import { buildPanelUrls, formatHttpUrl, mdnsPanelUrl } from "./panel-urls.js";

describe("panel-urls", () => {
  it("omits default http/https ports", () => {
    expect(formatHttpUrl("playon.local", 80)).toBe("http://playon.local");
    expect(formatHttpUrl("192.168.1.10", 8787)).toBe("http://192.168.1.10:8787");
    expect(mdnsPanelUrl(80)).toBe("http://playon.local");
    expect(mdnsPanelUrl(8787)).toBe("http://playon.local:8787");
  });

  it("prefers https when ready, lists all urls", () => {
    const urls = buildPanelUrls({
      advertiseHost: "192.168.1.10",
      lanPort: 80,
      mdnsAdvertised: true,
      publicHostname: "alice.playon.games",
      httpsReady: true,
    });
    expect(urls.preferredUrl).toBe("https://alice.playon.games");
    expect(urls.allUrls).toEqual([
      "https://alice.playon.games",
      "http://playon.local",
      "http://192.168.1.10",
    ]);
  });

  it("falls back to mdns then ip", () => {
    const urls = buildPanelUrls({
      advertiseHost: "10.0.0.2",
      lanPort: 8787,
      mdnsAdvertised: true,
    });
    expect(urls.preferredUrl).toBe("http://playon.local:8787");
    expect(urls.ipUrl).toBe("http://10.0.0.2:8787");
  });
});
