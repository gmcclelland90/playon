import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NODE_AUTHORITATIVE_MARKER } from "@playon/shared";
import * as nodeRuntime from "./node-runtime.js";
import {
  nodeJailRel,
  openServerFileStore,
  ServerFileStoreError,
} from "./server-file-store.js";

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

describe("openServerFileStore", () => {
  it("dispatches fs_list/read to the node when marker is present", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-fs-"));
    temps.push(root);
    const dataPath = path.join(root, "servers", "s1");
    fs.mkdirSync(dataPath, { recursive: true });
    fs.writeFileSync(path.join(dataPath, NODE_AUTHORITATIVE_MARKER), "node-z\n");

    const dispatch = vi.spyOn(nodeRuntime, "dispatchNodeJob").mockImplementation(async (opts) => {
      const args = (opts.args ?? {}) as Record<string, string>;
      if (opts.kind === "fs_list") {
        expect(args.path).toBe("servers/s1/home/Zomboid");
        return {
          path: args.path,
          entries: [{ name: "Server", type: "dir" as const }],
        };
      }
      if (opts.kind === "fs_read_text") {
        expect(args.path).toBe("servers/s1/home/Zomboid/Server/x.ini");
        return {
          path: String(args.path),
          content: "WorkshopItems=1",
          bytesRead: 15,
          truncated: false,
          size: 15,
        };
      }
      throw new Error(`unexpected ${opts.kind}`);
    });

    const store = openServerFileStore({
      id: "s1",
      nodeId: "node-z",
      dataPath,
    });
    expect(store.locality).toBe("remote");
    const listing = await store.list("home/Zomboid");
    expect(listing).toEqual([{ name: "Server", type: "dir" }]);
    const read = await store.readText("home/Zomboid/Server/x.ini");
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
      const args = (opts.args ?? {}) as Record<string, string>;
      seen.push({ kind: opts.kind, ...args });
      if (opts.kind === "fs_read_text") {
        return { path: String(args.path), content: "", bytesRead: 0, truncated: false, size: 0 };
      }
      return { from: String(args.from), to: String(args.to) };
    });

    const store = openServerFileStore({ id: "s3", nodeId: "node-z", dataPath });
    await store.readText("game/a.ini", { offset: 10.7, maxBytes: 0 });
    expect(seen[0]).toMatchObject({ kind: "fs_read_text", offset: 10, maxBytes: 1 });

    const renamed = await store.rename("game/a.ini", "game/b.ini");
    expect(renamed).toEqual({ from: "game/a.ini", to: "game/b.ini" });
    expect(seen[1]).toMatchObject({ from: "servers/s3/game/a.ini", to: "servers/s3/game/b.ini" });
  });

  it("uses the Home jail when not node-authoritative", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-fs-home-"));
    temps.push(root);
    const dataPath = path.join(root, "servers", "s2");
    fs.mkdirSync(path.join(dataPath, "game"), { recursive: true });
    fs.writeFileSync(path.join(dataPath, "game", "hello.txt"), "hi");

    const store = openServerFileStore({
      id: "s2",
      nodeId: "local",
      dataPath,
    });
    expect(store.locality).toBe("local");
    const listing = await store.list("game");
    expect(listing.some((e) => e.name === "hello.txt")).toBe(true);
    const read = await store.readText("game/hello.txt");
    expect(read.content).toBe("hi");
  });

  it("ensureDir on a remote nodeId always hits the node job", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-fs-ensure-"));
    temps.push(root);
    const dataPath = path.join(root, "servers", "s4");
    fs.mkdirSync(dataPath, { recursive: true });
    // No authoritative marker — still provision on the node.

    const dispatch = vi.spyOn(nodeRuntime, "dispatchNodeJob").mockImplementation(async (opts) => {
      expect(opts.kind).toBe("fs_ensure_dir");
      expect((opts.args as { path: string }).path).toBe("servers/s4/game");
      return { path: "servers/s4/game", ok: true };
    });

    const store = openServerFileStore({ id: "s4", nodeId: "node-z", dataPath });
    expect(store.locality).toBe("local");
    const result = await store.ensureDir("game");
    expect(result).toEqual({ path: "game", ok: true });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("maps path escapes to ServerFileStoreError", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-fs-jail-"));
    temps.push(root);
    const dataPath = path.join(root, "servers", "s5");
    fs.mkdirSync(dataPath, { recursive: true });
    const store = openServerFileStore({ id: "s5", nodeId: "local", dataPath });
    await expect(store.readText("../escape.txt")).rejects.toMatchObject({
      name: "ServerFileStoreError",
      code: "path_escape",
    } satisfies Partial<ServerFileStoreError>);
  });
});
