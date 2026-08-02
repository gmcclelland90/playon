import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { querySkillModule } from "./loader.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeSkill(connectorSource: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playon-query-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, "query"), { recursive: true });
  fs.writeFileSync(path.join(dir, "query", "connector.mjs"), connectorSource, "utf8");
  return dir;
}

describe("querySkillModule", () => {
  it("loads a skill connector and validates LiveServerState", async () => {
    const skillDir = writeSkill(`
export default async function query(ctx) {
  return { online: true, players: 1, maxPlayers: 8, map: "test", name: ctx.host };
}
`);
    const state = await querySkillModule(
      { skillDir },
      { host: "127.0.0.1", port: 9999, timeoutMs: 2000 },
    );
    expect(state.online).toBe(true);
    expect(state.players).toBe(1);
    expect(state.map).toBe("test");
    expect(state.name).toBe("127.0.0.1");
  });

  it("returns offline when schema validation fails", async () => {
    const skillDir = writeSkill(`
export default async function query() {
  return { online: "yes" };
}
`);
    const state = await querySkillModule(
      { skillDir },
      { host: "127.0.0.1", port: 9999, timeoutMs: 2000 },
    );
    expect(state.online).toBe(false);
    expect(state.error).toMatch(/invalid_live_state/);
  });

  it("returns offline on timeout", async () => {
    const skillDir = writeSkill(`
export default async function query() {
  await new Promise((r) => setTimeout(r, 5000));
  return { online: true };
}
`);
    const state = await querySkillModule(
      { skillDir },
      { host: "127.0.0.1", port: 9999, timeoutMs: 100 },
    );
    expect(state.online).toBe(false);
    expect(state.error).toMatch(/timeout/);
  });
});
