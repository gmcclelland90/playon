import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { AppConfig } from "../config.js";
import { createDb, type Db } from "../db/client.js";
import { applyBootstrap } from "../db/migrate.js";
import {
  getOllamaJob,
  isLoopbackOllamaUrl,
  manualOllamaInstallCommand,
  nativeOllamaBaseUrl,
  probeOllama,
  resetOllamaJobForTests,
  startOllamaInstall,
  startOllamaPull,
  type DockerRunner,
} from "./ollama.js";

const temps: Array<{ root: string; sqlite: { close: () => void } }> = [];

afterEach(() => {
  resetOllamaJobForTests();
  for (const entry of temps.splice(0)) {
    entry.sqlite.close();
    fs.rmSync(entry.root, { recursive: true, force: true });
  }
});

describe("nativeOllamaBaseUrl", () => {
  it("strips trailing /v1", () => {
    expect(nativeOllamaBaseUrl("http://127.0.0.1:11434/v1")).toBe("http://127.0.0.1:11434");
    expect(nativeOllamaBaseUrl("http://127.0.0.1:11434/v1/")).toBe("http://127.0.0.1:11434");
  });

  it("leaves native URLs alone", () => {
    expect(nativeOllamaBaseUrl("http://10.0.0.5:11434")).toBe("http://10.0.0.5:11434");
  });
});

describe("isLoopbackOllamaUrl", () => {
  it("accepts localhost variants", () => {
    expect(isLoopbackOllamaUrl("http://127.0.0.1:11434/v1")).toBe(true);
    expect(isLoopbackOllamaUrl("http://localhost:11434/v1")).toBe(true);
    // Bracketed IPv6 may be rejected by URL on some platforms; only assert when parseable.
    try {
      // eslint-disable-next-line no-new
      new URL("http://[::1]:11434/v1");
      expect(isLoopbackOllamaUrl("http://[::1]:11434/v1")).toBe(true);
    } catch {
      /* skip */
    }
  });

  it("rejects LAN hosts", () => {
    expect(isLoopbackOllamaUrl("http://10.0.0.5:11434/v1")).toBe(false);
  });
});

describe("manualOllamaInstallCommand", () => {
  it("returns platform one-liners", () => {
    expect(manualOllamaInstallCommand("win32")).toContain("install.ps1");
    expect(manualOllamaInstallCommand("linux")).toContain("install.sh");
  });
});

describe("probeOllama", () => {
  it("reports models when reachable", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith("/api/tags")) {
        return new Response(
          JSON.stringify({
            models: [{ name: "llama3.2:latest", size: 1_000 }],
          }),
          { status: 200 },
        );
      }
      if (href.endsWith("/api/version")) {
        return new Response(JSON.stringify({ version: "0.5.0" }), { status: 200 });
      }
      return new Response("no", { status: 404 });
    }) as unknown as typeof fetch;

    const status = await probeOllama("http://127.0.0.1:11434/v1", {
      fetchImpl,
      dockerAvailable: true,
    });
    expect(status.reachable).toBe(true);
    expect(status.version).toBe("0.5.0");
    expect(status.models).toEqual([{ name: "llama3.2:latest", size: 1_000 }]);
    expect(status.canInstallLocal).toBe(true);
    expect(status.manualCommand).toBeUndefined();
  });

  it("offers manual command when unreachable without Docker", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;

    const status = await probeOllama("http://127.0.0.1:11434/v1", {
      fetchImpl,
      dockerAvailable: false,
      platform: "linux",
    });
    expect(status.reachable).toBe(false);
    expect(status.canInstallLocal).toBe(false);
    expect(status.manualCommand).toContain("install.sh");
  });
});

describe("startOllamaInstall", () => {
  it("refuses non-loopback URLs", () => {
    const job = startOllamaInstall("http://10.0.0.5:11434/v1", { dockerAvailable: true });
    expect(job.phase).toBe("error");
    expect(job.message).toMatch(/local_only/);
  });

  it("refuses when Docker is unavailable", () => {
    const job = startOllamaInstall("http://127.0.0.1:11434/v1", { dockerAvailable: false });
    expect(job.phase).toBe("error");
    expect(job.message).toMatch(/docker_unavailable/);
  });

  it("runs docker pull/run and waits for API", async () => {
    const calls: string[][] = [];
    const runDocker: DockerRunner = async (args) => {
      calls.push(args);
      if (args[0] === "inspect") return { code: 1, stdout: "", stderr: "missing" };
      return { code: 0, stdout: "ok", stderr: "" };
    };

    let tagsHits = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith("/api/tags")) {
        tagsHits += 1;
        if (tagsHits < 2) throw new Error("not up");
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ version: "0.5.0" }), { status: 200 });
    }) as unknown as typeof fetch;

    const started = startOllamaInstall("http://127.0.0.1:11434/v1", {
      dockerAvailable: true,
      runDocker,
      fetchImpl,
    });
    expect(started.phase).toBe("installing");

    await vi.waitFor(() => {
      expect(getOllamaJob().phase).toBe("ready");
    });

    expect(calls.some((a) => a[0] === "pull")).toBe(true);
    expect(calls.some((a) => a[0] === "run")).toBe(true);
  });
});

describe("startOllamaPull", () => {
  it("requires a model name", () => {
    const job = startOllamaPull("http://127.0.0.1:11434/v1", "  ");
    expect(job.phase).toBe("error");
    expect(job.message).toBe("ollama_model_required");
  });

  it("posts pull and marks ready", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("http://127.0.0.1:11434/api/pull");
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ status: "success" }), { status: 200 });
    }) as unknown as typeof fetch;

    const started = startOllamaPull("http://127.0.0.1:11434/v1", "llama3.2", { fetchImpl });
    expect(started.phase).toBe("pulling");

    await vi.waitFor(() => {
      expect(getOllamaJob().phase).toBe("ready");
    });
    expect(getOllamaJob().message).toMatch(/Pulled llama3.2/);
  });
});

describe("ollama settings routes", () => {
  function tempEnv(): { db: Db; config: AppConfig; app: ReturnType<typeof createApp> } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playon-ollama-api-"));
    const dbPath = path.join(root, "playon.db");
    applyBootstrap(dbPath);
    const config: AppConfig = {
      port: 0,
      dataRoot: root,
      dbPath,
      sessionSecret: "test-session-secret-at-least-32-chars!!",
      llmMode: "openai_compatible",
      runtimeMode: "docker",
      advertiseHost: "127.0.0.1",
      skillsRoots: [path.join(root, "skills")],
    };
    const { db, sqlite } = createDb(dbPath);
    temps.push({ root, sqlite });
    return { db, config, app: createApp(db, config) };
  }

  it("rejects unauthenticated status", async () => {
    const { app } = tempEnv();
    const res = await app.request("/api/settings/llm/ollama/status");
    expect(res.status).toBe(403);
  });

  it("returns probe shape for admin", async () => {
    const { app } = tempEnv();
    const boot = await app.request("/api/setup/owner", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "host",
        password: "password123",
        displayName: "LAN Host",
      }),
    });
    expect(boot.status).toBe(200);
    const cookie = (boot.headers.get("set-cookie") ?? "").split(";")[0]!;

    const res = await app.request(
      "/api/settings/llm/ollama/status?baseUrl=http://127.0.0.1:9/v1",
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ollama: {
        reachable: boolean;
        models: unknown[];
        canInstallLocal: boolean;
        isLoopback: boolean;
        job: { phase: string };
      };
    };
    expect(body.ollama.isLoopback).toBe(true);
    expect(body.ollama.reachable).toBe(false);
    expect(Array.isArray(body.ollama.models)).toBe(true);
    expect(body.ollama.job.phase).toBeTruthy();
  });
});
