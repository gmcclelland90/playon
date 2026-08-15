/**
 * Env for the Playwright-spawned API only.
 * Builds a clone — never assigns onto `process.env`, so `pnpm verify` / api
 * unit tests cannot inherit e2e defaults (PLAYON_RUNTIME=native, data root).
 */
export function e2eApiChildEnv(apiPort: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.PLAYON_HOST = "127.0.0.1";
  env.PLAYON_PORT = apiPort;
  // UI smoke does not exercise Venice or Docker lifecycle.
  env.PLAYON_LLM_MODE = env.PLAYON_LLM_MODE || "openai_compatible";
  env.PLAYON_RUNTIME = env.PLAYON_RUNTIME || "native";
  env.PLAYON_DATA_ROOT = env.PLAYON_DATA_ROOT || "tmp/e2e-data";
  return env;
}
