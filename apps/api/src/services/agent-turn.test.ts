import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmClient } from "@playon/agent-core";
import type { Watcher } from "@playon/shared";
import type { AppConfig } from "../config.js";
import { createControlPlane } from "../control-plane.js";
import { createDb, type Db } from "../db/client.js";
import { applyBootstrap } from "../db/migrate.js";
import { users } from "../db/schema.js";
import { AgentTurn, type AgentTurnInput } from "./agent-turn.js";
import { runWatcherAction } from "./watcher-actions.js";
import { WatcherLogBuffer } from "./watcher-context.js";

const temps: Array<{ root: string; close: () => void }> = [];

afterEach(() => {
  for (const entry of temps.splice(0)) {
    entry.close();
    rmSync(entry.root, { recursive: true, force: true });
  }
});

function testConfig(dataRoot: string): AppConfig {
  return {
    port: 0,
    advertiseHost: "127.0.0.1",
    dataRoot,
    dbPath: path.join(dataRoot, "playon.sqlite"),
    sessionSecret: "test-session-secret-at-least-32-chars!!",
    skillsRoots: [path.join(process.cwd(), "skills")],
    llmMode: "openai_compatible",
    runtimeMode: "docker",
  };
}

function sampleWatcher(overrides: Partial<Watcher> = {}): Watcher {
  const now = Date.now();
  return {
    id: "w1",
    serverId: "srv-1",
    name: "Nightly",
    enabled: true,
    trigger: { kind: "schedule", intervalMs: 60_000 },
    action: { kind: "agent", prompt: "check health", includeContext: false },
    cooldownMs: 60_000,
    debounceMs: 0,
    confirmMode: "auto",
    source: "user",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function tempPlane(): Promise<{
  db: Db;
  plane: ReturnType<typeof createControlPlane>;
  userId: string;
}> {
  const root = mkdtempSync(path.join(tmpdir(), "playon-agent-turn-"));
  const dbPath = path.join(root, "playon.sqlite");
  applyBootstrap(dbPath);
  const { db, sqlite } = createDb(dbPath);
  temps.push({ root, close: () => sqlite.close() });
  const plane = createControlPlane(db, testConfig(root));
  const userId = "user-1";
  await db.insert(users).values({
    id: userId,
    username: "owner",
    displayName: "Owner",
    passwordHash: "x",
    role: "admin",
    createdAt: new Date(),
  });
  return { db, plane, userId };
}

function stubLlm(reply = "stub-reply"): LlmClient {
  return {
    mode: "openai_compatible",
    complete: async () => ({ content: reply }),
  };
}

describe("AgentTurn", () => {
  it("exposes one runner on the control plane", async () => {
    const { plane } = await tempPlane();
    expect(plane.agentTurn).toBeInstanceOf(AgentTurn);
  });

  it("chat and watcher share the same plane.agentTurn.run choke", async () => {
    const { plane, userId } = await tempPlane();
    const sources: AgentTurnInput["source"][] = [];
    const spy = vi.spyOn(plane.agentTurn, "run").mockImplementation(async (input) => {
      sources.push(input.source);
      return {
        conversationId: `conv-${input.source}`,
        serverId: input.source === "watcher" ? input.serverId : undefined,
        reply: `ok-${input.source}`,
        toolTrace: [],
      };
    });

    await plane.agentTurn.run({
      source: "chat",
      userId,
      prompt: "hello from chat",
      abortSignal: new AbortController().signal,
    });

    const outcome = await runWatcherAction(
      plane,
      sampleWatcher(),
      new WatcherLogBuffer(),
      { reason: "test" },
    );

    expect(spy).toHaveBeenCalledTimes(2);
    expect(sources).toEqual(["chat", "watcher"]);
    expect(outcome.ok).toBe(true);
    expect(outcome.result.content).toBe("ok-watcher");
    expect(
      spy.mock.calls.some(
        ([input]) =>
          input.source === "watcher" &&
          input.watcherId === "w1" &&
          input.prompt.includes("check health"),
      ),
    ).toBe(true);
  });

  it("runs chat and watcher through one AgentTurn with a stub LLM", async () => {
    const { plane, userId } = await tempPlane();
    const turn = new AgentTurn(plane, {
      createLlmClient: async () => stubLlm("shared-runner"),
    });
    plane.agentTurn = turn;

    const chat = await turn.run({
      source: "chat",
      userId,
      prompt: "hi",
      abortSignal: new AbortController().signal,
    });
    expect(chat.reply).toBe("shared-runner");
    expect(chat.conversationId).toBeTruthy();
    expect(chat.aborted).toBeUndefined();

    const watcherOutcome = await runWatcherAction(
      plane,
      sampleWatcher({
        id: "w2",
        serverId: "srv-2",
        name: "Probe",
        action: { kind: "agent", prompt: "ping", includeContext: false },
      }),
      new WatcherLogBuffer(),
      {},
    );
    expect(watcherOutcome.ok).toBe(true);
    expect(watcherOutcome.result.content).toBe("shared-runner");
    expect(watcherOutcome.result.conversationId).toBeTruthy();
  });

  it("preserves chat bind errors as AgentTurnError codes", async () => {
    const { plane, userId } = await tempPlane();
    const turn = new AgentTurn(plane, {
      createLlmClient: async () => stubLlm(),
    });

    await expect(
      turn.run({
        source: "chat",
        userId,
        prompt: "hello",
        conversationId: "ghost",
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "conversation_not_found" });

    await expect(
      turn.run({
        source: "chat",
        userId,
        prompt: "hello",
        serverId: "missing-server",
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "server_not_found" });
  });
});
