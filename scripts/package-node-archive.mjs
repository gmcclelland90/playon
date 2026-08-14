/**
 * How `pnpm package:node` creates the node tarball.
 *
 * GitHub windows-latest ships bsdtar (libarchive), which has no `--force-local`.
 * GNU tar treats `D:` in an absolute `-f` path as host:file (#869). Create from
 * the output directory with a relative archive name so Windows bsdtar works and
 * GNU tar never sees a drive colon. Linux create stays on POSIX absolute paths
 * (no `--force-local`; that flag is only needed when a path has a drive colon).
 */

/**
 * @param {{ archiveName: string, outDir: string, stageDirName?: string }} opts
 * @returns {{ cmd: string, args: string[], cwd: string }}
 */
export function windowsNodeTarCreate({ archiveName, outDir, stageDirName = "playon-node" }) {
  if (/[/\\]|:/.test(archiveName)) {
    throw new Error(
      `Windows tar -f must be a relative filename without a drive colon (got ${archiveName})`,
    );
  }
  return {
    cmd: "tar",
    args: ["-czf", archiveName, "-C", ".", stageDirName],
    cwd: outDir,
  };
}

/**
 * @param {{ archivePath: string, outDir: string, stageDirName?: string }} opts
 * @returns {{ cmd: string, args: string[] }}
 */
export function linuxNodeTarCreate({ archivePath, outDir, stageDirName = "playon-node" }) {
  return {
    cmd: "tar",
    args: ["-czf", archivePath, "-C", outDir, stageDirName],
  };
}
