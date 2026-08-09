#!/usr/bin/env node
/**
 * Build lab verify/matrix report artifacts.
 *
 *   node scripts/lab-report.mjs
 *   node scripts/lab-report.mjs --title "nightly"
 *
 * Writes:
 *   tmp/lab-report.md
 *   tmp/lab-report.html
 * Appends markdown to $GITHUB_STEP_SUMMARY when set.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const argv = process.argv.slice(2);
const titleIdx = argv.indexOf("--title");
const title =
  titleIdx >= 0 && argv[titleIdx + 1]
    ? argv[titleIdx + 1]
    : process.env.PLAYON_LAB_REPORT_TITLE || "Lab report";

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
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
    overallOk: status ? !!status.ok : null,
  };
}

function fmtDur(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function pill(r) {
  if (r.skipped) return "skip";
  if (r.ok) return "ok";
  return "fail";
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function load() {
  const verify = readJson(join(root, "tmp", "agent-loop-status.json"));
  const matrix = readJson(
    process.env.PLAYON_LAB_MATRIX_STATUS
      ? process.env.PLAYON_LAB_MATRIX_STATUS
      : join(root, "tmp", "lab-matrix-status.json"),
  );
  return { verify, matrix, m: summarizeMatrix(matrix) };
}

/** Short “now” card for the sticky lab-status issue body. */
export function buildNowCard({ verify, m, host, now, runUrl }) {
  const verifyEmoji = !verify ? "⚪" : verify.ok ? "🟢" : "🔴";
  const matrixEmoji =
    !m || m.requested === 0
      ? "⚪"
      : m.fail > 0
        ? "🔴"
        : m.done < m.requested
          ? "🟡"
          : "🟢";

  const verifyLine = !verify
    ? "No verify status yet"
    : verify.ok
      ? `Green · \`${verify.mode ?? "?"}\` · ${verify.finishedAt ?? "?"}`
      : `Red at \`${verify.failedLayer}\` · \`${verify.mode ?? "?"}\``;

  const matrixLine =
    !m || m.requested === 0
      ? "No matrix status yet"
      : `${m.done}/${m.requested} (${m.pct}%) · ok ${m.ok} · fail ${m.fail} · skip ${m.skip}` +
        (m.current?.skillName ? ` · last \`${m.current.skillName}\`` : "") +
        (m.failedSkill ? ` · failed \`${m.failedSkill}\`` : "");

  const barFilled = Math.min(20, Math.round((m.pct / 100) * 20));
  const bar =
    m.requested > 0
      ? `\`${"█".repeat(barFilled)}${"░".repeat(20 - barFilled)}\` ${m.pct}%`
      : "";

  const lines = [
    "<!-- playon-lab-status -->",
    "# Lab now",
    "",
    `Host **${host}** · Updated \`${now}\``,
    "",
    `| | Status |`,
    `|---|---|`,
    `| ${verifyEmoji} Merge bar | ${verifyLine} |`,
    `| ${matrixEmoji} Matrix | ${matrixLine} |`,
  ];
  if (bar) lines.push("", bar);
  lines.push(
    "",
    "**Queue:** [PlayOn Ops](https://github.com/users/gmcclelland90/projects/1) · failures → `source:lab`",
  );
  if (runUrl) lines.push("", `**Latest detailed run:** ${runUrl}`);
  lines.push(
    "",
    "_Detail reports: Actions job summary / `lab-report` artifacts, or comments below on cadence ticks._",
  );
  return lines.join("\n");
}

export function buildDetailMarkdown({ verify, m, title, now, host }) {
  const verifyLine = !verify
    ? "_No verify status._"
    : verify.ok
      ? `**Green** · mode=\`${verify.mode}\` · finished \`${verify.finishedAt}\``
      : `**Red** · layer=\`${verify.failedLayer}\` · mode=\`${verify.mode}\``;

  const rows = [...(m.results || [])].slice(-40);
  const table =
    rows.length === 0
      ? "_No skill rows._"
      : [
          "| Skill | Status | Duration | Detail |",
          "|-------|--------|----------|--------|",
          ...rows.map((r) => {
            const detail = r.skipped
              ? r.skipReason || "skip"
              : (r.tail || "").split(/\r?\n/)[0]?.slice(0, 80) || "";
            return `| \`${r.skillName}\` | ${pill(r)} | ${fmtDur(r.durationMs)} | ${detail.replace(/\|/g, "/")} |`;
          }),
        ].join("\n");

  const failed = (m.results || []).filter((r) => !r.ok && !r.skipped);
  const failList =
    failed.length === 0
      ? "_None._"
      : failed
          .map(
            (r) =>
              `- \`${r.skillName}\` — ${(r.tail || "").split(/\r?\n/)[0]?.slice(0, 120) || "fail"}`,
          )
          .join("\n");

  return [
    `## ${title}`,
    "",
    `Host **${host}** · \`${now}\``,
    "",
    "### Merge bar",
    verifyLine,
    verify?.nextAction ? `Next: ${verify.nextAction}` : "",
    "",
    "### Matrix",
    m.requested
      ? `**${m.done}/${m.requested}** (${m.pct}%) · ok=${m.ok} fail=${m.fail} skip=${m.skip}`
      : "_No matrix._",
    m.nextAction ? `Next: ${m.nextAction}` : "",
    "",
    "### Failures",
    failList,
    "",
    "### Skills (latest 40)",
    table,
    "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export function buildHtml({ verify, m, title, now, host }) {
  const rows = [...(m.results || [])]
    .map((r) => {
      const st = pill(r);
      const detail = r.skipped
        ? r.skipReason || "skip"
        : (r.tail || "").split(/\r?\n/)[0] || "";
      return `<tr class="${st}"><td><code>${esc(r.skillName)}</code></td><td>${st}</td><td>${esc(fmtDur(r.durationMs))}</td><td>${esc(detail)}</td></tr>`;
    })
    .join("\n");

  const verifyText = !verify
    ? "n/a"
    : verify.ok
      ? `green (${verify.mode})`
      : `red @ ${verify.failedLayer}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(title)}</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 1.5rem; color: #e8eaef; background: #12141a; }
  h1 { font-size: 1.25rem; }
  .muted { color: #9aa3b5; font-size: 0.9rem; }
  .stats { display: flex; flex-wrap: wrap; gap: 0.75rem; margin: 1rem 0; }
  .stat { background: #1a1d26; border: 1px solid #2a3142; padding: 0.75rem 1rem; border-radius: 6px; min-width: 7rem; }
  .stat b { display: block; font-size: 1.4rem; }
  .ok b { color: #3dba7a; } .fail b { color: #e25d5d; } .skip b { color: #c9a227; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th, td { text-align: left; padding: 0.4rem 0.5rem; border-bottom: 1px solid #2a3142; }
  th { color: #9aa3b5; font-weight: 500; }
  tr.fail td { background: #2a1515; }
  tr.skip td { background: #2a2515; }
  code { font-family: ui-monospace, monospace; }
  .bar { height: 10px; background: #2a3142; border-radius: 99px; overflow: hidden; margin: 0.5rem 0 1rem; }
  .bar > i { display: block; height: 100%; background: #6ea8ff; }
</style>
</head>
<body>
  <h1>${esc(title)}</h1>
  <p class="muted">${esc(host)} · ${esc(now)}</p>
  <p>Merge bar: <strong>${esc(verifyText)}</strong></p>
  <div class="stats">
    <div class="stat"><span class="muted">Done</span><b>${m.done}/${m.requested}</b></div>
    <div class="stat ok"><span class="muted">Ok</span><b>${m.ok}</b></div>
    <div class="stat fail"><span class="muted">Fail</span><b>${m.fail}</b></div>
    <div class="stat skip"><span class="muted">Skip</span><b>${m.skip}</b></div>
  </div>
  <div class="bar"><i style="width:${m.pct}%"></i></div>
  <table>
    <thead><tr><th>Skill</th><th>Status</th><th>Duration</th><th>Detail</th></tr></thead>
    <tbody>
${rows || '<tr><td colspan="4">No skills</td></tr>'}
    </tbody>
  </table>
</body>
</html>
`;
}

function main() {
  const host = process.env.PLAYON_LAB_HOST_LABEL || "playon-dev";
  const now = new Date().toISOString();
  const { verify, m } = load();
  const md = buildDetailMarkdown({ verify, m, title, now, host });
  const html = buildHtml({ verify, m, title, now, host });
  const nowCard = buildNowCard({
    verify,
    m,
    host,
    now,
    runUrl: process.env.PLAYON_LAB_RUN_URL || "",
  });

  mkdirSync(join(root, "tmp"), { recursive: true });
  writeFileSync(join(root, "tmp", "lab-report.md"), `${md}\n`, "utf8");
  writeFileSync(join(root, "tmp", "lab-report.html"), html, "utf8");
  writeFileSync(join(root, "tmp", "lab-now.md"), `${nowCard}\n`, "utf8");

  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    appendFileSync(summary, `${md}\n`, "utf8");
  }

  console.log(`wrote tmp/lab-report.md tmp/lab-report.html tmp/lab-now.md`);
  console.log(
    `verify=${verify ? (verify.ok ? "green" : "red") : "n/a"} matrix=${m.done}/${m.requested} fail=${m.fail}`,
  );
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("lab-report.mjs") ||
    process.argv[1].includes("lab-report.mjs"));
if (isMain) main();
