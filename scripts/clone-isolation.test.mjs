#!/usr/bin/env node
/**
 * Unit + stand-in coverage for clone isolation.
 * Run: node scripts/clone-isolation.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertHomeIsLab,
  assertLabServerName,
  dryRunPlans,
  isLivePlayerName,
  runHomePhase,
  runPackageIsolation,
  selectPackages,
} from "./clone-isolation/live.mjs";
import { labEntryArgs } from "./clone-isolation-lab-entry.mjs";
import {
  evaluatePackage,
  loadAllowlist,
  planClone,
  scanPackage,
  scanServerScript,
} from "./clone-isolation/scan.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const allowlistPath = path.join(repoRoot, "scripts", "clone-isolation-allowlist.json");

function pkg(name, ports, files, extra = {}) {
  return {
    metadata: {
      name,
      game: name,
      os: extra.os ?? ["linux", "windows"],
      containerSupport: extra.containerSupport ?? "none",
      dockerDataMount: extra.dockerDataMount ?? "",
      preferStartScript: true,
      nativeArgs: [],
      dockerArgs: extra.dockerArgs ?? [],
      dockerEnv: extra.dockerEnv ?? [],
      ports,
    },
    files,
  };
}

const rewritable = pkg(
  "games.example-rewritable",
  [{ name: "game", protocol: "udp", port: 45111 }],
  {
    "files/start.sh":
      'NAME="${PLAYON_SERVER_NAME:-Example}"\nPORT="${PLAYON_GAME_PORT:-45111}"\n' +
      'HOME="${PLAYON_HOME:-../home}"\nexec ./game -name "$NAME" -port "$PORT"\n',
  },
);

const inherited = pkg(
  "games.example-inherited",
  [{ name: "game", protocol: "udp", port: 45121 }],
  { "files/start.sh": "exec ./game -port 45121 -name PlayOnExample\n" },
);

const foreignPackage = pkg(
  "games.example-foreign",
  [{ name: "game", protocol: "udp", port: 45131 }],
  {
    "files/start.sh":
      'NAME="${PLAYON_SERVER_NAME:-NewZombieLand3}"\nPORT="${PLAYON_GAME_PORT:-45131}"\nexec ./game -name "$NAME" -port "$PORT"\n',
  },
);

const ownServer = scanServerScript({
  serverId: "nzl",
  serverName: "NewZombieLand3",
  ports: [16261, 16262],
  dataDir: "/data/servers/nzl/home",
  filename: "start.sh",
  text: [
    'NAME="${PLAYON_SERVER_NAME:-NewZombieLand3}"',
    'PORT="${PLAYON_GAME_PORT:-16261}"',
    'UDPPORT="${PLAYON_DIRECT_PORT:-16262}"',
    'exec ./ProjectZomboid64 -servername "$NAME" -port "$PORT" -udpport "$UDPPORT" -cachedir "$PLAYON_HOME"',
    "",
  ].join("\n"),
});
assert.equal(ownServer.findings.length, 0, JSON.stringify(ownServer.findings));

const foreignServer = scanServerScript({
  serverId: "clone",
  serverName: "NZL-Clone-Frontier-RD",
  ports: [16361, 16362],
  dataDir: "/data/servers/clone/home",
  filename: "start.sh",
  text: [
    'NAME="${PLAYON_SERVER_NAME:-NewZombieLand3}"',
    "exec ./ProjectZomboid64 -servername \"$NAME\" -cachedir /data/servers/nzl/home",
    "",
  ].join("\n"),
});
assert.ok(foreignServer.findings.some((item) => item.kind === "foreign_name"));
assert.ok(foreignServer.findings.some((item) => item.kind === "foreign_path"));

const ownHardcode = scanServerScript({
  serverId: "clone",
  serverName: "NZLCloneFrontierRD",
  ports: [16361],
  dataDir: "/data/servers/clone/home",
  filename: "start.sh",
  text: 'exec ./game -servername NZLCloneFrontierRD -port 16361 -cachedir /data/servers/clone/home\n',
});
assert.equal(ownHardcode.findings.length, 0, JSON.stringify(ownHardcode.findings));

assert.equal(scanPackage(rewritable).findings.length, 0);
assert.equal(planClone(rewritable).action, "isolate");
assert.notEqual(planClone(rewritable).live.dataDir, planClone(rewritable).clone.dataDir);
assert.notEqual(planClone(rewritable).live.ports[0].port, planClone(rewritable).clone.ports[0].port);

const inheritedPlan = planClone(inherited);
assert.equal(inheritedPlan.action, "refuse");
assert.match(inheritedPlan.error, /start_port_collision|start_identity_collision/);

const foreignPlan = planClone(foreignPackage);
assert.equal(foreignPlan.action, "refuse");
assert.match(foreignPlan.error, /start_identity_collision/);
assert.match(foreignPlan.error, /NewZombieLand3/);

const waivedForeign = evaluatePackage(foreignPackage, {
  "games.example-foreign": {
    findings: ["foreign_name"],
    justification: "this must not waive a foreign live-server name even if someone tries",
  },
});
assert.ok(waivedForeign.findings.some((item) => item.kind === "foreign_name"));

const allowInherited = evaluatePackage(inherited, {
  "games.example-inherited": {
    findings: ["inherited_port", "inherited_name"],
    justification: "package's own port and name, not another server, until the overlay reads PLAYON_GAME_PORT",
  },
});
assert.equal(allowInherited.findings.length, 0);
assert.equal(allowInherited.waived.length, 2);

const stale = evaluatePackage(rewritable, {
  "games.example-rewritable": {
    findings: ["inherited_port"],
    justification: "this waiver is stale because the package no longer hardcodes a port",
  },
});
assert.deepEqual(stale.stale, ["inherited_port"]);

assert.throws(
  () =>
    loadAllowlist(
      writeTempAllowlist({
        "games.bad": { findings: ["foreign_name"], justification: "x".repeat(50) },
      }),
    ),
  /cannot waive foreign_name/,
);
assert.throws(
  () =>
    loadAllowlist(
      writeTempAllowlist({
        "games.bad": { findings: ["inherited_port"], justification: "too short" },
      }),
    ),
  /too short/,
);

const committed = loadAllowlist(allowlistPath);
for (const [name, entry] of Object.entries(committed)) {
  assert.ok(entry.justification.length >= 40, name);
  assert.ok(!/todo|fixme/i.test(entry.justification), name);
  for (const kind of entry.findings) {
    assert.ok(["inherited_port", "inherited_name", "inherited_path"].includes(kind), `${name} ${kind}`);
  }
}

assert.equal(isLivePlayerName("NewZombieLand3"), true);
assert.equal(isLivePlayerName("lab-clone-project-zomboid"), false);
assert.throws(() => assertHomeIsLab([{ id: "nzl", name: "Hub" }]), /live player server/);
assert.doesNotThrow(() => assertHomeIsLab([{ id: "a", name: "lab-live-valheim" }]));
assert.throws(() => assertLabServerName("NewZombieLand3"), /refusing to create or delete/);

const selected = selectPackages(
  [
    pkg("games.linux-only", [{ name: "game", protocol: "udp", port: 1 }], {}, { os: ["linux"] }),
    pkg("games.windows-only", [{ name: "game", protocol: "udp", port: 2 }], {}, { os: ["windows"] }),
    pkg(
      "games.docker-both",
      [{ name: "game", protocol: "tcp", port: 3 }],
      {},
      { os: ["linux"], containerSupport: "full", dockerDataMount: "/data" },
    ),
  ],
  {
    host: "windows",
    packageRunsOn: (metadata, host) => {
      const os = metadata.os ?? [];
      if (host === "windows") return os.includes("windows") || metadata.containerSupport === "full";
      return os.includes("linux");
    },
  },
);
assert.deepEqual(
  selected.map((item) => item.metadata.name),
  ["games.windows-only", "games.docker-both"],
);

const plans = dryRunPlans([rewritable, inherited]);
assert.equal(plans[0].action, "isolate");
assert.equal(plans[1].action, "refuse");
assert.ok(plans.every((plan) => plan.ok !== false));

const before = leftovers();
const isolated = await runPackageIsolation(rewritable);
assert.equal(isolated.ok, true);
assert.equal(isolated.action, "isolate");
assert.notEqual(isolated.livePid, isolated.clonePid);
const refused = await runPackageIsolation(inherited);
assert.equal(refused.ok, true);
assert.equal(refused.action, "refuse");
assert.match(refused.error, /45121/);
assert.equal(leftovers().length, before.length);

const previous = process.env.PLAYON_PRODUCTION_HOST;
process.env.PLAYON_PRODUCTION_HOST = "1";
await assert.rejects(() => runPackageIsolation(rewritable), /PLAYON_PRODUCTION_HOST/);
if (previous == null) delete process.env.PLAYON_PRODUCTION_HOST;
else process.env.PLAYON_PRODUCTION_HOST = previous;

const calls = [];
const homePackages = [rewritable];
const session = "lab-session";
const fetchImpl = async (url, init = {}) => {
  calls.push({ url, method: init.method ?? "GET", body: init.body });
  const header = init.headers?.cookie ?? "";
  assert.match(header, /playon_session=lab-session/);
  if (url.endsWith("/api/servers") && (init.method ?? "GET") === "GET") {
    return json(200, { servers: [{ id: "keep", name: "lab-matrix-existing" }] });
  }
  if (url.endsWith("/api/skills")) {
    return json(200, { skills: [{ name: "games.example-rewritable" }] });
  }
  if (url.endsWith("/api/servers") && init.method === "POST") {
    const body = JSON.parse(init.body);
    assertLabServerName(body.serverName);
    const id = body.serverName.includes("clone") ? "id-clone" : "id-live";
    return json(200, {
      server: {
        id,
        name: body.serverName,
        dataPath: path.join(os.tmpdir(), "playon-home-phase", id),
      },
    });
  }
  if (url.endsWith("/api/snapshots")) return json(200, { snapshot: { id: "snap-1" } });
  if (url.endsWith("/start")) return json(400, { error: "start_port_collision: game port in use" });
  if (init.method === "DELETE") {
    assert.ok(/\/api\/servers\/id-(live|clone)$/.test(url), url);
    return json(200, { ok: true });
  }
  return json(500, { error: `unexpected ${url}` });
};
fs.mkdirSync(path.join(os.tmpdir(), "playon-home-phase", "id-live"), { recursive: true });
fs.mkdirSync(path.join(os.tmpdir(), "playon-home-phase", "id-clone"), { recursive: true });
const home = await runHomePhase({
  api: "http://127.0.0.1:8787",
  session,
  packages: homePackages,
  fetchImpl,
  start: false,
});
assert.equal(home[0].ok, true);
assert.ok(calls.some((call) => call.method === "DELETE" && call.url.endsWith("/id-live")));
assert.ok(calls.some((call) => call.method === "DELETE" && call.url.endsWith("/id-clone")));
const unsafe = async (url) => {
  if (url.endsWith("/api/servers")) return json(200, { servers: [{ id: "nzl", name: "NewZombieLand3" }] });
  return json(500, { error: "should not be called" });
};
await assert.rejects(
  () => runHomePhase({ api: "http://127.0.0.1:8787", session, packages: homePackages, fetchImpl: unsafe }),
  /NewZombieLand3/,
);
fs.rmSync(path.join(os.tmpdir(), "playon-home-phase"), { recursive: true, force: true });

const entry = labEntryArgs({ CLONE_HOST: "linux" });
assert.deepEqual(entry.slice(0, 5), ["--catalog", "--host", "linux", "--home", "off"]);
assert.equal(entry.includes("--home-start"), false);
assert.equal(entry.includes("--skill"), false);
const narrowed = labEntryArgs({
  CLONE_HOST: "windows",
  CLONE_SKILL: "games.valheim,games.project-zomboid",
  CLONE_LIMIT: "2",
  CLONE_PORT_BASE: "40000",
  CLONE_HOME: "auto",
  CLONE_HOME_START: "true",
});
assert.ok(narrowed.includes("--skill"));
assert.ok(narrowed.includes("games.valheim,games.project-zomboid"));
assert.ok(narrowed.includes("--port-base"));
assert.ok(narrowed.includes("--home-start"));
assert.throws(() => labEntryArgs({ CLONE_HOST: "linux", CLONE_SKILL: "games.ok;rm" }), /CLONE_SKILL/);
assert.throws(() => labEntryArgs({ CLONE_HOST: "linux", CLONE_HOME: "production" }), /CLONE_HOME/);
assert.throws(() => labEntryArgs({ CLONE_HOST: "playon-dev" }), /CLONE_HOST/);

console.log("clone-isolation.test.mjs ok");

function leftovers() {
  return fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("playon-clone-isolation-"));
}

function writeTempAllowlist(value) {
  const file = path.join(os.tmpdir(), `playon-allowlist-${Date.now()}-${Math.random()}.json`);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

function json(status, body) {
  return {
    status,
    text: async () => JSON.stringify(body),
  };
}
