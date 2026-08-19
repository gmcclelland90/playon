/**
 * Windows CI extras for vitest 3.x + tinypool 1.x.
 *
 * Default `pool: "forks"` can finish every assertion green, then crash the
 * runner on teardown:
 *
 *   TypeError: emitter.removeListener is not a function
 *   at ChildProcess.errorListener (node:events)
 *   at ChildProcess.onUnexpectedExit (tinypool)
 *
 * Same class as the api unit hang/timeout workarounds (#883, vitest#8164).
 * Serialize workers. Packages without native addons use `threads` so teardown
 * does not go through ChildProcess. Do not set `pool: "threads"` when the
 * suite loads better-sqlite3 (Access Violation on Windows worker_threads).
 *
 * @param {{ nativeAddon?: boolean }} [opts]
 */
export function windowsVitestTest(opts = {}) {
  if (process.platform !== "win32") return {};
  return {
    fileParallelism: false,
    maxWorkers: 1,
    teardownTimeout: 60_000,
    ...(opts.nativeAddon ? {} : { pool: "threads" }),
  };
}
