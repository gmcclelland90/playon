import { describe, expect, it } from "vitest";
import { IntentMockLlmClient } from "./llm.js";
import { MockLlmClient } from "./llm.js";
import { Orchestrator } from "./orchestrator.js";
import type { ToolDefinition } from "./tools.js";

describe("Orchestrator", () => {
  it("returns mock LLM content", async () => {
    const orch = new Orchestrator(new MockLlmClient({ content: "Let's install Paper." }));
    const result = await orch.handle("installer", "spin up minecraft");
    expect(result.persona).toBe("installer");
    expect(result.content).toContain("Paper");
    expect(result.toolTrace).toEqual([]);
  });

  it("emits stream tokens and tool lifecycle events", async () => {
    const tokens: string[] = [];
    const tools: string[] = [];
    let calls = 0;
    const client = {
      mode: "mock" as const,
      async complete() {
        calls += 1;
        if (calls === 1) {
          return {
            content: "",
            toolCalls: [{ id: "1", name: "echo", arguments: { text: "hi" } }],
          };
        }
        return { content: "All done." };
      },
    };
    const orch = new Orchestrator(client, {
      stream: {
        conversationId: "c1",
        onToken: (t) => tokens.push(t),
        onTool: (info) => tools.push(`${info.toolName}:${info.status}`),
      },
    });
    orch.registerTool(
      {
        name: "echo",
        description: "echo",
        parameters: { type: "object", properties: {} },
      },
      async () => ({ ok: true }),
    );
    const result = await orch.handle("orchestrator", "go");
    expect(tools).toEqual(["echo:started", "echo:completed"]);
    expect(tokens.join("")).toContain("All done");
    expect(result.content).toBe("All done.");
  });

  it("gates requiresConfirm tools until the host approves", async () => {
    let calls = 0;
    let ran = false;
    const client = {
      mode: "mock" as const,
      async complete() {
        calls += 1;
        if (calls === 1) {
          return {
            content: "",
            toolCalls: [{ id: "1", name: "servers_stop", arguments: { serverId: "s1" } }],
          };
        }
        return { content: "stopped after confirm" };
      },
    };
    const orch = new Orchestrator(client, {
      confirmGate: {
        async requestConfirmation(request) {
          expect(request.toolName).toBe("servers_stop");
          return { requestId: "req-1", approved: true };
        },
      },
    });
    orch.registerTool(
      {
        name: "servers_stop",
        description: "stop",
        requiresConfirm: true,
        parameters: { type: "object", properties: {} },
      },
      async () => {
        ran = true;
        return { status: "stopped" };
      },
    );
    const result = await orch.handle("orchestrator", "stop it");
    expect(ran).toBe(true);
    expect(result.toolTrace[0]?.result).toMatchObject({ status: "stopped", confirmRequestId: "req-1" });
    expect(result.content).toBe("stopped after confirm");
  });

  it("skips requiresConfirm tools when the host denies", async () => {
    let calls = 0;
    let ran = false;
    const client = {
      mode: "mock" as const,
      async complete() {
        calls += 1;
        if (calls === 1) {
          return {
            content: "",
            toolCalls: [{ id: "1", name: "servers_stop", arguments: { serverId: "s1" } }],
          };
        }
        return { content: "denied" };
      },
    };
    const orch = new Orchestrator(client, {
      confirmGate: {
        async requestConfirmation() {
          return { requestId: "req-deny", approved: false };
        },
      },
    });
    orch.registerTool(
      {
        name: "servers_stop",
        description: "stop",
        requiresConfirm: true,
        parameters: { type: "object", properties: {} },
      },
      async () => {
        ran = true;
        return { status: "stopped" };
      },
    );
    const result = await orch.handle("orchestrator", "stop it");
    expect(ran).toBe(false);
    expect(result.toolTrace[0]?.result).toMatchObject({
      error: "confirm_denied",
      requestId: "req-deny",
    });
  });

  it("executes tool calls from the LLM", async () => {
    let calls = 0;
    const client = {
      mode: "mock" as const,
      async complete() {
        calls += 1;
        if (calls === 1) {
          return {
            content: "",
            toolCalls: [{ id: "1", name: "echo", arguments: { text: "hi" } }],
          };
        }
        return { content: "done" };
      },
    };
    const orch = new Orchestrator(client);
    const def: ToolDefinition = {
      name: "echo",
      description: "echo",
      parameters: { type: "object", properties: {} },
    };
    orch.registerTool(def, async (args) => ({ echoed: args.text }));
    const result = await orch.handle("orchestrator", "test");
    expect(result.toolTrace).toHaveLength(1);
    expect(result.toolTrace[0]?.result).toEqual({ echoed: "hi" });
    expect(result.content).toBe("done");
  });
});

describe("IntentMockLlmClient", () => {
  it("returns tool path for fixture install messages", async () => {
    const client = new IntentMockLlmClient();
    const orch = new Orchestrator(client);
    orch.registerTool(
      {
        name: "servers_create_from_skill",
        description: "create",
        parameters: { type: "object", properties: {} },
      },
      async () => ({ serverId: "srv-1", name: "Fake HTTP Fixture" }),
    );
    orch.registerTool(
      {
        name: "panel_publish",
        description: "publish",
        parameters: { type: "object", properties: {} },
      },
      async () => ({ published: 2 }),
    );

    const result = await orch.handle("installer", "install fake-http fixture");
    expect(result.toolTrace.map((t) => t.name)).toEqual([
      "servers_create_from_skill",
      "panel_publish",
    ]);
    expect(result.content).toContain("fake-http fixture");
  });

  it("returns settings hint for unrelated messages", async () => {
    const client = new IntentMockLlmClient();
    const completion = await client.complete([{ role: "user", content: "hello there" }]);
    expect(completion.content).toContain("mock LLM mode");
    expect(completion.toolCalls).toBeUndefined();
  });

  it("returns tool path for Paper Minecraft install messages", async () => {
    const client = new IntentMockLlmClient();
    const orch = new Orchestrator(client);
    orch.registerTool(
      {
        name: "servers_create_from_skill",
        description: "create",
        parameters: { type: "object", properties: {} },
      },
      async (args) => {
        expect(args.skillName).toBe("games.minecraft-paper");
        return { serverId: "srv-paper", name: "Paper Minecraft" };
      },
    );
    orch.registerTool(
      {
        name: "panel_publish",
        description: "publish",
        parameters: { type: "object", properties: {} },
      },
      async () => ({ published: 2 }),
    );

    const result = await orch.handle("installer", "spin up paper minecraft");
    expect(result.toolTrace.map((t) => t.name)).toEqual([
      "servers_create_from_skill",
      "panel_publish",
    ]);
    expect(result.content.toLowerCase()).toContain("paper");
  });
});


describe("conversation history", () => {
  it("includes prior turns when calling the LLM", async () => {
    const seen: string[] = [];
    const client = {
      mode: "mock" as const,
      async complete(messages: Array<{ role: string; content: string }>) {
        seen.push(...messages.map((m) => `${m.role}:${m.content}`));
        return { content: "picked A" };
      },
    };
    const orch = new Orchestrator(client);
    const result = await orch.handle("orchestrator", "A", [
      { role: "assistant", content: "Pick A or B" },
    ]);
    expect(result.content).toBe("picked A");
    expect(seen.some((line) => line.includes("Pick A or B"))).toBe(true);
    expect(seen.some((line) => line === "user:A")).toBe(true);
  });
});
