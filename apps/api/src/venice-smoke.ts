/**
 * Optional smoke against the local saved OpenAI-compatible settings (e.g. Venice).
 * Does not print API keys. Uses apps/api/data by default.
 *
 *   pnpm --filter @playon/api smoke:venice
 */
import fs from "node:fs";
import path from "node:path";
import { createDb } from "./db/client.js";
import { loadConfig } from "./config.js";
import { createLlmClient } from "./services/tools.js";

async function main(): Promise<number> {
  const dataRoot = process.env.PLAYON_DATA_ROOT ?? path.resolve(process.cwd(), "data");
  if (!fs.existsSync(path.join(dataRoot, "playon.db"))) {
    console.error("No playon.db under", dataRoot);
    return 1;
  }

  process.env.PLAYON_DATA_ROOT = dataRoot;
  const config = loadConfig(process.env);
  const { db } = createDb(config.dbPath);
  const llm = await createLlmClient(db, config);
  console.log("provider_mode=", llm.mode);
  const completion = await llm.complete([
    {
      role: "user",
      content: "Reply with exactly: playon-ok",
    },
  ]);
  const text = (completion.content ?? "").trim();
  console.log("reply_len=", text.length);
  console.log("reply_preview=", text.slice(0, 120).replace(/\s+/g, " "));
  if (!/playon-ok/i.test(text)) {
    console.error("Unexpected reply (expected playon-ok).");
    return 3;
  }
  console.log("venice_smoke=ok");
  return 0;
}


main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
