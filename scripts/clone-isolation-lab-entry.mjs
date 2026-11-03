#!/usr/bin/env node
/**
 * Argument gate for the self-hosted clone-isolation workflow.
 * Workflow inputs are untrusted strings; this accepts only a host, a
 * games.* list, integers, and the home mode before spawning the live check.
 *
 *   CLONE_HOST=linux node scripts/clone-isolation-lab-entry.mjs
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

export function labEntryArgs(env = process.env) {
  const host = String(env.CLONE_HOST ?? "").trim();
  const skill = String(env.CLONE_SKILL ?? "").trim();
  const limit = String(env.CLONE_LIMIT ?? "0").trim();
  const portBase = String(env.CLONE_PORT_BASE ?? "0").trim();
  const home = String(env.CLONE_HOME ?? "off").trim();
  const homeStart = String(env.CLONE_HOME_START ?? "false").trim();

  if (host !== "linux" && host !== "windows" && host !== "all") {
    throw new Error("CLONE_HOST must be linux, windows, or all");
  }
  if (skill && !/^games\.[a-z0-9._-]+(?:,games\.[a-z0-9._-]+)*$/i.test(skill)) {
    throw new Error("CLONE_SKILL must be a comma-separated list of games.* ids");
  }
  if (!/^\d+$/.test(limit) || !/^\d+$/.test(portBase)) {
    throw new Error("CLONE_LIMIT and CLONE_PORT_BASE must be non-negative integers");
  }
  if (home !== "off" && home !== "auto" && home !== "on") {
    throw new Error("CLONE_HOME must be off, auto, or on");
  }
  if (homeStart !== "true" && homeStart !== "false") {
    throw new Error("CLONE_HOME_START must be true or false");
  }

  const args = ["--catalog", "--host", host, "--home", home, "--report", path.join("tmp", `clone-isolation-${host}.json`)];
  if (skill) args.push("--skill", skill);
  if (limit !== "0") args.push("--limit", limit);
  if (portBase !== "0") args.push("--port-base", portBase);
  if (homeStart === "true") args.push("--home-start");
  return args;
}

function main() {
  const args = labEntryArgs(process.env);
  fs.mkdirSync("tmp", { recursive: true });
  const child = spawnSync(process.execPath, [path.join(scriptDir, "clone-isolation-live.mjs"), ...args], {
    stdio: "inherit",
  });
  process.exit(child.status ?? 1);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main();
