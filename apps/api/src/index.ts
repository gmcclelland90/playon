import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { applyBootstrap } from "./db/migrate.js";
import { createApp } from "./app.js";
import { LiveQueryScheduler } from "./services/live-query-scheduler.js";
import { SnapshotScheduler } from "./services/snapshot-scheduler.js";
import { webDistReady } from "./static-web.js";

const config = loadConfig();
applyBootstrap(config.dbPath);
const { db } = createDb(config.dbPath);
const app = createApp(db, config);
const { servers, playerPanel, queries, snapshots } = app.controlPlane;

const host = config.host ?? "127.0.0.1";
const webReady = Boolean(config.webDist && webDistReady(config.webDist));

console.log(
  JSON.stringify({
    msg: "playon_start",
    env: config.isProduction ? "production" : "development",
    bind: `http://${host}:${config.port}`,
    advertiseHost: config.advertiseHost,
    webDist: config.webDist,
    webDistReady: webReady,
    llmMode: config.llmMode,
    runtimeMode: config.runtimeMode,
    dataRoot: config.dataRoot,
  }),
);

if (config.isProduction && !webReady) {
  console.warn(
    JSON.stringify({
      msg: "playon_web_dist_missing",
      hint: "run pnpm build so apps/web/dist exists, or set PLAYON_WEB_DIST",
      webDist: config.webDist,
    }),
  );
}

const server = serve({ fetch: app.fetch, port: config.port, hostname: host });
app.injectWebSocket(server as Parameters<typeof app.injectWebSocket>[0]);

const snapshotScheduler = new SnapshotScheduler(snapshots);
snapshotScheduler.start();

const liveQueryScheduler = new LiveQueryScheduler(servers, playerPanel, queries);
liveQueryScheduler.start();
