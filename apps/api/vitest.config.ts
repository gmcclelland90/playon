import { defineConfig } from "vitest/config";
import { windowsVitestTest } from "../../vitest.windows.mjs";

const isWin = process.platform === "win32";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.int.test.ts"],
    setupFiles: ["src/test/setup-unit.ts"],
    /*
     * Most of these "unit" tests bootstrap a real temp PLAYON_DATA_ROOT: SQLite
     * migrations, skill trees on disk, archive extraction, snapshot copies. On a
     * 4-vCPU Windows CI runner a single one of them routinely takes 3-9s, so the
     * 5s/10s vitest defaults sit right on the edge and a slow runner fails dozens
     * of tests at once. Sized for the slowest runner, still short enough that a
     * genuine hang fails the job rather than stalling it.
     *
     * 60s test budget: a loaded windows-latest runner routinely spends 10–18s
     * on SQLite/skill I/O; 30s still false-timed-out after the #882 hang was
     * removed (tool-registry-parity + onTaskUpdate). Pool isolation stays on
     * forks (nativeAddon) — better-sqlite3 Access-Violates under threads.
     */
    testTimeout: isWin ? 60_000 : 30_000,
    hookTimeout: isWin ? 60_000 : 30_000,
    ...windowsVitestTest({ nativeAddon: true }),
  },
});
