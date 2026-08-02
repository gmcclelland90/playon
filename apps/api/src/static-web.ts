import fs from "node:fs";
import path from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";

/** True when a Vite (or test) web build exists at webDist. */
export function webDistReady(webDist: string): boolean {
  return fs.existsSync(path.join(webDist, "index.html"));
}

/**
 * Mount built SPA assets + index.html fallback for non-/api GETs.
 * Call after all `/api/*` routes are registered. No-op if dist missing.
 */
export function mountStaticWeb(app: { use: Function; get: Function }, webDist: string): boolean {
  if (!webDistReady(webDist)) return false;
  const root = path.resolve(webDist);

  app.use("*", async (c: { req: { url: string }; json: Function; html: Function }, next: () => Promise<void>) => {
    const pathname = new URL(c.req.url).pathname;
    if (pathname.startsWith("/api")) {
      await next();
      return;
    }
    return serveStatic({ root })(c as never, next);
  });

  app.get("*", async (c: { req: { url: string }; json: Function; html: Function }) => {
    const pathname = new URL(c.req.url).pathname;
    if (pathname.startsWith("/api")) {
      return c.json({ error: "not_found" }, 404);
    }
    const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
    return c.html(html);
  });

  return true;
}
