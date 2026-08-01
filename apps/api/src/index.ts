import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { applyBootstrap } from "./db/migrate.js";
import { createApp } from "./app.js";
import { ServerService } from "./services/servers.js";
import { SnapshotScheduler } from "./services/snapshot-scheduler.js";
import { SnapshotService } from "./services/snapshots.js";

const config = loadConfig();
applyBootstrap(config.dbPath);
const { db } = createDb(config.dbPath);
const app = createApp(db, config);

const host = process.env.PLAYON_HOST ?? "127.0.0.1";
console.log(`PlayOn API listening on http://${host}:${config.port}`);
console.log(`data root: ${config.dataRoot}`);
console.log(`llm=${config.llmMode} runtime=${config.runtimeMode}`);

const server = serve({ fetch: app.fetch, port: config.port, hostname: host });
app.injectWebSocket(server as Parameters<typeof app.injectWebSocket>[0]);

const snapshotScheduler = new SnapshotScheduler(
  new SnapshotService(db, config, new ServerService(db, config, app.eventHub)),
);
snapshotScheduler.start();
