import { execFileSync } from "node:child_process";

/**
 * Unpack a vendored Node archive into `destDir`.
 *
 * Windows zip uses `tar -xf` (bsdtar on windows-latest). Expand-Archive is only
 * the fallback. GitHub Actions runs `pnpm package:home` under pwsh, which puts
 * PowerShell 7's modules on PSModulePath. Windows PowerShell 5.1 then loads that
 * Archive module and Expand-Archive calls the 3-arg ExtractToDirectory overload
 * that .NET Framework does not have.
 */
export function extractVendoredNodeArchive(archivePath, destDir, platform = process.platform) {
  if (platform !== "win32") {
    execFileSync("tar", ["-xzf", archivePath, "-C", destDir], { stdio: "inherit" });
    return;
  }
  try {
    execFileSync("tar", ["-xf", archivePath, "-C", destDir], { stdio: "inherit" });
    return;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`tar zip extract failed (${message}); Expand-Archive fallback`);
  }
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "psmodulepath") delete env[key];
  }
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `$ProgressPreference = 'SilentlyContinue'; Expand-Archive -LiteralPath ${quote(archivePath)} -DestinationPath ${quote(destDir)} -Force`,
    ],
    { stdio: "inherit", env },
  );
}
