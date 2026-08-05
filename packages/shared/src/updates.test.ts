import { describe, expect, it } from "vitest";
import {
  assertAllowedUpdateDownloadUrl,
  compareSemver,
  isNewerVersion,
  UpdateManifestSchema,
} from "./updates.js";

describe("compareSemver / isNewerVersion", () => {
  it("compares plain and v-prefixed versions", () => {
    expect(compareSemver("0.1.5", "0.1.4")).toBe(1);
    expect(compareSemver("v0.1.4", "0.1.4")).toBe(0);
    expect(compareSemver("0.1.3", "0.1.4")).toBe(-1);
    expect(isNewerVersion("0.2.0", "0.1.9")).toBe(true);
    expect(isNewerVersion("0.1.4", "0.1.4")).toBe(false);
  });
});

describe("UpdateManifestSchema", () => {
  it("parses a home/node manifest", () => {
    const m = UpdateManifestSchema.parse({
      version: "0.1.5",
      channel: "stable",
      notesUrl: "https://playon.games/docs/changelog",
      home: {
        "linux-x64": {
          downloadUrl: "https://github.com/gmcclelland90/playon/releases/download/v0.1.5/playon-home-0.1.5-linux-x64.tar.gz",
          sha256: "a".repeat(64),
        },
      },
      node: {
        "linux-x64": {
          downloadUrl: "https://github.com/gmcclelland90/playon/releases/download/v0.1.5/playon-node-0.1.5-linux-x64.tar.gz",
          sha256: "b".repeat(64),
        },
      },
    });
    expect(m.version).toBe("0.1.5");
    expect(m.home["linux-x64"]?.sha256).toHaveLength(64);
  });
});

describe("assertAllowedUpdateDownloadUrl", () => {
  it("allows github and playon.games https", () => {
    expect(
      assertAllowedUpdateDownloadUrl(
        "https://playon.games/home/packages/playon-home-0.1.5-linux-x64.tar.gz",
      ).hostname,
    ).toBe("playon.games");
  });

  it("rejects http and unknown hosts", () => {
    expect(() => assertAllowedUpdateDownloadUrl("http://playon.games/x")).toThrow(
      /https_required/,
    );
    expect(() => assertAllowedUpdateDownloadUrl("https://evil.example/x")).toThrow(
      /host_not_allowed/,
    );
  });
});
