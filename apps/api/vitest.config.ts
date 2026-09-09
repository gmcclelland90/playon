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
     * removed (tool-registry-parity + onTaskUpdate). Pool stays on forks
     * (nativeAddon) — better-sqlite3 Access-Violates under threads. #912 also
     * splits long snapshot files and serializes Windows CI turbo so birpc does
     * not miss onTaskUpdate after a fully green suite.
     *
     * After #948 the envelope (~124s) and runtime-handle (~177s) files grew
     * past that cliff on windows-latest (run 34306522471). Those suites are
     * split, and Windows `test:unit` runs them in sequential vitest processes.
     */
    testTimeout: isWin ? 90_000 : 30_000,
    hookTimeout: isWin ? 90_000 : 30_000,
    ...windowsVitestTest({ nativeAddon: true }),
  },
});
