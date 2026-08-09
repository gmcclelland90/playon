#!/usr/bin/env node
/**
 * Publish lab verify + matrix visibility to a sticky GitHub Issue
 * Publishes lab verify + matrix visibility to the sticky GitHub Issue
 * labeled `lab-status` (GitHub cockpit; no local HTTP dashboard).
 *
 *   node scripts/lab-publish-status.mjs
 *   node scripts/lab-publish-status.mjs --force
 *
 * Finds/creates the open issue labeled `lab-status` on PLAYON_GITHUB_REPO
 * and replaces its body with a live markdown summary.
 *
 * Env:
 *   PLAYON_LAB_PUBLISH_STATUS=0  disable
 *   PLAYON_LAB_PUBLISH_MIN_MS    throttle (default 90000)
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const repo = process.env.PLAYON_GITHUB_REPO || "gmcclelland90/playon";
const force = process.argv.includes("--force");
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

function summarizeMatrix(status) {
  const results = status?.results ?? [];
  const requested = status?.skillsRequested?.length ?? results.length;
  let ok = 0;
  let fail = 0;
  let skip = 0;
  for (const r of results) {
    if (r.skipped) skip += 1;
    else if (r.ok) ok += 1;
    else fail += 1;
  }
  return {
    requested,
    done: results.length,
    ok,
    fail,
    skip,
    pct: requested ? Math.round((results.length / requested) * 1000) / 10 : 0,
    current: results.length ? results[results.length - 1] : null,
    failedSkill: status?.failedSkill ?? null,
    mode: status?.mode ?? null,
    startedAt: status?.startedAt ?? null,
    finishedAt: status?.finishedAt ?? null,
    nextAction: status?.nextAction ?? null,
    results,
  };
}

function pill(r) {
  if (r.skipped) return "skip";
  if (r.ok) return "ok";
  return "fail";
}

function fmtDur(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function recentIssuesJsonl() {
  const p = process.env.PLAYON_LAB_MATRIX_ISSUES
    ? process.env.PLAYON_LAB_MATRIX_ISSUES
    : join(root, "tmp", "lab-matrix-issues.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-15)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .reverse();
}

function buildBody() {
  const verify = readJson(join(root, "tmp", "agent-loop-status.json"));
  const matrix = readJson(
    process.env.PLAYON_LAB_MATRIX_STATUS
      ? process.env.PLAYON_LAB_MATRIX_STATUS
      : join(root, "tmp", "lab-matrix-status.json"),
  );
  const m = summarizeMatrix(matrix);
  const now = new Date().toISOString();
  const host = process.env.PLAYON_LAB_HOST_LABEL || "playon-dev";

  const verifyLine = !verify
    ? "_No `tmp/agent-loop-status.json` yet._"
    : verify.ok
      ? `**Green** · mode=\`${verify.mode ?? "?"}\` · finished \`${verify.finishedAt ?? "?"}\``
      : `**Red** at layer \`${verify.failedLayer}\` · mode=\`${verify.mode ?? "?"}\` · finished \`${verify.finishedAt ?? "?"}\``;

  const matrixLine = !matrix
    ? "_No matrix run status yet._"
    : `**${m.done}/${m.requested}** (${m.pct}%) · ok=${m.ok} fail=${m.fail} skip=${m.skip}` +
      (m.mode ? ` · mode=\`${m.mode}\`` : "") +
      (m.current?.skillName ? ` · last=\`${m.current.skillName}\`` : "") +
      (m.failedSkill ? ` · failed=\`${m.failedSkill}\`` : "");

  const rows = [...(m.results || [])].slice(-25).reverse();
  const table =
    rows.length === 0
      ? "_No skill results yet._"
      : [
          "| Skill | Status | Duration | Detail |",
          "|-------|--------|----------|--------|",
          ...rows.map((r) => {
            const st = pill(r);
            const detail = r.skipped
              ? r.skipReason || "skip"
              : (r.tail || "").split(/\r?\n/)[0]?.slice(0, 80) || "";
            return `| \`${r.skillName}\` | ${st} | ${fmtDur(r.durationMs)} | ${detail.replace(/\|/g, "/")} |`;
          }),
        ].join("\n");

  const issueRows = recentIssuesJsonl();
  const issueBlock =
    issueRows.length === 0
      ? "_No recent matrix issue rows._"
      : issueRows
          .map(
            (i) =>
              `- \`${i.at || "?"}\` **${i.skill || "?"}** · ${i.phase || "?"} · ${i.errorClass || "?"} — ${(i.tail || "").split(/\r?\n/)[0]?.slice(0, 100) || ""}`,
          )
          .join("\n");

  const lines = [
    "<!-- playon-lab-status -->",
    "# Lab live status",
    "",
    `Host: **${host}** · Updated: \`${now}\``,
    "",
    "Primary cockpit: [PlayOn Ops](https://github.com/users/gmcclelland90/projects/1) · failures land as `source:lab` issues.",
    "",
    "## Merge bar (`loop:verify`)",
    "",
    verifyLine,
  ];
  if (verify?.nextAction) {
    lines.push("", `Next: ${verify.nextAction}`);
  }
  lines.push("", "## Catalog matrix", "", matrixLine);
  if (m.nextAction) {
    lines.push("", `Next: ${m.nextAction}`);
  }
  if (m.startedAt) {
    lines.push(
      "",
      `Started \`${m.startedAt}\`${m.finishedAt ? ` · Finished \`${m.finishedAt}\`` : " · _running_"}`,
    );
  }
  lines.push(
    "",
    "### Recent skills (latest 25)",
    "",
    table,
    "",
    "### Recent matrix failure rows",
    "",
    issueBlock,
    "",
    "---",
    "_Updated by `scripts/lab-publish-status.mjs`._",
  );
  return lines.join("\n");
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

  // ensure label exists (ignore errors)
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

  const body = buildBody();
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
  markThrottle();
  const url =
    issue.url || `https://github.com/${repo}/issues/${issue.number}`;
  console.log(`published ${url}`);
}

main();
