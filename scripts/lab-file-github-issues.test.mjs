#!/usr/bin/env node
/**
 * Unit tests for lab GitHub filing helpers (fingerprint-by-skill, steamcmd classes).
 * Run: node scripts/lab-file-github-issues.test.mjs
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  classifyMatrixErrorClass,
  collectLatestMatrixRows,
  failRowFromStatusResult,
  fingerprintMarker,
  groupSkillCloneIssues,
  issueMatchesSkill,
  mapErrorClass,
  matrixFingerprint,
  priorForMatrixSkill,
  skillFromLabIssue,
} from "./lab-file-github-issues.mjs";

assert.equal(matrixFingerprint("games.fistful-of-frags"), "matrix:games.fistful-of-frags");
assert.equal(matrixFingerprint("games.fistful-of-frags").includes("port_open"), false);
assert.equal(
  fingerprintMarker(matrixFingerprint("games.rust")),
  "<!-- playon-lab-fingerprint: matrix:games.rust -->",
);

const skill = "games.valheim";
const fp = matrixFingerprint(skill);
for (const phase of ["start", "port_open", "query"]) {
  const row = failRowFromStatusResult({
    ok: false,
    skipped: false,
    skillName: skill,
    phases: { [phase]: "fail" },
    tail: `${phase} failed`,
  });
  assert.equal(row.phase, phase);
  assert.equal(matrixFingerprint(row.skill), fp);
}

const rustIssue = {
  number: 1,
  title: "[skill] games.rust: lab matrix failed",
  body: "<!-- playon-lab-fingerprint: matrix:games.rust -->\n",
};
const experimental = {
  number: 2,
  title: "[skill] games.rust-experimental: port_open failed (lifecycle_fail)",
  body: "<!-- playon-lab-fingerprint: matrix:games.rust-experimental:port_open:lifecycle_fail -->\n",
};
assert.equal(issueMatchesSkill(rustIssue, "games.rust"), true);
assert.equal(issueMatchesSkill(experimental, "games.rust"), false);
assert.equal(issueMatchesSkill(rustIssue, "games.rust-experimental"), false);
assert.equal(skillFromLabIssue(experimental), "games.rust-experimental");

const legacy = {
  number: 731,
  title: "[skill] games.rust: port_open failed (lifecycle_fail)",
  body: "<!-- playon-lab-fingerprint: matrix:games.rust:port_open:lifecycle_fail -->\n",
};
assert.equal(issueMatchesSkill(legacy, "games.rust"), true);
assert.equal(skillFromLabIssue(legacy), "games.rust");

assert.equal(
  classifyMatrixErrorClass({
    phase: "install",
    tail: "steamcmd_timeout: exceeded 1800000ms",
  }),
  "steamcmd_timeout",
);
assert.equal(
  classifyMatrixErrorClass({
    phase: "install",
    tail: "steamcmd_empty_depot: appId=1180760 EmptySteamDepot SizeOnDisk=0",
  }),
  "steamcmd_empty_depot",
);
assert.equal(
  classifyMatrixErrorClass({
    skipReason: "steamcmd_no_subscription",
    tail: "No subscription",
  }),
  "steamcmd_no_subscription",
);
assert.equal(
  classifyMatrixErrorClass({ phase: "static", tail: "missing_ports" }),
  "skill_bug",
);
assert.equal(
  classifyMatrixErrorClass({
    phase: "port_open",
    tail: "port_not_open: game:27015",
    errorClass: "lifecycle_fail",
  }),
  "lifecycle_fail",
);

assert.deepEqual(mapErrorClass("steamcmd_timeout"), {
  type: "bug",
  priority: "P1",
  extra: ["runtime"],
});
assert.deepEqual(mapErrorClass("steamcmd_empty_depot"), {
  type: "chore",
  priority: "P3",
  extra: ["runtime"],
});
assert.deepEqual(mapErrorClass("steamcmd_no_subscription"), {
  type: "chore",
  priority: "P3",
  extra: ["runtime"],
});
assert.deepEqual(mapErrorClass("lifecycle_fail"), {
  type: "skill",
  priority: "P2",
});

const timeout = failRowFromStatusResult({
  ok: false,
  skipped: false,
  skillName: "games.ark",
  phases: { install: "fail" },
  tail: "steamcmd_timeout: exceeded 1800000ms",
});
assert.equal(timeout.skill, "games.ark");
assert.equal(timeout.phase, "install");
assert.equal(timeout.errorClass, "steamcmd_timeout");

assert.equal(
  failRowFromStatusResult({
    ok: true,
    skipped: true,
    skipReason: "steamcmd_no_subscription",
    skillName: "games.arma3",
    phases: { install: "skipped" },
    tail: "steamcmd_no_subscription: appId=233780",
  }),
  null,
);
assert.equal(
  failRowFromStatusResult({
    ok: true,
    skipped: true,
    skipReason: "steamcmd_empty_depot",
    skillName: "games.risk-of-rain-2",
    phases: { install: "skipped" },
    tail: "steamcmd_empty_depot: appId=1180760",
  }),
  null,
);

const emptyFail = failRowFromStatusResult({
  ok: false,
  skipped: false,
  skillName: "games.risk-of-rain-2",
  phases: { install: "fail" },
  tail: "steamcmd_empty_depot: appId=1180760 SizeOnDisk=0",
});
assert.equal(emptyFail.errorClass, "steamcmd_empty_depot");
assert.equal(emptyFail.skill, "games.risk-of-rain-2");

const rows = collectLatestMatrixRows([
  {
    skill: "games.stormworks",
    phase: "install",
    errorClass: "lifecycle_fail",
    at: "2026-08-12T10:00:00.000Z",
    tail: "old install",
  },
  {
    skill: "games.stormworks",
    phase: "port_open",
    errorClass: "lifecycle_fail",
    at: "2026-08-12T12:00:00.000Z",
    tail: "port_not_open",
  },
  {
    skill: "games.valheim",
    phase: "query",
    errorClass: "lifecycle_fail",
    at: "2026-08-12T11:00:00.000Z",
    tail: "query_offline",
  },
]);
assert.equal(rows.length, 2);
const stormworks = rows.find((r) => r.skill === "games.stormworks");
assert.equal(stormworks.phase, "port_open");
assert.equal(stormworks.tail, "port_not_open");

const groups = groupSkillCloneIssues([
  {
    number: 731,
    title: "[skill] games.rust: port_open failed (lifecycle_fail)",
    body: "<!-- playon-lab-fingerprint: matrix:games.rust:port_open:lifecycle_fail -->",
  },
  {
    number: 630,
    title: "[skill] games.rust: start failed (lifecycle_fail)",
    body: "<!-- playon-lab-fingerprint: matrix:games.rust:start:lifecycle_fail -->",
  },
  {
    number: 800,
    title: "[chore] lab:loop:verify failed at layer unit",
    body: "<!-- playon-lab-fingerprint: verify:merge:unit -->",
  },
  {
    number: 50,
    title: "[skill] games.valheim: lab matrix failed",
    body: "<!-- playon-lab-fingerprint: matrix:games.valheim -->",
  },
]);
assert.equal(groups.length, 1);
assert.equal(groups[0].skill, "games.rust");
assert.equal(groups[0].keep.number, 630);
assert.deepEqual(
  groups[0].close.map((i) => i.number),
  [731],
);

assert.equal(
  priorForMatrixSkill(
    {
      fingerprints: {
        "matrix:games.stormworks:install:lifecycle_fail": { number: 598 },
      },
    },
    "games.stormworks",
  )?.number,
  598,
);
assert.equal(
  priorForMatrixSkill(
    { fingerprints: { "matrix:games.valheim": { number: 12 } } },
    "games.valheim",
  )?.number,
  12,
);

console.log("ok", pathBasename(fileURLToPath(import.meta.url)));

function pathBasename(p) {
  return p.split("/").pop();
}
