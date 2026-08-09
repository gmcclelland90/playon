#!/usr/bin/env node
/**
 * Publish a short “Lab now” card to the sticky GitHub issue labeled `lab-status`.
 * Detailed skill tables live in Actions summaries / lab-report artifacts / issue comments.
 *
 *   node scripts/lab-publish-status.mjs
 *   node scripts/lab-publish-status.mjs --force
 *   node scripts/lab-publish-status.mjs --force --history-comment
 *
 * Env:
 *   PLAYON_LAB_PUBLISH_STATUS=0  disable
 *   PLAYON_LAB_PUBLISH_MIN_MS    throttle (default 90000)
 *   PLAYON_LAB_RUN_URL           optional link to Actions run / report
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const repo = process.env.PLAYON_GITHUB_REPO || "gmcclelland90/playon";
const force = process.argv.includes("--force");
const historyComment = process.argv.includes("--history-comment");
const minMs = Number(process.env.PLAYON_LAB_PUBLISH_MIN_MS || 90_000);
const throttlePath = join(root, "tmp", "lab-publish-status.throttle.json");
const STATUS_ISSUE_TITLE = "[lab] Live status";

function enabled() {
  const v = (process.env.PLAYON_LAB_PUBLISH_STATUS ?? "1").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "off" && v !== "no";
}

function gh(argv) {
  const r = spawnSync("gh", argv, {
    cwd: root,
    encoding: "utf8",
    shell: false,
    env: process.env,
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    ok: (r.status ?? 1) === 0,
    stdout: (r.stdout ?? "").trim(),
    stderr: (r.stderr ?? "").trim(),
  };
}

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function throttleOk() {
  if (force) return true;
  const prev = readJson(throttlePath);
  if (!prev?.at) return true;
  return Date.now() - Date.parse(prev.at) >= minMs;
}

function markThrottle() {
  mkdirSync(join(root, "tmp"), { recursive: true });
  writeFileSync(
    throttlePath,
    `${JSON.stringify({ at: new Date().toISOString() }, null, 2)}\n`,
  );
}

function findStatusIssue() {
  const listed = gh([
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--label",
    "lab-status",
    "--limit",
    "5",
    "--json",
    "number,title,url",
  ]);
  if (!listed.ok) {
    console.error(listed.stderr || listed.stdout);
    return null;
  }
  const items = JSON.parse(listed.stdout || "[]");
  return items[0] || null;
}

function ensureStatusIssue(body) {
  const existing = findStatusIssue();
  if (existing) return existing;
  const created = gh([
    "issue",
    "create",
    "--repo",
    repo,
    "--title",
    STATUS_ISSUE_TITLE,
    "--label",
    "lab-status",
    "--label",
    "lab",
    "--label",
    "chore",
    "--body",
    body,
  ]);
  if (!created.ok) {
    console.error(created.stderr || created.stdout);
    return null;
  }
  const number = Number((created.stdout.match(/\/issues\/(\d+)/) || [])[1]);
  console.log(`created status issue ${created.stdout}`);
  return { number, url: created.stdout, title: STATUS_ISSUE_TITLE };
}

function main() {
  if (!enabled()) {
    console.log("PLAYON_LAB_PUBLISH_STATUS disabled; skip");
    process.exit(0);
  }
  if (!throttleOk()) {
    console.log("throttled; skip publish");
    process.exit(0);
  }
  const auth = gh(["auth", "status"]);
  if (!auth.ok) {
    console.error("gh not authenticated; skip publish");
    process.exit(0);
  }

  gh([
    "label",
    "create",
    "lab-status",
    "--repo",
    repo,
    "--color",
    "0e8a16",
    "--description",
    "Sticky live lab status issue",
  ]);

  // Generate report artifacts + now card
  const report = spawnSync(
    process.execPath,
    [
      join(root, "scripts", "lab-report.mjs"),
      "--title",
      process.env.PLAYON_LAB_REPORT_TITLE || "Lab report",
    ],
    { cwd: root, encoding: "utf8", env: process.env },
  );
  if (report.stdout) console.log(report.stdout.trimEnd());
  if (report.status !== 0) {
    console.error(report.stderr || "lab-report failed");
  }

  const nowPath = join(root, "tmp", "lab-now.md");
  const detailPath = join(root, "tmp", "lab-report.md");
  if (!existsSync(nowPath)) {
    console.error("missing tmp/lab-now.md");
    process.exit(0);
  }
  const body = readFileSync(nowPath, "utf8");

  const issue = ensureStatusIssue(body);
  if (!issue?.number) process.exit(0);

  const edited = gh([
    "issue",
    "edit",
    String(issue.number),
    "--repo",
    repo,
    "--body",
    body,
  ]);
  if (!edited.ok) {
    console.error(edited.stderr || edited.stdout);
    process.exit(0);
  }

  if (historyComment && existsSync(detailPath)) {
    const detail = readFileSync(detailPath, "utf8");
    const comment = [
      `### Cadence tick \`${new Date().toISOString()}\``,
      "",
      detail,
    ].join("\n");
    const c = gh([
      "issue",
      "comment",
      String(issue.number),
      "--repo",
      repo,
      "--body",
      comment,
    ]);
    if (!c.ok) console.error(c.stderr || c.stdout);
    else console.log(`history comment on #${issue.number}`);
  }

  markThrottle();
  const url =
    issue.url || `https://github.com/${repo}/issues/${issue.number}`;
  console.log(`published ${url}`);
}

main();
