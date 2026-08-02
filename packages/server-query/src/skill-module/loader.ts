import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { offlineState, type LiveServerState } from "@playon/shared";
import { validateLiveState } from "../normalize.js";
import type { Connector, QueryTarget, SkillModuleResolve } from "../types.js";
import { createSkillQueryCtx } from "./ctx.js";

const DEFAULT_CONNECTOR = "query/connector.mjs";
const DEFAULT_TIMEOUT_MS = 3000;

type CacheEntry = { mtimeMs: number; href: string };

const moduleCache = new Map<string, CacheEntry>();

function resolveConnectorPath(skillDir: string, rel?: string): string {
  const connectorRel = rel?.trim() || DEFAULT_CONNECTOR;
  const abs = path.resolve(skillDir, connectorRel);
  const root = path.resolve(skillDir);
  if (!abs.startsWith(root + path.sep) && abs !== root) {
    throw new Error("connector_path_escape");
  }
  if (!fs.existsSync(abs)) {
    throw new Error(`connector_not_found: ${connectorRel}`);
  }
  return abs;
}

function moduleHrefFor(absPath: string): string {
  const stat = fs.statSync(absPath);
  const cached = moduleCache.get(absPath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.href;
  const href = `${pathToFileURL(absPath).href}?t=${stat.mtimeMs}`;
  moduleCache.set(absPath, { mtimeMs: stat.mtimeMs, href });
  return href;
}

function workerEntryPath(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "worker-entry.js"),
    path.join(here, "worker-entry.mjs"),
    // When tests import from src/, prefer built dist worker
    path.resolve(here, "../../dist/skill-module/worker-entry.js"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

async function runInWorker(
  workerPath: string,
  input: {
    moduleHref: string;
    host: string;
    port: number;
    queryPort: number;
    gamePort: number;
    timeoutMs: number;
    allowedPorts: number[];
  },
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData: input });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error("skill_module_timeout"));
    }, input.timeoutMs + 500);
    worker.once("message", (msg: { ok?: boolean; result?: unknown; error?: string }) => {
      clearTimeout(timer);
      void worker.terminate();
      if (msg?.ok) resolve(msg.result);
      else reject(new Error(msg?.error || "skill_module_failed"));
    });
    worker.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    worker.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`skill_module_exit:${code}`));
    });
  });
}

async function runInProcess(input: {
  moduleHref: string;
  host: string;
  port: number;
  queryPort: number;
  gamePort: number;
  timeoutMs: number;
  allowedPorts: number[];
}): Promise<unknown> {
  const ctx = createSkillQueryCtx({
    host: input.host,
    port: input.port,
    queryPort: input.queryPort,
    gamePort: input.gamePort,
    timeoutMs: input.timeoutMs,
    allowedPorts: input.allowedPorts,
  });
  const mod = (await import(input.moduleHref)) as {
    default?: (c: unknown) => unknown | Promise<unknown>;
    query?: (c: unknown) => unknown | Promise<unknown>;
  };
  const fn = mod.default ?? mod.query;
  if (typeof fn !== "function") throw new Error("connector_missing_export");
  return Promise.race([
    Promise.resolve(fn(ctx)),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("skill_module_timeout")), input.timeoutMs);
    }),
  ]);
}

export async function querySkillModule(
  resolve: SkillModuleResolve,
  target: QueryTarget,
): Promise<LiveServerState> {
  const started = Date.now();
  const timeoutMs = target.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const abs = resolveConnectorPath(resolve.skillDir, resolve.connectorRelPath);
    const href = moduleHrefFor(abs);
    const queryPort = target.queryPort ?? target.port;
    const gamePort = target.gamePort ?? target.port;
    const allowedPorts = [
      target.port,
      queryPort,
      gamePort,
      ...(target.allowedPorts ?? []),
    ];
    const input = {
      moduleHref: href,
      host: target.host,
      port: target.port,
      queryPort,
      gamePort,
      timeoutMs,
      allowedPorts,
    };
    const workerPath = workerEntryPath();
    const raw = workerPath ? await runInWorker(workerPath, input) : await runInProcess(input);
    return validateLiveState(raw, Date.now() - started);
  } catch (err) {
    return offlineState(
      err instanceof Error ? err.message : "skill_module_failed",
      Date.now() - started,
    );
  }
}

export function createSkillModuleConnector(resolve: SkillModuleResolve): Connector {
  return {
    id: "skill_module",
    query: (target) => querySkillModule(resolve, target),
  };
}

export const DEFAULT_QUERY_CONNECTOR = DEFAULT_CONNECTOR;
