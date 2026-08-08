import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LANCACHE_HOSTS_BEGIN,
  LANCACHE_HOSTS_END,
  applyLancacheHostsPin,
  buildLancacheHostsBlock,
  renderHostsWithLancachePin,
  stripLancacheHostsBlock,
} from "./lancache-hosts.js";

describe("lancache-hosts", () => {
  it("strips an existing PlayOn block", () => {
    const content = [
      "127.0.0.1 localhost",
      LANCACHE_HOSTS_BEGIN,
      "10.0.0.5\tsteamcontent.com",
      LANCACHE_HOSTS_END,
      "10.0.0.1 router",
      "",
    ].join("\n");
    const stripped = stripLancacheHostsBlock(content);
    expect(stripped).toContain("127.0.0.1 localhost");
    expect(stripped).toContain("10.0.0.1 router");
    expect(stripped).not.toContain(LANCACHE_HOSTS_BEGIN);
    expect(stripped).not.toContain("steamcontent.com");
  });

  it("renders pin block with cache IP", () => {
    const block = buildLancacheHostsBlock("10.0.0.9", ["steamcontent.com"]);
    expect(block).toContain(LANCACHE_HOSTS_BEGIN);
    expect(block).toContain("10.0.0.9");
    expect(block).toContain("steamcontent.com");
    expect(block).toContain(LANCACHE_HOSTS_END);
  });

  it("apply writes and removes via temp hosts file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playon-lancache-hosts-"));
    const hostsPath = path.join(dir, "hosts");
    fs.writeFileSync(hostsPath, "127.0.0.1 localhost\n", "utf8");

    const applied = applyLancacheHostsPin({
      hostsPath,
      cacheIp: "192.168.1.50",
      hostnames: ["steamcontent.com", "steamcdn-a.akamaihd.net"],
    });
    expect(applied.status).toBe("applied");
    const mid = fs.readFileSync(hostsPath, "utf8");
    expect(mid).toContain("192.168.1.50");
    expect(mid).toContain("steamcontent.com");

    const removed = applyLancacheHostsPin({ hostsPath, cacheIp: null });
    expect(removed.status).toBe("removed");
    const end = fs.readFileSync(hostsPath, "utf8");
    expect(end).not.toContain(LANCACHE_HOSTS_BEGIN);
    expect(end).toContain("127.0.0.1 localhost");
  });

  it("rejects invalid cache IP", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playon-lancache-hosts-"));
    const hostsPath = path.join(dir, "hosts");
    fs.writeFileSync(hostsPath, "", "utf8");
    const r = applyLancacheHostsPin({ hostsPath, cacheIp: "not-an-ip" });
    expect(r.status).toBe("error");
  });

  it("renderHostsWithLancachePin is idempotent when re-applied", () => {
    const base = "127.0.0.1 localhost\n";
    const once = renderHostsWithLancachePin(base, "10.0.0.1", ["steamcontent.com"]);
    const twice = renderHostsWithLancachePin(once, "10.0.0.1", ["steamcontent.com"]);
    expect(twice.split(LANCACHE_HOSTS_BEGIN).length).toBe(2);
  });
});
