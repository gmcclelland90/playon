#!/usr/bin/env node
/**
 * Portable PlayOn Home launcher — bootstrap env, start API + local node-agent, open browser.
 * Invoked by Start-PlayOn.ps1 / start-playon.sh with the bundled Node binary.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..", "..");
const isWin = process.platform === "win32";
const envDir = path.join(root, "env");
const envFile = path.join(envDir, isWin ? "playon.env.cmd" : "playon.env");
const dataRoot = path.join(root, "data");
const nodeBin = process.execPath;

function detectAdvertiseHost() {
  const nets = os.networkInterfaces();
  for (const entries of Object.values(nets)) {
    if (!entries) continue;
    for (const ent of entries) {
      if (ent.family !== "IPv4" && ent.family !== 4) continue;
      if (ent.internal) continue;
      return ent.address;
    }
  }
  return "127.0.0.1";
}

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const body = trimmed.startsWith("set ") ? trimmed.slice(4) : trimmed;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    out[body.slice(0, eq).trim()] = body.slice(eq + 1).trim();
  }
  return out;
}

function writeEnvFile(vars) {
  fs.mkdirSync(envDir, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  if (isWin) {
    const body = Object.entries(vars)
      .map(([k, v]) => `set ${k}=${v}`)
      .join("\r\n");
    fs.writeFileSync(envFile, `${body}\r\n`, "utf8");
  } else {
    const body = Object.entries(vars)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    fs.writeFileSync(envFile, `${body}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

function ensureEnv() {
  const existing = parseEnvFile(envFile);
  const advertise =
    process.env.PLAYON_ADVERTISE_HOST?.trim() ||
    existing.PLAYON_ADVERTISE_HOST ||
    detectAdvertiseHost();
  const sessionSecret =
    process.env.PLAYON_SESSION_SECRET?.trim() ||
    existing.PLAYON_SESSION_SECRET ||
    crypto.randomBytes(32).toString("hex");
  const nodeToken =
    process.env.PLAYON_NODE_TOKEN?.trim() ||
    existing.PLAYON_NODE_TOKEN ||
    crypto.randomBytes(24).toString("hex");
  const runtime =
    process.env.PLAYON_RUNTIME?.trim() || existing.PLAYON_RUNTIME || "native";

  const vars = {
    PLAYON_ENV: "production",
    PLAYON_HOST: "0.0.0.0",
    PLAYON_PORT: existing.PLAYON_PORT || "8787",
    PLAYON_ADVERTISE_HOST: advertise,
    PLAYON_SESSION_SECRET: sessionSecret,
    PLAYON_DATA_ROOT: existing.PLAYON_DATA_ROOT || dataRoot,
    PLAYON_RUNTIME: runtime,
    PLAYON_LLM_MODE: existing.PLAYON_LLM_MODE || "openai_compatible",
    PLAYON_NODE_TOKEN: nodeToken,
    PLAYON_PACKAGES_ROOT: path.join(root, "packages"),
    PLAYON_SKILLS_PROFILE: "minimal",
    PLAYON_WEB_DIST: path.join(root, "apps", "web", "dist"),
  };
  writeEnvFile(vars);
  return vars;
}

function openBrowser(url) {
  const cmd = isWin ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = isWin ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    // ignore — user can open manually
  }
}

function waitForHttp(url, timeoutMs = 60_000) {
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve(true);
      });
      req.on("error", () => {
        if (Date.now() - started > timeoutMs) resolve(false);
        else setTimeout(tick, 400);
      });
      req.setTimeout(2000, () => {
        req.destroy();
        if (Date.now() - started > timeoutMs) resolve(false);
        else setTimeout(tick, 400);
      });
    };
    tick();
  });
}

function spawnChild(label, scriptRel, extraEnv) {
  const script = path.join(root, scriptRel);
  if (!fs.existsSync(script)) {
    console.error(`Missing ${label}: ${script}`);
    process.exit(1);
  }
  const child = spawn(nodeBin, [script], {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    stdio: "inherit",
    windowsHide: false,
  });
  child.on("exit", (code, signal) => {
    if (signal) console.error(`${label} exited on signal ${signal}`);
    else if (code !== 0 && code != null) console.error(`${label} exited with code ${code}`);
  });
  return child;
}

const vars = ensureEnv();
const port = vars.PLAYON_PORT || "8787";
const advertise = vars.PLAYON_ADVERTISE_HOST;
const mdnsUrl = "http://playon.local";
const ipFallback = `http://${advertise}:${port}`;

console.log("PlayOn Home (portable)");
console.log(`  Root:   ${root}`);
console.log(`  Node:   ${nodeBin}`);
console.log(`  Open:   ${mdnsUrl}`);
console.log(`  Fallback: ${ipFallback}`);
console.log(`  Players: ${mdnsUrl}/play (or ${ipFallback}/play)`);
console.log(`  Discord HTTPS: link in Settings → Panel URL → https://<handle>.playon.games`);
console.log(`  Data:   ${vars.PLAYON_DATA_ROOT}`);
console.log("");

const api = spawnChild("API", path.join("apps", "api", "dist", "index.js"), vars);
const nodeAgent = spawnChild("node-agent", path.join("apps", "node-agent", "dist", "index.js"), {
  ...vars,
  PLAYON_API_URL: `http://127.0.0.1:${port}`,
  PLAYON_NODE_ID: "local",
  PLAYON_NODE_NAME: os.hostname(),
});

const ready = await waitForHttp(`http://127.0.0.1:${port}/api/setup`);
if (ready) {
  // Prefer discovery URL; IP fallback still printed above.
  console.log(`Ready — opening ${mdnsUrl} (fallback ${ipFallback})`);
  openBrowser(mdnsUrl);
} else {
  console.log(`Still starting — open ${mdnsUrl} or ${ipFallback} when ready.`);
}

function shutdown() {
  for (const child of [api, nodeAgent]) {
    if (!child.killed) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(0), 500).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await new Promise((resolve) => {
  let remaining = 2;
  const done = () => {
    remaining -= 1;
    if (remaining <= 0) resolve();
  };
  api.on("exit", done);
  nodeAgent.on("exit", done);
});
