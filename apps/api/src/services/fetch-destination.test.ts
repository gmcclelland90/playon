import { describe, expect, it } from "vitest";
import {
  assertFetchDestinationIp,
  isBlockedDestinationIp,
  isFetchDestinationAllowed,
  parseFetchLanAllowlist,
} from "./fetch-destination.js";

describe("isBlockedDestinationIp", () => {
  it("blocks RFC1918, loopback, link-local, CGNAT, and multicast", () => {
    expect(isBlockedDestinationIp("10.0.0.1")).toBe(true);
    expect(isBlockedDestinationIp("192.168.1.1")).toBe(true);
    expect(isBlockedDestinationIp("172.16.0.1")).toBe(true);
    expect(isBlockedDestinationIp("172.31.255.1")).toBe(true);
    expect(isBlockedDestinationIp("127.0.0.1")).toBe(true);
    expect(isBlockedDestinationIp("127.0.0.2")).toBe(true);
    expect(isBlockedDestinationIp("169.254.169.254")).toBe(true);
    expect(isBlockedDestinationIp("100.64.0.1")).toBe(true);
    expect(isBlockedDestinationIp("0.0.0.0")).toBe(true);
    expect(isBlockedDestinationIp("224.0.0.1")).toBe(true);
    expect(isBlockedDestinationIp("::1")).toBe(true);
    expect(isBlockedDestinationIp("[::1]")).toBe(true);
    expect(isBlockedDestinationIp("fc00::1")).toBe(true);
    expect(isBlockedDestinationIp("fe80::1")).toBe(true);
    expect(isBlockedDestinationIp("ff02::1")).toBe(true);
    expect(isBlockedDestinationIp("::ffff:192.168.1.1")).toBe(true);
    expect(isBlockedDestinationIp("::ffff:127.0.0.1")).toBe(true);
  });

  it("allows public destinations", () => {
    expect(isBlockedDestinationIp("8.8.8.8")).toBe(false);
    expect(isBlockedDestinationIp("1.1.1.1")).toBe(false);
    expect(isBlockedDestinationIp("2001:4860:4860::8888")).toBe(false);
  });
});

describe("parseFetchLanAllowlist", () => {
  it("canonicalizes RFC1918 and loopback CIDRs the host opted into", () => {
    expect(parseFetchLanAllowlist(["192.168.1.50", "10.0.0.0/8", "127.0.0.1"])).toEqual([
      "192.168.1.50",
      "10.0.0.0/8",
      "127.0.0.1",
    ]);
    expect(parseFetchLanAllowlist(["192.168.1.50/24"])).toEqual(["192.168.1.0/24"]);
    expect(parseFetchLanAllowlist(["::1", "fd12:3456::/32"])).toEqual(["::1", "fd12:3456::/32"]);
  });

  it("skips blanks, dedupes, and rejects hostnames", () => {
    expect(parseFetchLanAllowlist(["  ", "192.168.0.1", "192.168.0.1"])).toEqual(["192.168.0.1"]);
    expect(() => parseFetchLanAllowlist(["nas.local"])).toThrow(/fetch_allowlist_invalid/);
  });

  it("rejects public, link-local, CGNAT, and catch-all ranges", () => {
    expect(() => parseFetchLanAllowlist(["8.8.8.8"])).toThrow(/fetch_allowlist_not_private/);
    expect(() => parseFetchLanAllowlist(["169.254.169.254"])).toThrow(/fetch_allowlist_not_private/);
    expect(() => parseFetchLanAllowlist(["100.64.0.1"])).toThrow(/fetch_allowlist_not_private/);
    expect(() => parseFetchLanAllowlist(["0.0.0.0/0"])).toThrow(/fetch_allowlist_not_private/);
    expect(() => parseFetchLanAllowlist(["fe80::1"])).toThrow(/fetch_allowlist_not_private/);
  });
});

describe("isFetchDestinationAllowed", () => {
  it("allows public IPs with an empty allowlist", () => {
    expect(isFetchDestinationAllowed("8.8.8.8", [])).toBe(true);
  });

  it("blocks RFC1918 and localhost until the host opts in", () => {
    expect(isFetchDestinationAllowed("192.168.1.1", [])).toBe(false);
    expect(isFetchDestinationAllowed("10.0.0.1", [])).toBe(false);
    expect(isFetchDestinationAllowed("127.0.0.1", [])).toBe(false);
    expect(isFetchDestinationAllowed("127.0.0.2", [])).toBe(false);
    expect(isFetchDestinationAllowed("::1", [])).toBe(false);
    expect(isFetchDestinationAllowed("169.254.169.254", [])).toBe(false);
  });

  it("allows loopback only when that address is on the settings allowlist", () => {
    expect(isFetchDestinationAllowed("127.0.0.1", ["127.0.0.1"])).toBe(true);
    expect(isFetchDestinationAllowed("127.0.0.2", ["127.0.0.1"])).toBe(false);
    expect(isFetchDestinationAllowed("::1", ["::1"])).toBe(true);
    expect(isFetchDestinationAllowed("127.0.0.1", ["127.0.0.0/8"])).toBe(true);
  });

  it("allows only the RFC1918 IPs/CIDRs the host opted into", () => {
    expect(isFetchDestinationAllowed("192.168.1.50", ["192.168.1.50"])).toBe(true);
    expect(isFetchDestinationAllowed("192.168.1.51", ["192.168.1.50"])).toBe(false);
    expect(isFetchDestinationAllowed("192.168.1.51", ["192.168.1.0/24"])).toBe(true);
    expect(isFetchDestinationAllowed("192.168.2.1", ["192.168.1.0/24"])).toBe(false);
    expect(isFetchDestinationAllowed("10.9.8.7", ["10.0.0.0/8"])).toBe(true);
    expect(isFetchDestinationAllowed("::ffff:192.168.1.50", ["192.168.1.0/24"])).toBe(true);
  });

  it("never allows link-local metadata even if someone stuffed it in the list", () => {
    expect(isFetchDestinationAllowed("169.254.169.254", ["169.254.169.254"])).toBe(false);
  });
});

describe("assertFetchDestinationIp", () => {
  it("throws fetch_blocked_destination for private IPs off the allowlist", () => {
    expect(() => assertFetchDestinationIp("192.168.0.1", [])).toThrow(/fetch_blocked_destination/);
    expect(() => assertFetchDestinationIp("127.0.0.1", [])).toThrow(/fetch_blocked_destination/);
    expect(() => assertFetchDestinationIp("8.8.8.8", [])).not.toThrow();
  });
});
