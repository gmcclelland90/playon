import { defineConfig, devices } from "@playwright/test";

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
      env: {
        ...process.env,
        PLAYON_HOST: "127.0.0.1",
        PLAYON_PORT: apiPort,
        PLAYON_LLM_MODE: "openai_compatible",
        PLAYON_RUNTIME: "docker",
        PLAYON_DATA_ROOT: "tmp/e2e-data",
      },
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
