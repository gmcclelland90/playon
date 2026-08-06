import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { swapInstallTree } from "./apply-update.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-apply-test-"));

try {
  const target = path.join(root, "target");
  const source = path.join(root, "source");
  fs.mkdirSync(path.join(target, "apps", "api", "data"), { recursive: true });
  fs.writeFileSync(path.join(target, "apps", "api", "data", "keep.db"), "db");
  fs.writeFileSync(path.join(target, "package.json"), JSON.stringify({ version: "0.1.5" }));
  fs.mkdirSync(path.join(target, "apps", "api", "dist"), { recursive: true });
  fs.writeFileSync(path.join(target, "apps", "api", "dist", "old.js"), "old");

  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ version: "0.1.6" }));
  fs.mkdirSync(path.join(source, "apps", "api", "dist"), { recursive: true });
  fs.writeFileSync(path.join(source, "apps", "api", "dist", "new.js"), "new");
  fs.mkdirSync(path.join(source, "apps", "api", "data"), { recursive: true });
  fs.writeFileSync(path.join(source, "apps", "api", "data", "wipe.db"), "wipe");

  const result = swapInstallTree({
    target,
    source,
    preserve: ["data", "env", "apps/api/data"],
  });
  assert.ok(result.preserved.includes("apps/api/data"));
  assert.equal(fs.readFileSync(path.join(target, "package.json"), "utf8"), JSON.stringify({ version: "0.1.6" }));
  assert.equal(fs.readFileSync(path.join(target, "apps", "api", "data", "keep.db"), "utf8"), "db");
  assert.equal(fs.existsSync(path.join(target, "apps", "api", "data", "wipe.db")), false);
  assert.equal(fs.readFileSync(path.join(target, "apps", "api", "dist", "new.js"), "utf8"), "new");

  const nestedSource = path.join(target, "apps", "api", "data", ".updates", "extracted");
  fs.mkdirSync(nestedSource, { recursive: true });
  fs.writeFileSync(path.join(nestedSource, "package.json"), "{}");
  assert.throws(
    () => swapInstallTree({ target, source: nestedSource, preserve: ["data"] }),
    /update_source_inside_target/,
  );

  // Symlinked workspace packages (pnpm) must be recreated, not copyFile'd.
  if (process.platform !== "win32") {
    const symRoot = path.join(root, "sym");
    const symTarget = path.join(symRoot, "target");
    const symSource = path.join(symRoot, "source");
    fs.mkdirSync(path.join(symSource, "packages", "shared"), { recursive: true });
    fs.writeFileSync(path.join(symSource, "packages", "shared", "index.js"), "shared");
    fs.writeFileSync(path.join(symSource, "package.json"), "{}");
    fs.mkdirSync(path.join(symSource, "apps", "api", "node_modules", "@playon"), {
      recursive: true,
    });
    fs.symlinkSync(
      "../../../../packages/shared",
      path.join(symSource, "apps", "api", "node_modules", "@playon", "shared"),
    );
    fs.mkdirSync(symTarget, { recursive: true });
    swapInstallTree({ target: symTarget, source: symSource, preserve: ["data"] });
    const linkPath = path.join(symTarget, "apps", "api", "node_modules", "@playon", "shared");
    assert.ok(fs.lstatSync(linkPath).isSymbolicLink());
    assert.equal(fs.readlinkSync(linkPath).replace(/\\/g, "/"), "../../../../packages/shared");
  }

  console.log("ok", path.basename(fileURLToPath(import.meta.url)));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
