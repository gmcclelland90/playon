import { defineConfig } from "vitest/config";
import { windowsVitestTest } from "../../vitest.windows.mjs";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.contract.test.ts"],
    ...windowsVitestTest(),
  },
});
