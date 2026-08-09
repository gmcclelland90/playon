import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  certIsUsable,
  clearHomeHostnameState,
  loadHomeHostnameState,
  needsRenewal,
  saveHomeHostnameState,
  type HomeHostnameState,
} from "./home-hostname.js";

const temps: string[] = [];

afterEach(() => {
  for (const root of temps.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function sample(overrides: Partial<HomeHostnameState> = {}): HomeHostnameState {
  return {
    installId: "hdi_test",
    deviceKey: "phd_test",
    hostname: "alice.playon.games",
    slug: "alice",
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("home-hostname state", () => {
  it("round-trips through dataRoot", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-hh-"));
    temps.push(root);
    const state = sample({ discordUsername: "Alice" });
    saveHomeHostnameState(root, state);
    expect(loadHomeHostnameState(root)).toMatchObject({
      hostname: "alice.playon.games",
      discordUsername: "Alice",
    });
    clearHomeHostnameState(root);
    expect(loadHomeHostnameState(root)).toBeNull();
  });

  it("treats missing or expired certs as unusable", () => {
    expect(certIsUsable(sample())).toBe(false);
    expect(
      certIsUsable(
        sample({
          certPem: "CERT",
          keyPem: "KEY",
          certExpiresAt: new Date(Date.now() - 1000).toISOString(),
        }),
      ),
    ).toBe(false);
    expect(
      certIsUsable(
        sample({
          certPem: "CERT",
          keyPem: "KEY",
          certExpiresAt: new Date(Date.now() + 86400000).toISOString(),
        }),
      ),
    ).toBe(true);
  });

  it("renews when under 30 days remain", () => {
    expect(needsRenewal(sample({ certExpiresAt: new Date(Date.now() + 86400000).toISOString() }))).toBe(
      true,
    );
    expect(
      needsRenewal(
        sample({
          certExpiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
        }),
      ),
    ).toBe(false);
  });
});
