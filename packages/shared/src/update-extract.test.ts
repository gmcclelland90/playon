import { describe, expect, it } from "vitest";
import {
  ARCHIVE_EXTRACT_TIMEOUT_MS,
  buildArchiveExtractCommands,
  preferredUpdateAssetExtensions,
  psSingleQuote,
  windowsPowerShellExpandArchiveArgs,
  windowsTarExtractArgs,
} from "./update-extract.js";

describe("archive extract plan (#868)", () => {
  it("uses a long timeout, not the 60s spawnSync that timed out on playon-win-1", () => {
    expect(ARCHIVE_EXTRACT_TIMEOUT_MS).toBe(10 * 60 * 1000);
    expect(ARCHIVE_EXTRACT_TIMEOUT_MS).toBeGreaterThan(60_000);
  });

  it("prefers tar --force-local for Windows zip (no Expand-Archive first)", () => {
    const zip = "C:\\Temp\\playon-node-0.2.5-windows-x64.zip";
    const dest = "C:\\Temp\\extracted";
    const commands = buildArchiveExtractCommands(zip, dest, "win32");
    expect(commands[0]).toEqual({
      cmd: "tar",
      args: ["--force-local", "-xf", zip, "-C", dest],
    });
    expect(windowsTarExtractArgs(zip, dest)).toEqual(commands[0]?.args);
    expect(commands[1]?.cmd).toBe("powershell.exe");
    const ps = commands[1]?.args.join(" ") ?? "";
    expect(ps).toContain("ProgressPreference");
    expect(ps).toContain("SilentlyContinue");
    expect(ps).toContain("Expand-Archive");
    expect(ps).toContain("-LiteralPath");
    expect(ps).toContain("-NonInteractive");
    expect(windowsPowerShellExpandArchiveArgs(zip, dest).join(" ")).toContain("SilentlyContinue");
  });

  it("does not use PowerShell for Windows tar.gz (0.2.3 agents already have this branch)", () => {
    const archive = "C:\\Temp\\playon-node-0.2.6-windows-x64.tar.gz";
    const dest = "C:\\Temp\\extracted";
    const commands = buildArchiveExtractCommands(archive, dest, "win32");
    expect(commands).toEqual([
      { cmd: "tar", args: ["--force-local", "-xzf", archive, "-C", dest] },
    ]);
  });

  it("keeps Linux zip/tar paths off PowerShell", () => {
    expect(buildArchiveExtractCommands("/tmp/a.zip", "/tmp/out", "linux")).toEqual([
      { cmd: "unzip", args: ["-q", "/tmp/a.zip", "-d", "/tmp/out"] },
    ]);
    expect(buildArchiveExtractCommands("/tmp/a.tar.gz", "/tmp/out", "linux")).toEqual([
      { cmd: "tar", args: ["-xzf", "/tmp/a.tar.gz", "-C", "/tmp/out"] },
    ]);
  });

  it("escapes single quotes for PowerShell -LiteralPath", () => {
    expect(psSingleQuote("C:\\O'Brien\\pkg.zip")).toBe("'C:\\O''Brien\\pkg.zip'");
  });

  it("publishes Windows node as tar.gz first so 0.2.3 agents use tar -xzf", () => {
    expect(preferredUpdateAssetExtensions("node", "windows-x64")).toEqual(["tar.gz", "zip"]);
    expect(preferredUpdateAssetExtensions("home", "windows-x64")).toEqual(["zip", "tar.gz"]);
    expect(preferredUpdateAssetExtensions("node", "linux-x64")).toEqual(["tar.gz", "zip"]);
  });
});
