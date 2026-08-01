import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { loadConfig } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveBootstrapSql(): string {
  const candidates = [
    path.join(__dirname, "bootstrap.sql"),
    path.join(__dirname, "../../src/db/bootstrap.sql"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`bootstrap.sql not found near ${__dirname}`);
}

export function applyBootstrap(dbPath: string) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const sql = fs.readFileSync(resolveBootstrapSql(), "utf8");
  const raw = new Database(dbPath);
  raw.exec(sql);
  raw.close();
}


const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]).includes(`${path.sep}migrate.`);

if (isMain) {
  const config = loadConfig();
  applyBootstrap(config.dbPath);
  console.log(`Migrated ${config.dbPath}`);
}
