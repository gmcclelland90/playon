#!/usr/bin/env node
/**
 * Live clone-isolation check for every game package this host can run.
 *
 *   pnpm lab:clone-isolation -- --dry-run
 *   pnpm lab:clone-isolation -- --catalog
 *   pnpm lab:clone-isolation -- --root ../playon-games/packages-src/games --skill games.valheim
 *   PLAYON_LAB_HOME_SESSION=... pnpm lab:clone-isolation -- --home on
 *
 * Default binds loopback stand-ins on each package's declared ports, serially,
 * then deletes them. It does not kill whoever already holds a port.
 * Set PLAYON_PRODUCTION_HOST=1 on a production machine so this refuses to start.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadCatalog, siblingGamesRoot } from "./clone-isolation/catalog.mjs";
import { dryRunPlans, runHomePhase, runStandinMatrix, selectPackages } from "./clone-isolation/live.mjs";
import { listPackages, packageRunsOn } from "./clone-isolation/scan.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const out = { catalog: false, home: "off", host: process.platform === "win32" ? "windows" : "linux" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--catalog") out.catalog = true;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--home-start") out.homeStart = true;
    else if (
      arg === "--root" ||
      arg === "--cache" ||
      arg === "--catalog-url" ||
      arg === "--skill" ||
      arg === "--limit" ||
      arg === "--shard" ||
      arg === "--host" ||
      arg === "--home" ||
      arg === "--port-base" ||
      arg === "--report" ||
      arg === "--home-api"
    ) {
      out[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
    } else {
      console.error(`unknown argument ${arg}`);
      process.exit(2);
    }
  }
  return out;
}

function help() {
  console.log(`Usage: node scripts/clone-isolation-live.mjs [--dry-run] [--catalog | --root <games>]
          [--host linux|windows|all] [--skill games.id] [--limit N] [--shard 1/4]
          [--port-base 40000] [--home off|auto|on] [--home-start] [--report tmp/clone-isolation-live.json]

--dry-run prints the isolate/refuse plan and does not bind ports or talk to Home.
--home on requires PLAYON_LAB_HOME_SESSION and a lab Home (not one hosting NZL / Hub / Frontier).
--home auto runs that phase only when the session is set.
`);
}

async function resolveRoot(args) {
  if (args.root) return path.resolve(args.root);
  const sibling = siblingGamesRoot(repoRoot);
  if (sibling && !args.catalog) return sibling;
  const cache = path.resolve(args.cache || path.join(repoRoot, "tmp", "clone-isolation-catalog"));
  console.log(`downloading catalog into ${cache}`);
  await downloadCatalog(cache, args.catalogUrl);
  return cache;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    help();
    return;
  }
  if (process.env.PLAYON_PRODUCTION_HOST === "1") {
    console.error(
      "PLAYON_PRODUCTION_HOST=1: this machine is marked as production. " +
        "Clone isolation must run on a lab runner (playon-lab-linux / playon-lab-windows), " +
        "not the host that serves live player servers.",
    );
    process.exit(2);
  }
  const root = await resolveRoot(args);
  const packages = selectPackages(listPackages(root), {
    host: args.dryRun ? "all" : args.host,
    skill: args.skill,
    limit: args.limit,
    shard: args.shard,
    packageRunsOn,
  });
  if (!packages.length) {
    console.error(`no packages selected under ${root} (host=${args.host})`);
    process.exit(1);
  }
  console.log(
    `clone-isolation: ${packages.length} package(s) host=${args.dryRun ? "all" : args.host} ` +
      `mode=${args.dryRun ? "dry-run" : "stand-in"}`,
  );

  let results;
  if (args.dryRun) {
    results = dryRunPlans(packages).map((plan) => ({
      ok: true,
      name: plan.name,
      action: plan.action,
      error: plan.error,
      livePort: plan.livePort,
      clonePort: plan.clonePort,
    }));
    const isolate = results.filter((row) => row.action === "isolate").length;
    const refuse = results.filter((row) => row.action === "refuse").length;
    console.log(`dry-run: isolate=${isolate} refuse=${refuse} (refuse means the clone is not started)`);
    for (const row of results) {
      if (row.action === "refuse") console.log(`refuse ${row.name}: ${row.error}`);
    }
  } else {
    results = await runStandinMatrix(packages, {
      portBase: args.portBase ? Number(args.portBase) : 0,
      continueOnFail: true,
      onResult: (row) => {
        if (row.ok) console.log(`${row.action} ${row.name}`);
        else console.error(`FAIL ${row.name}: ${row.error}`);
      },
    });
  }

  const homeMode = args.home ?? "off";
  let homeResults = [];
  if (!args.dryRun && homeMode !== "off") {
    const session = process.env.PLAYON_LAB_HOME_SESSION?.trim();
    const api = args.homeApi || process.env.PLAYON_LAB_HOME_API || "http://127.0.0.1:8787";
    if (!session) {
      const message =
        "home phase skipped: set PLAYON_LAB_HOME_SESSION to a lab Home operator cookie. " +
        "Do not point this at the production Home that serves live players.";
      if (homeMode === "on") {
        console.error(message);
        process.exit(1);
      }
      console.log(message);
    } else {
      console.log(`home phase ${api} start=${args.homeStart ? "yes" : "create-only"}`);
      homeResults = await runHomePhase({
        api,
        session,
        packages,
        start: Boolean(args.homeStart),
      });
      for (const row of homeResults) {
        if (row.ok) console.log(`home ${row.action} ${row.name}${row.error ? ` (${row.error})` : ""}`);
        else console.error(`home FAIL ${row.name}: ${row.error}`);
      }
    }
  }

  const failed = [...results, ...homeResults].filter((row) => row.ok === false);
  const report = {
    ok: failed.length === 0,
    host: args.host,
    dryRun: Boolean(args.dryRun),
    results,
    home: homeResults,
  };
  if (args.report) {
    fs.mkdirSync(path.dirname(path.resolve(args.report)), { recursive: true });
    fs.writeFileSync(path.resolve(args.report), JSON.stringify(report, null, 2));
  }
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
