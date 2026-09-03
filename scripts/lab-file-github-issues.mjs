#!/usr/bin/env node
/**
 * File / update GitHub Issues from lab verify + matrix failure artifacts.
 *
 * Closes the SDLC loop: lab red → needs-triage (source:lab) → PlayOn Ops auto-add
 * → triage automation → ready / blocked-human.
 *
 * Matrix fingerprints are per skill (not phase). A later start → port_open →
 * query failure comments on the same issue instead of opening clones.
 *
 * Usage:
 *   node scripts/lab-file-github-issues.mjs --from verify
 *   node scripts/lab-file-github-issues.mjs --from matrix
 *   node scripts/lab-file-github-issues.mjs --from llm-canary
 *   node scripts/lab-file-github-issues.mjs --from verify --from matrix
 *   node scripts/lab-file-github-issues.mjs --dry-run
 *   node scripts/lab-file-github-issues.mjs --close-clones
 *   node scripts/lab-file-github-issues.mjs --close-clones --apply
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
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.cwd();
const repo = process.env.PLAYON_GITHUB_REPO || "gmcclelland90/playon";
const argv = process.argv.slice(2);
const args = new Set(argv);
const dryRun = args.has("--dry-run");
const closeClones = args.has("--close-clones");
const applyClones = args.has("--apply");
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
  closeClones && from.length === 0
    ? { verify: false, matrix: false, llmCanary: false }
    : from.length === 0
      ? { verify: true, matrix: true, llmCanary: false }
      : {
          verify: from.includes("verify"),
          matrix: from.includes("matrix"),
          llmCanary: from.includes("llm-canary") || from.includes("canary"),
        };

const statusVerify = join(root, "tmp", "agent-loop-status.json");
const statusLlmCanary = join(root, "tmp", "lab-llm-canary-status.json");
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

export function fingerprintMarker(fp) {
  return `<!-- playon-lab-fingerprint: ${fp} -->`;
}

/** One GitHub issue per catalog skill (phase lives in the body / comments). */
export function matrixFingerprint(skill) {
  return `matrix:${skill || "unknown"}`;
}

export function parseLabFingerprint(body) {
  const m = /<!-- playon-lab-fingerprint:\s*(\S+)\s*-->/.exec(body || "");
  return m ? m[1] : null;
}

export function skillFromMatrixFingerprint(fp) {
  if (!fp || !String(fp).startsWith("matrix:")) return null;
  return String(fp).slice("matrix:".length).split(":")[0] || null;
}

export function skillFromLabIssue(issue) {
  const fromFp = skillFromMatrixFingerprint(parseLabFingerprint(issue?.body));
  if (fromFp) return fromFp;
  const m = /^\[skill\]\s+(\S+):/.exec(issue?.title || "");
  return m ? m[1] : null;
}

/**
 * Match an open lab issue to a skill without treating `games.rust` as a prefix
 * of `games.rust-experimental`.
 */
export function issueMatchesSkill(issue, skill) {
  if (!skill) return false;
  const body = issue?.body || "";
  const title = issue?.title || "";
  const exact = fingerprintMarker(matrixFingerprint(skill));
  const legacyPrefix = `<!-- playon-lab-fingerprint: matrix:${skill}:`;
  if (body.includes(exact) || body.includes(legacyPrefix)) return true;
  return title.startsWith(`[skill] ${skill}:`);
}

/**
 * Classify matrix tails / skip reasons. Does not decide pass/fail — callers
 * still skip `ok` / `skipped` / `allowed_skip` before filing.
 */
export function classifyMatrixErrorClass({
  phase,
  tail,
  skipReason,
  errorClass,
} = {}) {
  const text = `${skipReason || ""} ${errorClass || ""} ${tail || ""}`;
  if (/steamcmd_timeout/i.test(text)) return "steamcmd_timeout";
  if (/steamcmd_empty_depot/i.test(text)) return "steamcmd_empty_depot";
  if (/steamcmd_no_subscription/i.test(text)) return "steamcmd_no_subscription";
  if (/host_port_in_use|bind host port .+ address already in use/i.test(text)) {
    return "platform_bug";
  }
  if (
    errorClass &&
    errorClass !== "lifecycle_fail" &&
    errorClass !== "unknown"
  ) {
    return errorClass;
  }
  if (phase === "static") return "skill_bug";
  return "lifecycle_fail";
}

export function mapErrorClass(errorClass) {
  switch (errorClass) {
    case "skill_bug":
      return { type: "skill", priority: "P2" };
    case "platform_bug":
      return { type: "bug", priority: "P1" };
    case "lifecycle_fail":
      return { type: "skill", priority: "P2" };
    case "steamcmd_timeout":
      return { type: "bug", priority: "P1", extra: ["runtime"] };
    case "steamcmd_empty_depot":
    case "steamcmd_no_subscription":
      return { type: "chore", priority: "P3", extra: ["runtime"] };
    case "flake":
      return { type: "chore", priority: "P3", extra: ["test-debt"] };
    case "platform_unsupported":
      return { type: "chore", priority: "P3" };
    default:
      return { type: "skill", priority: "P2" };
  }
}

export function failRowFromStatusResult(r) {
  if (!r || r.ok || r.skipped) return null;
  const phase =
    Object.entries(r.phases || {}).find(([, v]) => v === "fail")?.[0] ||
    "unknown";
  const errorClass = classifyMatrixErrorClass({
    phase,
    tail: r.tail,
    skipReason: r.skipReason,
    errorClass: r.errorClass,
  });
  return {
    skill: r.skillName || "unknown",
    phase,
    errorClass,
    at: new Date().toISOString(),
    tail: r.tail || "",
  };
}

/** Latest jsonl row per skill (not per phase). */
export function collectLatestMatrixRows(jsonlRows, { cutoffMs } = {}) {
  const latest = new Map();
  for (const row of jsonlRows || []) {
    const at = Date.parse(row.at || "") || 0;
    if (cutoffMs && at && at < cutoffMs) continue;
    const skill = row.skill || "unknown";
    const prev = latest.get(skill);
    const prevAt = Date.parse(prev?.at || "") || 0;
    if (!prev || at >= prevAt) {
      latest.set(skill, {
        ...row,
        skill,
        phase: row.phase || "unknown",
        errorClass: classifyMatrixErrorClass(row),
      });
    }
  }
  return [...latest.values()];
}

/**
 * Group open source:lab skill issues. Keep the oldest; extras are clones from
 * the old phase-keyed fingerprint.
 */
export function groupSkillCloneIssues(items) {
  const groups = new Map();
  for (const item of items || []) {
    const fp = parseLabFingerprint(item?.body);
    if (fp && String(fp).startsWith("verify:")) continue;
    const skill = skillFromLabIssue(item);
    if (!skill) continue;
    if (!groups.has(skill)) groups.set(skill, []);
    groups.get(skill).push(item);
  }
  const clones = [];
  for (const [skill, issues] of groups) {
    if (issues.length < 2) continue;
    const sorted = [...issues].sort((a, b) => a.number - b.number);
    clones.push({ skill, keep: sorted[0], close: sorted.slice(1) });
  }
  return clones;
}

export function priorForMatrixSkill(filedLedger, skill) {
  const fps = filedLedger?.fingerprints || {};
  const exact = fps[matrixFingerprint(skill)];
  if (exact) return exact;
  for (const [fp, rec] of Object.entries(fps)) {
    if (fp.startsWith(`matrix:${skill}:`)) return rec;
  }
  return null;
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

function listOpenLabIssues() {
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
  if (!q.ok) return [];
  try {
    return JSON.parse(q.stdout || "[]");
  } catch {
    return [];
  }
}

function findOpenByFingerprint(fp, { skill } = {}) {
  const marker = fingerprintMarker(fp);
  const items = listOpenLabIssues();
  const exact = items.find((i) => (i.body || "").includes(marker));
  if (exact) return exact;
  if (!skill) return null;
  const matches = items.filter((i) => issueMatchesSkill(i, skill));
  matches.sort((a, b) => a.number - b.number);
  return matches[0] ?? null;
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

function ensureFingerprintMarker(issue, fp) {
  const marker = fingerprintMarker(fp);
  if (!issue || (issue.body || "").includes(marker)) return;
  if (dryRun) {
    console.log(`dry-run: stamp fingerprint on #${issue.number} fp=${fp}`);
    return;
  }
  const newBody = `${marker}\n\n${issue.body || ""}`;
  const r = gh([
    "issue",
    "edit",
    String(issue.number),
    "--repo",
    repo,
    "--body",
    newBody,
  ]);
  if (!r.ok) {
    console.warn(
      `failed to stamp fingerprint on #${issue.number}: ${r.stderr || r.stdout}`,
    );
  }
}

function createOrUpdate({ fingerprint, title, body, labels, filedLedger, skill }) {
  const marker = fingerprintMarker(fingerprint);
  const fullBody = `${marker}\n\n${body}`;
  const existing = findOpenByFingerprint(fingerprint, { skill });
  if (existing) {
    ensureFingerprintMarker(existing, fingerprint);
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
  const prior = skill
    ? priorForMatrixSkill(filedLedger, skill)
    : filedLedger?.fingerprints?.[fingerprint];
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

  const createArgv = [
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
    createArgv.push("--label", l);
  }
  const r = gh(createArgv);
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

function readJsonl(pathName) {
  if (!existsSync(pathName)) return [];
  return readFileSync(pathName, "utf8")
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
    // Fallback: only rows from the last 6 hours (still deduped by skill).
    const cutoff = Date.now() - 6 * 3600_000;
    rows = collectLatestMatrixRows(jsonlRows, { cutoffMs: cutoff });
    console.log(`matrix filing from recent jsonl rows=${rows.length}`);
  } else {
    console.log(`matrix filing from status failures=${rows.length}`);
  }

  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const skill = row.skill || "unknown";
    if (seen.has(skill)) continue;
    seen.add(skill);
    const phase = row.phase || "unknown";
    const errorClass = classifyMatrixErrorClass(row);
    if (errorClass === "allowed_skip") continue;
    const mapped = mapErrorClass(errorClass);
    const fp = matrixFingerprint(skill);
    const title = `[skill] ${skill}: lab matrix failed`;
    const body = [
      "## Summary",
      `Catalog lab matrix failure for \`${skill}\` at phase \`${phase}\`.`,
      "",
      "Fingerprint is **per skill**. Later phase changes (start / port_open / query) comment here instead of opening a clone.",
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
      skill,
    });
    if (result) out.push({ fingerprint: fp, ...result });
  }
  return out;
}

function closeSkillCloneIssues({ apply }) {
  const items = listOpenLabIssues();
  const groups = groupSkillCloneIssues(items);
  if (!groups.length) {
    console.log("close-clones: no skill clone groups");
    return { groups: 0, close: 0 };
  }
  let closeN = 0;
  for (const g of groups) {
    const closeNums = g.close.map((i) => `#${i.number}`).join(" ");
    console.log(
      `close-clones: ${g.skill} keep=#${g.keep.number} close=${closeNums}`,
    );
    for (const extra of g.close) {
      const comment = [
        `Duplicate of #${g.keep.number} — same skill \`${g.skill}\`.`,
        "",
        "Lab filing now fingerprints by skill (not phase), so start / port_open / query share one issue.",
        "See #842.",
      ].join("\n");
      if (!apply) {
        console.log(`dry-run: close #${extra.number} as duplicate of #${g.keep.number}`);
        closeN += 1;
        continue;
      }
      const r = gh([
        "issue",
        "close",
        String(extra.number),
        "--repo",
        repo,
        "--reason",
        "not planned",
        "--comment",
        comment,
      ]);
      if (!r.ok) {
        console.error(`failed to close #${extra.number}: ${r.stderr || r.stdout}`);
        continue;
      }
      console.log(`closed #${extra.number} duplicate of #${g.keep.number}`);
      closeN += 1;
    }
  }
  console.log(
    `close-clones: groups=${groups.length} close=${closeN} apply=${apply ? "yes" : "no (dry-run)"}`,
  );
  return { groups: groups.length, close: closeN };
}

function fileLlmCanaryFailures() {
  if (!existsSync(statusLlmCanary)) {
    console.log("skip llm-canary: no tmp/lab-llm-canary-status.json");
    return [];
  }
  let status;
  try {
    status = JSON.parse(readFileSync(statusLlmCanary, "utf8"));
  } catch (err) {
    console.warn(`llm-canary status unreadable: ${err instanceof Error ? err.message : err}`);
    return [];
  }

  const out = [];
  if (status.ollama && status.ollama.reachable === false) {
    console.log("llm-canary ollama reachable=false (not filed)");
  }

  for (const row of status.models || []) {
    if (row.skipped) continue;
    if (row.ok) continue;
    const provider = row.provider || "unknown";
    const model = row.model || "unknown";
    const reason = row.reason || (row.degraded ? "degraded" : "tool_trace_fail");
    const fp = `llm-canary:${provider}:${model}:${reason}`;
    const title = `[lab] LLM canary: ${model} two-step tool trace failed`;
    const body = [
      "## Summary",
      `LLM canary v2 two-step tool trace failed for \`${provider}/${model}\`.`,
      "",
      "## Classification",
      `- provider: \`${provider}\``,
      `- model: \`${model}\``,
      `- reason: \`${reason}\``,
      `- degraded: \`${Boolean(row.degraded)}\``,
      `- tools: \`${(row.names || []).join(" → ") || "(none)"}\``,
      "",
      "## Evidence",
      "```",
      truncate(JSON.stringify(row, null, 2)),
      "```",
      "",
      "## Done when",
      "- [ ] `pnpm lab:llm-canary` two-step trace green for this model",
      "- [ ] Do **not** blocklist Gemma; recover text-tool emission instead (#838 / #840)",
      "",
      "See docs/testing-plan.md (LLM canary) and #845 / #836.",
    ].join("\n");
    const labels = [
      "bug",
      "needs-triage",
      "source:lab",
      "lab",
      "agent-core",
      "api",
      provider === "venice" ? "P1" : "P2",
    ];
    const result = createOrUpdate({ fingerprint: fp, title, body, labels });
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

  if (closeClones) {
    closeSkillCloneIssues({ apply: applyClones && !dryRun });
  }

  const ledger = loadLedger();
  const filed = [];
  if (sources.verify) filed.push(...fileVerifyFailure());
  if (sources.matrix) filed.push(...fileMatrixFailures(ledger));
  if (sources.llmCanary) filed.push(...fileLlmCanaryFailures());

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

const invokedAsCli =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (invokedAsCli) {
  main();
}
