import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.int.test.ts"],
    /*
     * Most of these "unit" tests bootstrap a real temp PLAYON_DATA_ROOT: SQLite
     * migrations, skill trees on disk, archive extraction, snapshot copies. On a
     * 4-vCPU Windows CI runner a single one of them routinely takes 3-9s, so the
     * 5s/10s vitest defaults sit right on the edge and a slow runner fails dozens
     * of tests at once. Sized for the slowest runner, still short enough that a
     * genuine hang fails the job rather than stalling it.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
