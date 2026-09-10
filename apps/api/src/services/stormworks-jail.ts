import fs from "node:fs";
import path from "node:path";
import {
  stormworksJailOverlayPlan,
  stormworksServerConfigXml,
  stormworksStartBat,
} from "@playon/shared";

export type StormworksJailFile = {
  relPath: string;
  content: string;
};

/** Files that must land in game/ so the dedicated PE binds UDP 25564. */
export function stormworksJailOverlayFiles(existing: {
  startBat?: string | null;
  configXml?: string | null;
}): StormworksJailFile[] {
  const plan = stormworksJailOverlayPlan(existing);
  const out: StormworksJailFile[] = [];
  if (plan.writeStartBat) {
    out.push({ relPath: "start.bat", content: stormworksStartBat() });
  }
  if (plan.writeConfig) {
    out.push({ relPath: "server_data/server_config.xml", content: stormworksServerConfigXml() });
  }
  return out;
}

/**
 * Write Stormworks start.bat + server_config.xml into a local game/ jail.
 * Existing host config with a valid port is left alone; a start.bat that
 * already has +server_dir and server64.exe is left alone.
 */
export function ensureStormworksGameJail(gameDir: string): string[] {
  if (!fs.existsSync(gameDir)) {
    fs.mkdirSync(gameDir, { recursive: true });
  }
  const batPath = path.join(gameDir, "start.bat");
  const configPath = path.join(gameDir, "server_data", "server_config.xml");
  const startBat = fs.existsSync(batPath) ? fs.readFileSync(batPath, "utf8") : "";
  const configXml = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  const files = stormworksJailOverlayFiles({ startBat, configXml });
  const written: string[] = [];
  for (const file of files) {
    const dest = path.join(gameDir, ...file.relPath.split("/"));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, file.content);
    written.push(file.relPath);
  }
  return written;
}
