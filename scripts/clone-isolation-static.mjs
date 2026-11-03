#!/usr/bin/env node
/**
 * Fast static clone-isolation check.
 *
 * Every game package must declare ports (and, through them, the server name
 * and data dir Home rewrites per server). Launch files may repeat that
 * package's own identity only as an env fallback. A hardcoded name, port, or
 * path a clone would inherit fails the check. Foreign identity (another
 * server's name, the live NZL ports, or servers/<other>/) cannot be allowlisted.
 *
 *   node scripts/clone-isolation-static.mjs --catalog
 *   node scripts/clone-isolation-static.mjs --root ../playon-games/packages-src/games
 *   pnpm lab:clone-isolation-static
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadCatalog, siblingGamesRoot } from "./clone-isolation/catalog.mjs";
import {
  evaluatePackage,
  formatStaticReport,
  listPackages,
  loadAllowlist,
} from "./clone-isolation/scan.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const allowlistPath = path.join(repoRoot, "scripts", "clone-isolation-allowlist.json");

function parseArgs(argv) {
  const out = { catalog: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--catalog") out.catalog = true;
    else if (arg === "--verbose") out.verbose = true;
    else if (arg === "--root" || arg === "--cache" || arg === "--catalog-url" || arg === "--skill") {
      out[arg.slice(2)] = argv[++i];
    } else {
      console.error(`unknown argument ${arg}`);
      process.exit(2);
    }
  }
  return out;
}

function help() {
  console.log(`Usage: node scripts/clone-isolation-static.mjs [--catalog | --root <games>] [--skill games.id]

Reads scripts/clone-isolation-allowlist.json. Own-identity fallbacks are allowed.
Foreign server names, foreign ports, and foreign jails fail closed.
`);
}

async function resolveRoot(args) {
  if (args.root) return path.resolve(args.root);
  const sibling = siblingGamesRoot(repoRoot);
  if (sibling && !args.catalog) return sibling;
  const cache = path.resolve(args.cache || path.join(repoRoot, "tmp", "clone-isolation-catalog"));
  console.log(`downloading catalog into ${cache}`);
  await downloadCatalog(cache, args["catalog-url"]);
  return cache;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    help();
    return;
  }
  const allowlist = loadAllowlist(allowlistPath);
  const root = await resolveRoot(args);
  let packages = listPackages(root);
  if (args.skill) packages = packages.filter((pkg) => pkg.metadata.name === args.skill);
  if (!packages.length) {
    console.error(`no game packages under ${root}`);
    process.exit(1);
  }
  const results = packages.map((pkg) => {
    const evaluated = evaluatePackage(pkg, allowlist);
    return { name: pkg.metadata.name, ...evaluated };
  });
  const extraStale = [];
  if (!args.skill && packages.length >= 100) {
    const seen = new Set(results.map((result) => result.name));
    for (const name of Object.keys(allowlist)) {
      if (!seen.has(name)) extraStale.push(name);
    }
  }
  const report = formatStaticReport(results);
  const waived = results.reduce((sum, result) => sum + result.waived.length, 0);
  const failed = results.filter((result) => result.findings.length || result.stale.length);
  if (args.verbose) {
    for (const result of results) {
      const id = result.identity;
      console.log(
        `${result.name} name=${id.serverName.env ?? id.serverName.own ?? "-"} ` +
          `ports=${id.ports.map((port) => `${port.name}:${port.port}${port.rewritable ? "" : "!"}`).join(",") || "-"} ` +
          `data=${id.dataDir.scope}`,
      );
    }
  }
  console.log(
    `clone-isolation static: ${results.length} package(s), ` +
      `${failed.length} failing, ${waived} allowlisted own-default literal(s), ` +
      `${Object.keys(allowlist).length} allowlist entries`,
  );
  if (report) console.error(report);
  for (const name of extraStale) {
    console.error(`stale_allowlist: ${name} is not in this catalog; remove it from the allowlist`);
  }
  if (failed.length || extraStale.length) {
    console.error(
      "\nA clone would inherit the literals above, or the allowlist is out of date. " +
        "Read the port from PLAYON_GAME_PORT (and the name / data dir from PLAYON_SERVER_NAME / PLAYON_HOME), " +
        "keeping this package's own value only as the fallback. " +
        "Waive inherited_port / inherited_name / inherited_path in scripts/clone-isolation-allowlist.json " +
        "only with a justification. Foreign identity cannot be waived.",
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
