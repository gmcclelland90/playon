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
    expect(nodeJailRel("abc", ".")).toBe("servers/abc");
    expect(nodeJailRel("abc", "game/foo.ini")).toBe("servers/abc/game/foo.ini");
    expect(nodeJailRel("abc", "./home/Zomboid")).toBe("servers/abc/home/Zomboid");
  });
});

describe("ServerFsService node-authoritative routing", () => {
  it("dispatches fs_list/read to the node when marker is present", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-fs-"));
    temps.push(root);
    const dataPath = path.join(root, "servers", "s1");
    fs.mkdirSync(dataPath, { recursive: true });
    fs.writeFileSync(path.join(dataPath, NODE_AUTHORITATIVE_MARKER), "node-z\n");

    const dispatch = vi.spyOn(nodeRuntime, "dispatchNodeJob").mockImplementation(async (opts) => {
      if (opts.kind === "fs_list") {
        expect(opts.args?.path).toBe("servers/s1/home/Zomboid");
        return {
          path: opts.args?.path,
          entries: [{ name: "Server", type: "dir" as const }],
        };
      }
      if (opts.kind === "fs_read_text") {
        expect(opts.args?.path).toBe("servers/s1/home/Zomboid/Server/x.ini");
        return {
          path: String(opts.args?.path),
          content: "WorkshopItems=1",
          bytesRead: 15,
          truncated: false,
          size: 15,
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
    const listing = await fsSvc.list("s1", "home/Zomboid");
    expect(listing).toEqual([{ name: "Server", type: "dir" }]);
    const read = await fsSvc.read("s1", "home/Zomboid/Server/x.ini");
    expect(read.content).toBe("WorkshopItems=1");
    expect(dispatch).toHaveBeenCalled();
  });

  it("repairs a sloppy read window and answers renames in caller terms", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-fs-clamp-"));
    temps.push(root);
    const dataPath = path.join(root, "servers", "s3");
    fs.mkdirSync(dataPath, { recursive: true });
    fs.writeFileSync(path.join(dataPath, NODE_AUTHORITATIVE_MARKER), "node-z\n");

    const seen: Array<Record<string, unknown>> = [];
    vi.spyOn(nodeRuntime, "dispatchNodeJob").mockImplementation(async (opts) => {
      seen.push({ kind: opts.kind, ...opts.args });
      if (opts.kind === "fs_read_text") {
        return { path: String(opts.args?.path), content: "", bytesRead: 0, truncated: false, size: 0 };
      }
      return { from: String(opts.args?.from), to: String(opts.args?.to) };
    });

    const servers = {
      get: async () => ({
        id: "s3",
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

    // An LLM-sourced window must not fail contract validation over a float or a zero.
    await fsSvc.read("s3", "game/a.ini", { offset: 10.7, maxBytes: 0 });
    expect(seen[0]).toMatchObject({ kind: "fs_read_text", offset: 10, maxBytes: 1 });

    const renamed = await fsSvc.rename("s3", "game/a.ini", "game/b.ini");
    expect(renamed).toEqual({ from: "game/a.ini", to: "game/b.ini" });
    expect(seen[1]).toMatchObject({ from: "servers/s3/game/a.ini", to: "servers/s3/game/b.ini" });
  });

  it("uses the Home jail when not node-authoritative", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-fs-home-"));
    temps.push(root);
    const dataPath = path.join(root, "servers", "s2");
    fs.mkdirSync(path.join(dataPath, "game"), { recursive: true });
    fs.writeFileSync(path.join(dataPath, "game", "hello.txt"), "hi");

    const servers = {
      get: async () => ({
        id: "s2",
        name: "n",
        game: "g",
        nodeId: "local",
        runtimeMode: "native",
        status: "stopped",
        dataPath,
        createdAt: new Date(),
      }),
    };
    const fsSvc = new ServerFsService(servers as never);
    const listing = await fsSvc.list("s2", "game");
    expect(listing.some((e) => e.name === "hello.txt")).toBe(true);
    const read = await fsSvc.read("s2", "game/hello.txt");
    expect(read.content).toBe("hi");
  });
});
