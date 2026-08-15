import { defineConfig, devices } from "@playwright/test";
import { e2eApiChildEnv } from "./e2e/webserver-env.js";

const apiPort = process.env.PLAYON_PORT ?? "8787";
const webPort = process.env.PLAYON_WEB_PORT ?? "5173";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: `pnpm --filter @playon/api exec tsx src/index.ts`,
      url: `http://127.0.0.1:${apiPort}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: e2eApiChildEnv(apiPort),
    },
    {
      command: `pnpm --filter @playon/web exec vite --host 127.0.0.1 --port ${webPort}`,
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        ...process.env,
        PLAYON_API_PROXY: `http://127.0.0.1:${apiPort}`,
      },
    },
  ],
});
