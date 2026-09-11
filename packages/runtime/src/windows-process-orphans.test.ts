import { describe, expect, it } from "vitest";
import {
  isUsableWindowsRoot,
  parseWindowsProcessListing,
  pidsMatchingWindowsRoots,
  windowsCommandLineMentionsRoot,
  windowsPathContainsRoot,
  windowsRowMatchesRoots,
} from "./windows-process-orphans.js";

const LISTING = [
  "4120\tC:\\Windows\\System32\\cmd.exe\t",
  '8812\tC:\\playon-node\\data\\servers\\abc\\game\\FoundryDedicatedServer.exe\t"C:\\playon-node\\data\\servers\\abc\\game\\FoundryDedicatedServer.exe" -log',
  "9001\tC:\\playon-node\\data\\servers\\abcdef\\game\\Moria.exe\tC:\\playon-node\\data\\servers\\abcdef\\game\\Moria.exe",
  "100\tC:\\Windows\\System32\\ping.exe\tping -n 40 127.0.0.1",
].join("\n");

describe("windows path matching", () => {
  it("requires a directory boundary so abc does not match abcdef", () => {
    const root = "C:\\playon-node\\data\\servers\\abc";
    expect(
      windowsPathContainsRoot(
        "C:\\playon-node\\data\\servers\\abc\\game\\FoundryDedicatedServer.exe",
        root,
      ),
    ).toBe(true);
    expect(
      windowsPathContainsRoot("C:\\playon-node\\data\\servers\\abcdef\\game\\Moria.exe", root),
    ).toBe(false);
    expect(windowsPathContainsRoot("C:\\playon-node\\data\\servers\\abc", root)).toBe(true);
    expect(isUsableWindowsRoot("C:\\")).toBe(false);
    expect(isUsableWindowsRoot("C:\\playon-node\\data\\servers\\abc")).toBe(true);
  });

  it("matches a quoted command line that mentions the jail", () => {
    const root = "C:\\playon-node\\data\\servers\\abc";
    expect(
      windowsCommandLineMentionsRoot(
        '"C:\\playon-node\\data\\servers\\abc\\game\\hold.cmd"',
        root,
      ),
    ).toBe(true);
    expect(
      windowsCommandLineMentionsRoot(
        '"C:\\playon-node\\data\\servers\\abcdef\\game\\hold.cmd"',
        root,
      ),
    ).toBe(false);
  });

  it("matches CIM 8.3 short paths that share a unique jail leaf", () => {
    const longRoot = "C:\\Users\\runner\\AppData\\Local\\Temp\\playon-proc-k7x9m2ab";
    expect(
      windowsPathContainsRoot(
        "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\playon-proc-k7x9m2ab",
        longRoot,
      ),
    ).toBe(true);
    expect(
      windowsCommandLineMentionsRoot(
        "cmd.exe /c C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\playon-proc-k7x9m2ab\\game\\hold.cmd",
        longRoot,
      ),
    ).toBe(true);
    expect(
      windowsPathContainsRoot("C:\\Users\\RUNNER~1\\other\\game", "C:\\Users\\runner\\servers\\game"),
    ).toBe(false);
  });
});

describe("parse + select Windows process rows", () => {
  it("selects only pids whose exe/cmdline sit under the orphan jail", () => {
    const rows = parseWindowsProcessListing(LISTING);
    expect(rows).toHaveLength(4);
    const pids = pidsMatchingWindowsRoots(rows, ["C:\\playon-node\\data\\servers\\abc"], {
      selfPid: 1,
    });
    expect(pids).toEqual([8812]);
    expect(
      windowsRowMatchesRoots(rows[2]!, ["C:\\playon-node\\data\\servers\\abc"]),
    ).toBe(false);
  });
});
