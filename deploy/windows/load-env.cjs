"use strict";
/**
 * PlayOn Windows node preload (`--require`). Loads PLAYON_* from
 * node.env.json or node.env.cmd (LF or CRLF), then tees stdout/stderr
 * to a rotating agent-stdout.log. No cmd.exe, no shell redirect lock.
 */
var fs = require("fs");
var path = require("path");

var ENV_KEYS = [
  "PLAYON_API_URL",
  "PLAYON_NODE_TOKEN",
  "PLAYON_NODE_ID",
  "PLAYON_NODE_NAME",
  "PLAYON_DATA_ROOT",
  "PLAYON_RUNTIME",
  "PLAYON_INSTALL_ROOT",
];

function installRoot() {
  if (process.env.PLAYON_INSTALL_ROOT) return process.env.PLAYON_INSTALL_ROOT;
  return path.dirname(__filename);
}

function applyEnv(map) {
  for (var i = 0; i < ENV_KEYS.length; i++) {
    var key = ENV_KEYS[i];
    var value = map[key];
    if (typeof value === "string" && value && process.env[key] == null) {
      process.env[key] = value;
    }
  }
}

function loadJson(root) {
  var p = path.join(root, "node.env.json");
  if (!fs.existsSync(p)) return;
  var parsed = JSON.parse(fs.readFileSync(p, "utf8"));
  if (parsed && typeof parsed === "object") applyEnv(parsed);
}

function loadCmd(root) {
  var p = path.join(root, "node.env.cmd");
  if (!fs.existsSync(p)) return;
  var text = fs.readFileSync(p, "utf8");
  var map = {};
  var lines = text.split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var line = String(lines[i]).replace(/^\uFEFF/, "").trim();
    var m = /^set\s+([A-Z0-9_]+)=(.*)$/i.exec(line);
    if (m) map[m[1].toUpperCase()] = m[2];
  }
  applyEnv(map);
}

function attachLog(root) {
  var dataRoot = process.env.PLAYON_DATA_ROOT || path.join(root, "data");
  try {
    fs.mkdirSync(dataRoot, { recursive: true });
  } catch (_e) {}
  var logPath = path.join(dataRoot, "agent-stdout.log");
  var maxBytes = 5 * 1024 * 1024;
  try {
    var st = fs.statSync(logPath);
    if (st.size >= maxBytes) {
      var bak = logPath + ".1";
      try {
        fs.unlinkSync(bak);
      } catch (_e2) {}
      try {
        fs.renameSync(logPath, bak);
      } catch (_e3) {}
    }
  } catch (_e4) {}
  var stream;
  try {
    stream = fs.createWriteStream(logPath, { flags: "a" });
  } catch (_e5) {
    return;
  }
  function tee(orig) {
    return function (chunk, enc, cb) {
      try {
        stream.write(chunk);
      } catch (_e6) {}
      return orig.call(this, chunk, enc, cb);
    };
  }
  process.stdout.write = tee(process.stdout.write);
  process.stderr.write = tee(process.stderr.write);
}

var root = installRoot();
try {
  loadJson(root);
} catch (_e7) {}
try {
  loadCmd(root);
} catch (_e8) {}
if (!process.env.PLAYON_INSTALL_ROOT) process.env.PLAYON_INSTALL_ROOT = root;
attachLog(root);
