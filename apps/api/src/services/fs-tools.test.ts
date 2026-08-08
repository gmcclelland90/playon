import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NODE_AUTHORITATIVE_MARKER } from "@playon/shared";
import * as nodeRuntime from "./node-runtime.js";
import { nodeJailRel, ServerFsService } from "./fs-tools.js";

const temps: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of temps.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("nodeJailRel", () => {
  it("maps server-relative paths onto the node jail", () => {
    expect(nodeJailRel("abc")).toBe("servers/abc");
    expect(nodeJailRel("abc", "game/foo.ini")).toBe("servers/abc/game/foo.ini");
  });
});

describe("ServerFsService facade", () => {
  it("delegates list/read through openServerFileStore", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-fs-facade-"));
    temps.push(root);
    const dataPath = path.join(root, "servers", "s1");
    fs.mkdirSync(dataPath, { recursive: true });
    fs.writeFileSync(path.join(dataPath, NODE_AUTHORITATIVE_MARKER), "node-z\n");

    vi.spyOn(nodeRuntime, "dispatchNodeJob").mockImplementation(async (opts) => {
      const args = (opts.args ?? {}) as Record<string, string>;
      if (opts.kind === "fs_list") {
        return { path: args.path, entries: [{ name: "Server", type: "dir" as const }] };
      }
      if (opts.kind === "fs_read_text") {
        return {
          path: String(args.path),
          content: "ok",
          bytesRead: 2,
          truncated: false,
          size: 2,
        };
      }
      throw new Error(`unexpected ${opts.kind}`);
    });

    const servers = {
      get: async () => ({
        id: "s1",
        name: "n",
        game: "g",
        nodeId: "node-z",
        runtimeMode: "native",
        status: "stopped",
        dataPath,
        createdAt: new Date(),
      }),
    };
    const fsSvc = new ServerFsService(servers as never);
    expect(await fsSvc.list("s1", "home")).toEqual([{ name: "Server", type: "dir" }]);
    expect((await fsSvc.read("s1", "home/x.ini")).content).toBe("ok");
  });
});
