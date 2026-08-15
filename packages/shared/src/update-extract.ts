/**
 * How Home and node-agent unpack an OTA archive.
 *
 * playon-win-1 0.2.3→0.2.5 failed with `spawnSync powershell.exe ETIMEDOUT` (#868):
 * `execFileSync("powershell.exe", Expand-Archive, { timeout: 60000 })`. Expand-Archive
 * on a bundled-Node zip often exceeds 60s (progress records + Defender), and spawnSync
 * blocks heartbeats. Prefer `tar` (Windows 10+ extracts zip and tar.gz); PowerShell is
 * a zip fallback with progress disabled and a long timeout.
 */

export const ARCHIVE_EXTRACT_TIMEOUT_MS = 10 * 60 * 1000;

export type ArchiveExtractCommand = {
  cmd: string;
  args: string[];
};

export function psSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Windows extract args. Do not pass GNU `--force-local`: playon-win-1 0.2.8→0.2.9
 * official tar.gz OTA failed with `update_extract_failed: tar --force-local is not
 * supported`. Create-side already dropped that flag for the same Windows tar
 * (#876 / #878).
 */
export function windowsTarExtractArgs(archivePath: string, destDir: string): string[] {
  const isZip = archivePath.toLowerCase().endsWith(".zip");
  return isZip
    ? ["-xf", archivePath, "-C", destDir]
    : ["-xzf", archivePath, "-C", destDir];
}

export function windowsPowerShellExpandArchiveArgs(archivePath: string, destDir: string): string[] {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `$ProgressPreference = 'SilentlyContinue'; Expand-Archive -LiteralPath ${psSingleQuote(archivePath)} -DestinationPath ${psSingleQuote(destDir)} -Force`,
  ];
}

/**
 * Ordered extract attempts. Windows zip: tar first, then Expand-Archive.
 * Windows tar.gz / Linux: tar (or unzip) only — no PowerShell.
 */
/** Manifest / release picker: Windows node OTA must be tar.gz so old agents skip Expand-Archive. */
export function preferredUpdateAssetExtensions(
  kind: "home" | "node",
  platform: string,
): string[] {
  if (platform.startsWith("windows")) {
    return kind === "node" ? ["tar.gz", "zip"] : ["zip", "tar.gz"];
  }
  return ["tar.gz", "zip"];
}

export function buildArchiveExtractCommands(
  archivePath: string,
  destDir: string,
  platform: string,
): ArchiveExtractCommand[] {
  const isZip = archivePath.toLowerCase().endsWith(".zip");
  if (platform === "win32") {
    const commands: ArchiveExtractCommand[] = [
      { cmd: "tar", args: windowsTarExtractArgs(archivePath, destDir) },
    ];
    if (isZip) {
      commands.push({
        cmd: "powershell.exe",
        args: windowsPowerShellExpandArchiveArgs(archivePath, destDir),
      });
    }
    return commands;
  }
  if (isZip) {
    return [{ cmd: "unzip", args: ["-q", archivePath, "-d", destDir] }];
  }
  return [{ cmd: "tar", args: ["-xzf", archivePath, "-C", destDir] }];
}
