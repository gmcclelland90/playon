#!/usr/bin/env node
/**
 * File / update GitHub Issues from lab verify + matrix failure artifacts.
 *
 * Closes the SDLC loop: lab red → needs-triage (source:lab) → PlayOn Ops auto-add
 * → triage automation → ready / blocked-human.
 *
 * Usage:
 *   node scripts/lab-file-github-issues.mjs --from verify
 *   node scripts/lab-file-github-issues.mjs --from matrix
 *   node scripts/lab-file-github-issues.mjs --from verify --from matrix
 *   node scripts/lab-file-github-issues.mjs --dry-run
 *
 * Env:
 *   PLAYON_LAB_FILE_ISSUES=0   skip (also skipped when unset in --require-opt-in mode)
 *   PLAYON_GITHUB_REPO         default gmcclelland90/playon
 *   GH_TOKEN / gh auth         required to create issues
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const repo = process.env.PLAYON_GITHUB_REPO || "gmcclelland90/playon";
const argv = process.argv.slice(2);
const args = new Set(argv);
const dryRun = args.has("--dry-run");
function fromFlags() {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--from" && argv[i + 1]) {
      out.push(argv[++i]);
      continue;
    }
    if (argv[i].startsWith("--from=")) out.push(argv[i].slice("--from=".length));
  }
  return out;
}
const from = fromFlags();
const sources =
  from.length === 0
    ? { verify: true, matrix: true }
    : { verify: from.includes("verify"), matrix: from.includes("matrix") };

const statusVerify = join(root, "tmp", "agent-loop-status.json");
const statusMatrix = process.env.PLAYON_LAB_MATRIX_STATUS
  ? process.env.PLAYON_LAB_MATRIX_STATUS
  : join(root, "tmp", "lab-matrix-status.json");
const issuesJsonl = process.env.PLAYON_LAB_MATRIX_ISSUES
  ? process.env.PLAYON_LAB_MATRIX_ISSUES
  : join(root, "tmp", "lab-matrix-issues.jsonl");
const ledgerPath = join(root, "tmp", "lab-filed-issues.json");
const refileClosed =
  (process.env.PLAYON_LAB_REFILE ?? "").trim() === "1" || args.has("--refile");

function enabled() {
  const v = (process.env.PLAYON_LAB_FILE_ISSUES ?? "1").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "off" && v !== "no";
}

function gh(argv, { input } = {}) {
  const r = spawnSync("gh", argv, {
    cwd: root,
    encoding: "utf8",
    shell: false,
    input,
    env: process.env,
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    ok: (r.status ?? 1) === 0,
    status: r.status ?? 1,
    stdout: (r.stdout ?? "").trim(),
    stderr: (r.stderr ?? "").trim(),
  };
}

function loadLedger() {
  if (!existsSync(ledgerPath)) return { fingerprints: {} };
  try {
    return JSON.parse(readFileSync(ledgerPath, "utf8"));
  } catch {
    return { fingerprints: {} };
  }
}

function saveLedger(ledger) {
  mkdirSync(join(root, "tmp"), { recursive: true });
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

function fingerprintMarker(fp) {
  return `<!-- playon-lab-fingerprint: ${fp} -->`;
}

function findOpenByFingerprint(fp) {
  const marker = fingerprintMarker(fp);
  const q = gh([
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--label",
    "source:lab",
    "--limit",
    "500",
    "--json",
    "number,body,title",
  ]);
  if (!q.ok) return null;
  let items = [];
  try {
    items = JSON.parse(q.stdout || "[]");
  } catch {
    return null;
  }
  return items.find((i) => (i.body || "").includes(marker)) ?? null;
}

function issueState(number) {
  if (!number) return null;
  const q = gh([
    "issue",
    "view",
    String(number),
    "--repo",
    repo,
    "--json",
    "state,number",
  ]);
  if (!q.ok) return null;
  try {
    return JSON.parse(q.stdout || "{}");
  } catch {
    return null;
  }
}

function createOrUpdate({ fingerprint, title, body, labels, filedLedger }) {
  const marker = fingerprintMarker(fingerprint);
  const fullBody = `${marker}\n\n${body}`;
  const existing = findOpenByFingerprint(fingerprint);
  if (existing) {
    const comment = `## Lab update\n\n${body}\n`;
    if (dryRun) {
      console.log(`dry-run: comment #${existing.number} fp=${fingerprint}`);
      return { number: existing.number, action: "comment" };
    }
    const r = gh([
      "issue",
      "comment",
      String(existing.number),
      "--repo",
      repo,
      "--body",
      comment,
    ]);
    if (!r.ok) {
      console.error(`failed to comment #${existing.number}: ${r.stderr}`);
      return null;
    }
    console.log(`updated #${existing.number} fp=${fingerprint}`);
    return { number: existing.number, action: "comment" };
  }

  // Do not reopen spam: if we already filed this fingerprint and the issue is
  // closed (or still tracked), skip unless PLAYON_LAB_REFILE=1 / --refile.
  const prior = filedLedger?.fingerprints?.[fingerprint];
  if (prior?.number && !refileClosed) {
    const st = issueState(prior.number);
    if (st?.state === "OPEN") {
      const comment = `## Lab update\n\n${body}\n`;
      if (dryRun) {
        console.log(`dry-run: comment prior #${prior.number} fp=${fingerprint}`);
        return { number: prior.number, action: "comment" };
      }
      const r = gh([
        "issue",
        "comment",
        String(prior.number),
        "--repo",
        repo,
        "--body",
        comment,
      ]);
      if (r.ok) {
        console.log(`updated prior #${prior.number} fp=${fingerprint}`);
        return { number: prior.number, action: "comment" };
      }
    } else {
      console.log(
        `skip closed/known fp=${fingerprint} prior=#${prior.number} (set PLAYON_LAB_REFILE=1 to recreate)`,
      );
      return { number: prior.number, action: "skip_closed" };
    }
  }

  if (dryRun) {
    console.log(`dry-run: create ${title} labels=${labels.join(",")}`);
    return { number: 0, action: "create" };
  }

  const argv = [
    "issue",
    "create",
    "--repo",
    repo,
    "--title",
    title,
    "--body",
    fullBody,
  ];
  for (const l of labels) {
    argv.push("--label", l);
  }
  const r = gh(argv);
  if (!r.ok) {
    console.error(`failed to create issue: ${r.stderr || r.stdout}`);
    return null;
  }
  console.log(`created ${r.stdout} fp=${fingerprint}`);
  const number = Number((r.stdout.match(/\/issues\/(\d+)/) || [])[1] || 0);
  return { number, action: "create", url: r.stdout };
}

function truncate(s, n = 3500) {
  const t = String(s ?? "").trim();
  if (t.length <= n) return t;
  return `${t.slice(0, n)}\n…(truncated)`;
}

function fileVerifyFailure() {
  if (!existsSync(statusVerify)) {
    console.log("skip verify: no tmp/agent-loop-status.json");
    return [];
  }
  const status = JSON.parse(readFileSync(statusVerify, "utf8"));
  if (status.ok) {
    console.log("skip verify: last loop ok");
    return [];
  }
  const layer = status.failedLayer || "unknown";
  const mode = status.mode || "merge";
  const failed = (status.results || []).find((r) => r.name === layer);
  const tail = failed?.tail || "";
  const fp = `verify:${mode}:${layer}`;
  const isE2e = mode === "e2e-weekly" || layer === "e2e";
  const title = isE2e
    ? `[chore] weekly e2e smoke failed`
    : `[chore] lab:loop:verify failed at layer ${layer}`;
  const body = [
    "## Summary",
    isE2e
      ? `Weekly Playwright e2e smoke failed (mode=\`${mode}\`).`
      : `Lab/CI merge/runtime bar failed at layer \`${layer}\` (mode=\`${mode}\`).`,
    "",
    "## Evidence",
    "```",
    truncate(tail),
    "```",
    "",
    "## Done when",
    isE2e
      ? "- [ ] `pnpm test:e2e` green locally/CI\n- [ ] Flake quarantined with test-debt if needed"
      : `- [ ] \`pnpm loop:verify${mode === "runtime" ? ":runtime" : ""}\` green on playon-dev\n- [ ] Root cause fixed or flake quarantined with test-debt`,
    "",
    "See docs/testing-plan.md, docs/agent-dev-loop.md, docs/issue-triage.md.",
  ].join("\n");

  const labels = [
    "chore",
    "needs-triage",
    "source:lab",
    "lab",
    isE2e || layer === "runtime" || layer === "int" || layer === "agent"
      ? "P1"
      : "P2",
  ];
  if (isE2e) labels.push("web", "test-debt");
  if (layer === "agent" || layer === "int") labels.push("api");
  if (layer === "runtime") labels.push("runtime");

  const result = createOrUpdate({ fingerprint: fp, title, body, labels });
  return result ? [{ fingerprint: fp, ...result }] : [];
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function mapErrorClass(errorClass) {
  switch (errorClass) {
    case "skill_bug":
      return { type: "skill", priority: "P2" };
    case "platform_bug":
      return { type: "bug", priority: "P1" };
    case "lifecycle_fail":
      return { type: "skill", priority: "P2" };
    case "flake":
      return { type: "chore", priority: "P3", extra: ["test-debt"] };
    case "platform_unsupported":
      return { type: "chore", priority: "P3" };
    default:
      return { type: "skill", priority: "P2" };
  }
}

function failRowFromStatusResult(r) {
  if (!r || r.ok || r.skipped) return null;
  const phase =
    Object.entries(r.phases || {}).find(([, v]) => v === "fail")?.[0] ||
    "unknown";
  const errorClass =
    phase === "static" ? "skill_bug" : r.errorClass || "lifecycle_fail";
  return {
    skill: r.skillName || "unknown",
    phase,
    errorClass,
    at: new Date().toISOString(),
    tail: r.tail || "",
  };
}

function fileMatrixFailures(filedLedger) {
  // Prefer the current matrix status file (this run only) so a single red
  // skill cannot re-file the entire historical issues.jsonl backlog.
  const fromStatus = [];
  if (existsSync(statusMatrix)) {
    try {
      const status = JSON.parse(readFileSync(statusMatrix, "utf8"));
      for (const r of status.results || []) {
        const row = failRowFromStatusResult(r);
        if (row) fromStatus.push(row);
      }
    } catch (err) {
      console.warn(
        `matrix status unreadable: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  let rows = fromStatus;
  if (!rows.length) {
    const jsonlRows = readJsonl(issuesJsonl);
    if (!jsonlRows.length) {
      console.log("skip matrix: no status failures and no issues.jsonl rows");
      return [];
    }
    // Fallback: only rows from the last 6 hours (still deduped by key).
    const cutoff = Date.now() - 6 * 3600_000;
    const latest = new Map();
    for (const row of jsonlRows) {
      const at = Date.parse(row.at || "") || 0;
      if (at && at < cutoff) continue;
      const skill = row.skill || "unknown";
      const phase = row.phase || "unknown";
      const errorClass = row.errorClass || "unknown";
      latest.set(`${skill}|${phase}|${errorClass}`, row);
    }
    rows = [...latest.values()];
    console.log(`matrix filing from recent jsonl rows=${rows.length}`);
  } else {
    console.log(`matrix filing from status failures=${rows.length}`);
  }

  const out = [];
  for (const row of rows) {
    const skill = row.skill || "unknown";
    const phase = row.phase || "unknown";
    const errorClass = row.errorClass || "unknown";
    if (errorClass === "allowed_skip") continue;
    const mapped = mapErrorClass(errorClass);
    const fp = `matrix:${skill}:${phase}:${errorClass}`;
    const title = `[skill] ${skill}: ${phase} failed (${errorClass})`;
    const body = [
      "## Summary",
      `Catalog lab matrix failure for \`${skill}\` at phase \`${phase}\`.`,
      "",
      "## Classification",
      `- errorClass: \`${errorClass}\``,
      `- skill: \`${skill}\``,
      `- phase: \`${phase}\``,
      `- at: \`${row.at || "unknown"}\``,
      "",
      "## Evidence",
      "```",
      truncate(row.tail || row.message || ""),
      "```",
      "",
      "## Done when",
      `- [ ] \`pnpm lab:matrix --skill ${skill}\` green on playon-dev`,
      "- [ ] Or reclassified as allowed_skip / platform_unsupported with docs",
      "",
      "See docs/lab-matrix.md and docs/issue-triage.md.",
    ].join("\n");
    const labels = [
      mapped.type,
      "needs-triage",
      "source:lab",
      "lab",
      "skills",
      mapped.priority,
      ...(mapped.extra || []),
    ];
    const result = createOrUpdate({
      fingerprint: fp,
      title,
      body,
      labels,
      filedLedger,
    });
    if (result) out.push({ fingerprint: fp, ...result });
  }
  return out;
}

function main() {
  if (!enabled()) {
    console.log("PLAYON_LAB_FILE_ISSUES disabled; skip");
    process.exit(0);
  }

  const auth = gh(["auth", "status"]);
  if (!auth.ok && !dryRun) {
    console.error("gh not authenticated; cannot file issues");
    console.error(auth.stderr || auth.stdout);
    process.exit(0); // do not fail the lab bar for missing gh
  }

  const ledger = loadLedger();
  const filed = [];
  if (sources.verify) filed.push(...fileVerifyFailure());
  if (sources.matrix) filed.push(...fileMatrixFailures(ledger));

  for (const f of filed) {
    if (!f.fingerprint || !f.number) continue;
    if (f.action === "skip_closed") continue;
    ledger.fingerprints[f.fingerprint] = {
      number: f.number,
      action: f.action,
      at: new Date().toISOString(),
      url: f.url,
    };
  }
  if (!dryRun && filed.length) saveLedger(ledger);

  const created = filed.filter((f) => f.action === "create").length;
  const commented = filed.filter((f) => f.action === "comment").length;
  const skipped = filed.filter((f) => f.action === "skip_closed").length;
  const summaryLine = `${new Date().toISOString()} filed=${filed.length} create=${created} comment=${commented} skip_closed=${skipped} ${filed
    .map((f) => `#${f.number}:${f.action}`)
    .join(" ")}\n`;
  mkdirSync(join(root, "tmp"), { recursive: true });
  appendFileSync(join(root, "tmp", "lab-file-issues.log"), summaryLine, "utf8");
  console.log(
    `done filed=${filed.length} create=${created} comment=${commented} skip_closed=${skipped}`,
  );
}

main();
