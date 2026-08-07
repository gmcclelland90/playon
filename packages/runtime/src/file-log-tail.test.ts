import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { followLogFile, readLogFileTail } from "./file-log-tail.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("readLogFileTail", () => {
  it("returns last N lines", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playon-logtail-"));
    temps.push(dir);
    const file = path.join(dir, "console.log");
    fs.writeFileSync(file, ["a", "b", "c", "d", "e"].join("\n") + "\n", "utf8");
    expect(readLogFileTail(file, 3)).toEqual(["c", "d", "e"]);
  });

  it("returns empty for missing file", () => {
    expect(readLogFileTail(path.join(os.tmpdir(), "nope-missing.log"), 10)).toEqual([]);
  });
});

describe("followLogFile", () => {
  it("emits newly appended lines", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playon-logfollow-"));
    temps.push(dir);
    const file = path.join(dir, "console.log");
    fs.writeFileSync(file, "seed\n", "utf8");
    const lines: string[] = [];
    const handle = followLogFile(file, (line) => lines.push(line), { pollMs: 50 });
    fs.appendFileSync(file, "hello\nworld\n", "utf8");
    await new Promise((r) => setTimeout(r, 200));
    handle.abort();
    expect(lines).toEqual(["hello", "world"]);
  });
});
