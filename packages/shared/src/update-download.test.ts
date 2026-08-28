import { describe, expect, it } from "vitest";
import {
  UPDATE_DOWNLOAD_SHA_QUERY,
  archiveKindFromBytes,
  assertUpdateArchiveLooksReal,
  cacheBustUpdateDownloadUrl,
  formatUpdateSha256Mismatch,
  hexMagic,
} from "./update-download.js";

describe("cacheBustUpdateDownloadUrl", () => {
  it("appends playon_sha256 without changing host or path", () => {
    const sha = "c2ab7575e942a1d3265def8b7fdeec9ae2ff3e8d7b131883196708385c18305a";
    const href = cacheBustUpdateDownloadUrl(
      "https://github.com/gmcclelland90/playon/releases/download/v0.2.11/playon-node-0.2.11-windows-x64.tar.gz",
      sha,
    );
    const url = new URL(href);
    expect(url.hostname).toBe("github.com");
    expect(url.pathname).toBe(
      "/gmcclelland90/playon/releases/download/v0.2.11/playon-node-0.2.11-windows-x64.tar.gz",
    );
    expect(url.searchParams.get(UPDATE_DOWNLOAD_SHA_QUERY)).toBe(sha);
  });

  it("replaces an existing playon_sha256 value", () => {
    const href = cacheBustUpdateDownloadUrl(
      "https://playon.games/home/packages/x.tar.gz?playon_sha256=deadbeef",
      "A".repeat(64),
    );
    expect(new URL(href).searchParams.get(UPDATE_DOWNLOAD_SHA_QUERY)).toBe("a".repeat(64));
  });
});

describe("archiveKindFromBytes / assertUpdateArchiveLooksReal", () => {
  it("detects gzip, zip, html, and xml", () => {
    expect(archiveKindFromBytes(new Uint8Array([0x1f, 0x8b, 0x08]))).toBe("gzip");
    expect(archiveKindFromBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe("zip");
    expect(archiveKindFromBytes(new TextEncoder().encode("<!DOCTYPE html><html>"))).toBe("html");
    expect(archiveKindFromBytes(new TextEncoder().encode("<?xml version=\"1.0\"?><Error>"))).toBe(
      "xml",
    );
    expect(hexMagic(new Uint8Array([0x1f, 0x8b]))).toBe("1f8b");
  });

  it("accepts gzip/zip and rejects HTML before apply (#917)", () => {
    expect(
      assertUpdateArchiveLooksReal({ bytes: new Uint8Array([0x1f, 0x8b, 0x08]), expectedBytes: 3 }),
    ).toBe("gzip");
    expect(() =>
      assertUpdateArchiveLooksReal({
        bytes: new TextEncoder().encode("<!DOCTYPE html>"),
        contentType: "text/html",
      }),
    ).toThrow(/update_download_not_archive: kind=html/);
    expect(() =>
      assertUpdateArchiveLooksReal({
        bytes: new Uint8Array([0x1f, 0x8b, 0x08]),
        expectedBytes: 39600808,
      }),
    ).toThrow(/update_download_size_mismatch: expected 39600808 got 3 kind=gzip/);
  });
});

describe("formatUpdateSha256Mismatch", () => {
  it("includes expected vs got plus size/kind so the job is not an opaque miss", () => {
    const msg = formatUpdateSha256Mismatch({
      expectedSha256: "c2ab7575" + "a".repeat(56),
      gotSha256: "42579e38" + "b".repeat(56),
      bytes: 2048,
      expectedBytes: 39600808,
      kind: "html",
      contentType: "text/html",
    });
    expect(msg).toMatch(/update_sha256_mismatch: expected c2ab7575/);
    expect(msg).toMatch(/got 42579e38/);
    expect(msg).toMatch(/bytes=2048/);
    expect(msg).toMatch(/expectedBytes=39600808/);
    expect(msg).toMatch(/kind=html/);
    expect(msg).toMatch(/contentType=text\/html/);
  });
});
