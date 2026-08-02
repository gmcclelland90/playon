import { parentPort, workerData } from "node:worker_threads";
import { createSkillQueryCtx } from "./ctx.js";

type WorkerInput = {
  moduleHref: string;
  host: string;
  port: number;
  queryPort: number;
  gamePort: number;
  timeoutMs: number;
  allowedPorts: number[];
};

async function main(): Promise<void> {
  const data = workerData as WorkerInput;
  const ctx = createSkillQueryCtx({
    host: data.host,
    port: data.port,
    queryPort: data.queryPort,
    gamePort: data.gamePort,
    timeoutMs: data.timeoutMs,
    allowedPorts: data.allowedPorts,
  });
  const mod = (await import(data.moduleHref)) as {
    default?: (ctx: unknown) => unknown | Promise<unknown>;
    query?: (ctx: unknown) => unknown | Promise<unknown>;
  };
  const fn = mod.default ?? mod.query;
  if (typeof fn !== "function") {
    throw new Error("connector_missing_export");
  }
  const result = await fn(ctx);
  parentPort?.postMessage({ ok: true, result });
}

main().catch((err) => {
  parentPort?.postMessage({
    ok: false,
    error: err instanceof Error ? err.message : "skill_module_failed",
  });
});
