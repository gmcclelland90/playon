import { describe, expect, it } from "vitest";
import { parsePanelBody } from "./panel.js";

describe("parsePanelBody", () => {
  it("parses guide bodies with steps and links", () => {
    const body = parsePanelBody("guide", {
      summary: "LAN night",
      steps: ["Install the client", "Join via /play"],
      links: [{ label: "Mods", url: "https://example.com/mods" }],
    });
    expect(body.summary).toBe("LAN night");
    expect(body.steps).toEqual(["Install the client", "Join via /play"]);
    expect(body.links).toEqual([{ label: "Mods", url: "https://example.com/mods" }]);
  });

  it("parses file_drop http(s) urls", () => {
    const body = parsePanelBody("file_drop", {
      url: "https://cdn.example.com/pack.zip",
      label: "Resource pack",
      sha256: "abc123",
    });
    expect(body).toEqual({
      url: "https://cdn.example.com/pack.zip",
      label: "Resource pack",
      sha256: "abc123",
    });
  });

  it("falls back for invalid file_drop urls", () => {
    const body = parsePanelBody("file_drop", {
      url: "ftp://files.local/pack.zip",
      label: "Pack",
    });
    expect(body.url).toBe("ftp://files.local/pack.zip");
    expect(body.label).toBe("Pack");
  });

  it("parses discovery suggestions", () => {
    const body = parsePanelBody("discovery", {
      summary: "Try next",
      suggestions: [
        { title: "Minecraft", detail: "Paper", skillName: "games.minecraft-paper" },
        { title: "Something else" },
      ],
    });
    expect(body.summary).toBe("Try next");
    expect(body.suggestions).toHaveLength(2);
    expect((body.suggestions as Array<{ title: string }>)[0]?.title).toBe("Minecraft");
  });

  it("normalizes vote options/choices aliases", () => {
    const fromOptions = parsePanelBody("vote", {
      summary: "Map?",
      options: ["Dust", "Inferno"],
    });
    expect(fromOptions.options).toEqual(["Dust", "Inferno"]);
    expect(fromOptions.choices).toEqual(["Dust", "Inferno"]);

    const fromChoices = parsePanelBody("vote", {
      choices: ["A", "B"],
    });
    expect(fromChoices.options).toEqual(["A", "B"]);
    expect(fromChoices.choices).toEqual(["A", "B"]);
  });
});
