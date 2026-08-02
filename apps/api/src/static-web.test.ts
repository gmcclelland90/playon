import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { mountStaticWeb, webDistReady } from "./static-web.js";

const temps: string[] = [];

afterEach(() => {
  for (const root of temps.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("mountStaticWeb", () => {
  it("serves assets and SPA fallback from a fake web dist", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-web-"));
    temps.push(root);
    fs.writeFileSync(path.join(root, "index.html"), "<!doctype html><title>PlayOn</title>");
    fs.writeFileSync(path.join(root, "app.js"), "console.log('ok')");

    expect(webDistReady(root)).toBe(true);

    const app = new Hono();
    app.get("/api/healthz", (c) => c.json({ ok: true }));
    mountStaticWeb(app, root);

    const api = await app.request("/api/healthz");
    expect(api.status).toBe(200);

    const asset = await app.request("/app.js");
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain("console.log");

    const spa = await app.request("/map");
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain("PlayOn");
  });

  it("no-ops when dist is missing", () => {
    const app = new Hono();
    app.get("/api/x", (c) => c.json({ ok: true }));
    expect(mountStaticWeb(app, path.join(os.tmpdir(), "missing-playon-web-dist"))).toBe(false);
  });
});
