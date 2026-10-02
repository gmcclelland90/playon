import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodePng, decodePng } from "../png-lite.js";
import { encryptSecret } from "../secrets.js";
import { modsToolModule } from "./mods.js";
import type { ToolContext } from "./types.js";

const SECRET = "test-session-secret-32chars-min!!";
const KEY = "fal-live-key-should-never-leak";

let storedFal: unknown = null;
vi.mock("../settings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../settings.js")>();
  return { ...actual, getSetting: vi.fn(async () => storedFal) };
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

function queued(model: string, id: string): Response {
  const base = `https://queue.fal.run/${model}/requests/${id}`;
  return json({ status_url: `${base}/status`, response_url: base, cancel_url: `${base}/cancel` });
}

function setup(opts: { workspace?: boolean } = {}) {
  const written = new Map<string, Buffer>();
  const files = {
    list: vi.fn(async (rel: string) => {
      if (opts.workspace === false) throw new Error(`not_found ${rel}`);
      return [];
    }),
    ensureDir: vi.fn(async () => {}),
    writeBytes: vi.fn(async (rel: string, bytes: Buffer) => {
      written.set(rel, bytes);
    }),
  };
  const ctx = {
    plane: {
      servers: {
        get: vi.fn(async (id: string) =>
          id === "s1" ? { id, dataPath: "/nonexistent/playon-test", game: "project-zomboid" } : null,
        ),
        files: vi.fn(async () => files),
      },
      snapshots: {},
      db: {},
      config: { sessionSecret: SECRET },
    },
    workspace: { restrictTargets: false },
    skillRoots: [],
  } as unknown as ToolContext;
  const tool = modsToolModule(ctx).find((t) => t.def.name === "mods_assets_generate")!;
  const run = (args: Record<string, unknown>) =>
    tool.handler({ serverId: "s1", modId: "crate", prompt: "a crowbar", ...args }, { serverId: "s1" }) as Promise<
      Record<string, unknown>
    >;
  return { run, files, written };
}

describe("mods_assets_generate", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    storedFal = { apiKeyEncrypted: encryptSecret(SECRET, KEY) };
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns fal_key_missing without calling fal when no key is saved", async () => {
    storedFal = null;
    const out = await setup().run({});
    expect(out.error).toBe("fal_key_missing");
    expect(String(out.hint)).toContain("fal.ai/dashboard/keys");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses models off the allowlist and unknown kinds before spending", async () => {
    const { run } = setup();
    expect((await run({ model: "fal-ai/veo3" })).error).toBe("fal_model_not_allowed");
    expect((await run({ kind: "video" })).error).toBe("fal_bad_kind");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires an existing mods-src workspace", async () => {
    const out = await setup({ workspace: false }).run({});
    expect(out.error).toBe("workspace_not_found");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("writes a PZ-size icon under assets/ with a placement hint and no secrets", async () => {
    const big = new Uint8Array(128 * 128 * 4).fill(200);
    const png = encodePng({ width: 128, height: 128, data: big });
    fetchMock.mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === "POST" && u.endsWith("/fal-ai/flux/schnell")) return queued("fal-ai/flux/schnell", "g");
      if (init?.method === "POST" && u.endsWith("/fal-ai/birefnet")) return queued("fal-ai/birefnet", "c");
      if (u.endsWith("/status")) return json({ status: "COMPLETED" });
      if (u.endsWith("/requests/g")) return json({ images: [{ url: "https://v3.fal.media/g.png" }] });
      if (u.endsWith("/requests/c")) return json({ image: { url: "https://v3.fal.media/c.png" } });
      if (u === "https://v3.fal.media/c.png") return new Response(png, { headers: { "content-type": "image/png" } });
      throw new Error(`unexpected ${u}`);
    });
    const { run, written } = setup();
    const out = await run({ kind: "icon", fileName: "crowbar.png" });
    expect(out.error).toBeUndefined();
    expect(out.path).toBe("mods-src/crate/assets/crowbar.png");
    expect(out.width).toBe(32);
    expect(out.dialect).toBe("project-zomboid");
    expect(String(out.placementHint)).toContain("media/textures/Item_crowbar.png");
    const bytes = written.get("mods-src/crate/assets/crowbar.png");
    expect(bytes).toBeDefined();
    expect(decodePng(new Uint8Array(bytes!)).width).toBe(32);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toContain("fal.media");
    // Key goes only to the queue host, never to the CDN.
    for (const [url, init] of fetchMock.mock.calls) {
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (auth) expect(new URL(String(url)).hostname).toBe("queue.fal.run");
    }
  });

  it("strips directories from fileName and rejects dot-dot names", async () => {
    fetchMock.mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === "POST") return queued("fal-ai/flux/schnell", "g");
      if (u.endsWith("/status")) return json({ status: "COMPLETED" });
      if (u.endsWith("/requests/g")) return json({ images: [{ url: "https://v3.fal.media/g.png" }] });
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
    });
    const { run } = setup();
    expect((await run({ fileName: "../../etc/x.png" })).path).toBe("mods-src/crate/assets/x.png");
    expect((await run({ fileName: ".." })).error).toBe("unsafe_fileName");
  });
});
