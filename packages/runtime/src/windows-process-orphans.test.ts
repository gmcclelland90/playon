import { describe, expect, it } from "vitest";
import {
  decodeWindowsConsoleOutput,
  isUsableWindowsRoot,
  parseTasklistCsv,
  parseWindowsProcessListing,
  parseWmicProcessList,
  pidsMatchingWindowsRoots,
  windowsCimFilterForRoots,
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
    expect(
      windowsPathContainsRoot(
        "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\playon-proc-k7x9m2ab\\game\\hold.cmd",
        "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\playon-proc-k7x9m2ab",
      ),
    ).toBe(true);
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

  it("parses tasklist CSV and skips generic image names when collecting jail exes", () => {
    const rows = parseTasklistCsv(
      '"playon-proc-orphan-ad4eCw.exe","3976","Console","1","1,024 K"\r\n"cmd.exe","100","Console","1","2,048 K"\r\n',
    );
    expect(rows).toEqual([
      { image: "playon-proc-orphan-ad4eCw.exe", pid: 3976 },
      { image: "cmd.exe", pid: 100 },
    ]);
  });

  it("parses TSV rows that use a real tab (PowerShell [char]9), not a backtick-t", () => {
    const line = ["4242", "C:\\jail\\game\\hold.exe", ""].join("\t");
    expect(parseWindowsProcessListing(`${line}\n`)[0]).toEqual({
      pid: 4242,
      executablePath: "C:\\jail\\game\\hold.exe",
      commandLine: "",
    });
    expect(parseWindowsProcessListing("4242`tC:\\jail\\game\\hold.exe`t\n")).toEqual([]);
  });

  it("decodes UTF-16LE PowerShell listings and still parses pids", () => {
    const text = "8812\tC:\\jail\\game\\foo.exe\tC:\\jail\\game\\foo.exe\n";
    const le = Buffer.from(text, "utf16le");
    expect(parseWindowsProcessListing(decodeWindowsConsoleOutput(le))[0]?.pid).toBe(8812);
    const bom = Buffer.concat([Buffer.from([0xff, 0xfe]), le]);
    expect(parseWindowsProcessListing(decodeWindowsConsoleOutput(bom))[0]?.pid).toBe(8812);
    expect(parseWindowsProcessListing(le.toString("utf8"))[0]?.pid).toBe(8812);
  });

  it("parses wmic /FORMAT:LIST blocks including 8.3 command lines", () => {
    const text = [
      "CommandLine=C:\\Windows\\system32\\cmd.exe /c C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\playon-proc-k7x9m2ab\\game\\hold.cmd",
      "",
      "ExecutablePath=C:\\Windows\\system32\\cmd.exe",
      "",
      "ProcessId=8812",
      "",
      "",
      "CommandLine=ping -n 40 127.0.0.1",
      "",
      "ExecutablePath=C:\\Windows\\system32\\ping.exe",
      "",
      "ProcessId=9001",
      "",
    ].join("\r\r\n");
    const rows = parseWmicProcessList(text);
    expect(rows).toEqual([
      {
        pid: 8812,
        executablePath: "C:\\Windows\\system32\\cmd.exe",
        commandLine:
          "C:\\Windows\\system32\\cmd.exe /c C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\playon-proc-k7x9m2ab\\game\\hold.cmd",
      },
      {
        pid: 9001,
        executablePath: "C:\\Windows\\system32\\ping.exe",
        commandLine: "ping -n 40 127.0.0.1",
      },
    ]);
    expect(
      pidsMatchingWindowsRoots(rows, [
        "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\playon-proc-k7x9m2ab",
      ]),
    ).toEqual([8812]);
  });

  it("builds a WMI filter from unique jail leaves so CIM need not scan the host", () => {
    const filter = windowsCimFilterForRoots([
      "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\playon-proc-k7x9m2ab",
      "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\playon-proc-k7x9m2ab\\game",
    ]);
    expect(filter).toContain("playon-proc-k7x9m2ab");
    expect(filter).toMatch(/CommandLine LIKE '%playon-proc-k7x9m2ab%'/);
    expect(windowsCimFilterForRoots(["C:\\playon-node\\data\\servers\\abc"])).toBeUndefined();
  });
});
