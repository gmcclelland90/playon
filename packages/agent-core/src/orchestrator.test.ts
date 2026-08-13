import { describe, expect, it } from "vitest";
import { ChatAbortedError, Orchestrator } from "./orchestrator.js";

describe("Orchestrator tool exposure", () => {
  it("exposes all registered tools to the LLM", () => {
    const orch = new Orchestrator({
      mode: "openai_compatible",
      async complete() {
        throw new Error("llm_should_not_be_called");
      },
    });
    orch.registerTool(
      { name: "panel_publish", description: "p", parameters: {} },
      async () => ({}),
    );
    orch.registerTool(
      { name: "servers_stop", description: "s", parameters: {} },
      async () => ({}),
    );
    expect(orch.getToolDefinitions().map((t) => t.name)).toEqual([
      "panel_publish",
      "servers_stop",
    ]);
  });

  it("stops when abortSignal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const orch = new Orchestrator(
      {
        mode: "openai_compatible",
        async complete() {
          throw new Error("llm_should_not_be_called");
        },
      },
      { abortSignal: ac.signal },
    );
    await expect(orch.handle("hello")).rejects.toBeInstanceOf(ChatAbortedError);
  });

  it("sets degradedMode when tools were offered but the reply looks like a failed tool call", async () => {
    const orch = new Orchestrator({
      mode: "openai_compatible",
      async complete() {
        return {
          content:
            '```json\n{"name":"servers_list","arguments":{}}\n``` I printed the tool instead of calling it.',
        };
      },
    });
    orch.registerTool(
      { name: "servers_list", description: "list", parameters: {} },
      async () => ({ servers: [] }),
    );
    const result = await orch.handle("List servers.");
    expect(result.toolTrace).toEqual([]);
    expect(result.degradedMode).toBe(true);
  });

  it("does not set degradedMode for a normal prose reply", async () => {
    const orch = new Orchestrator({
      mode: "openai_compatible",
      async complete() {
        return { content: "Hello — what should we install?" };
      },
    });
    orch.registerTool(
      { name: "servers_list", description: "list", parameters: {} },
      async () => ({ servers: [] }),
    );
    const result = await orch.handle("hi");
    expect(result.degradedMode).toBeUndefined();
  });
});

describe("Orchestrator sequential tool calls (NVIDIA-shaped)", () => {
  it("executes only the first tool_call when the backend caps at one per completion", async () => {
    const started: string[] = [];
    let round = 0;
    const orch = new Orchestrator({
      mode: "openai_compatible",
      maxToolCallsPerCompletion: 1,
      async complete(_messages, _tools) {
        round += 1;
        if (round === 1) {
          return {
            content: "",
            toolCalls: [
              { id: "a", name: "servers_list", arguments: {} },
              { id: "b", name: "snapshot_create", arguments: { serverId: "live-friend" } },
            ],
          };
        }
        return { content: "listed first, then I can continue." };
      },
    });
    orch.registerTool({ name: "servers_list", description: "list", parameters: {} }, async () => {
      started.push("servers_list");
      return { servers: [{ id: "lab-1" }] };
    });
    orch.registerTool(
      { name: "snapshot_create", description: "snap", parameters: {} },
      async () => {
        started.push("snapshot_create");
        return { snapshotId: "nope" };
      },
    );

    const result = await orch.handle("list then snapshot");
    expect(started).toEqual(["servers_list"]);
    expect(result.toolTrace.map((t) => t.name)).toEqual(["servers_list"]);
    expect(result.content).toContain("listed first");
  });

  it("still loops across rounds so sequential create→start works", async () => {
    const order: string[] = [];
    let round = 0;
    const orch = new Orchestrator({
      mode: "openai_compatible",
      maxToolCallsPerCompletion: 1,
      async complete() {
        round += 1;
        if (round === 1) {
          return {
            content: "",
            toolCalls: [{ id: "1", name: "servers_create_from_skill", arguments: { skillName: "lab" } }],
          };
        }
        if (round === 2) {
          return {
            content: "",
            toolCalls: [{ id: "2", name: "servers_start", arguments: { serverId: "srv-new" } }],
          };
        }
        return { content: "up" };
      },
    });
    orch.registerTool(
      { name: "servers_create_from_skill", description: "c", parameters: {} },
      async () => {
        order.push("create");
        return { serverId: "srv-new" };
      },
    );
    orch.registerTool({ name: "servers_start", description: "s", parameters: {} }, async () => {
      order.push("start");
      return { status: "running" };
    });
    const result = await orch.handle("spin up");
    expect(order).toEqual(["create", "start"]);
    expect(result.content).toBe("up");
  });
});

describe("Orchestrator in-session servers_stop confirm", () => {
  it("does not confirm_denied stop of a server created this turn", async () => {
    const gate = {
      requestConfirmation: async () => ({ requestId: "r1", approved: false }),
    };
    let round = 0;
    const orch = new Orchestrator(
      {
        mode: "openai_compatible",
        async complete() {
          round += 1;
          if (round === 1) {
            return {
              content: "",
              toolCalls: [
                {
                  id: "1",
                  name: "servers_create_from_skill",
                  arguments: { skillName: "fixtures.lab-docker-server" },
                },
              ],
            };
          }
          if (round === 2) {
            return {
              content: "",
              toolCalls: [{ id: "2", name: "servers_stop", arguments: { serverId: "srv-new" } }],
            };
          }
          return { content: "stopped" };
        },
      },
      { confirmGate: gate, confirmPolicy: "gate" },
    );
    orch.registerEntry({
      def: { name: "servers_create_from_skill", description: "c", parameters: {} },
      handler: async () => ({ serverId: "srv-new", mode: "created" }),
    });
    orch.registerEntry({
      def: {
        name: "servers_stop",
        description: "s",
        parameters: {},
        requiresConfirm: true,
      },
      handler: async () => ({ status: "stopped" }),
    });

    const result = await orch.handle("create then stop");
    expect(result.toolTrace[1]?.result).toMatchObject({
      status: "stopped",
      confirmAutoApproved: true,
      confirmActor: "session:created",
    });
    expect(result.toolTrace[1]?.result).not.toMatchObject({ error: "confirm_denied" });
  });

  it("still gates stop of an unrelated live server", async () => {
    const gate = {
      requestConfirmation: async () => ({ requestId: "r2", approved: false }),
    };
    const orch = new Orchestrator(
      {
        mode: "openai_compatible",
        async complete() {
          return {
            content: "",
            toolCalls: [{ id: "1", name: "servers_stop", arguments: { serverId: "live-friend" } }],
          };
        },
      },
      { confirmGate: gate, confirmPolicy: "gate" },
    );
    orch.registerEntry({
      def: {
        name: "servers_stop",
        description: "s",
        parameters: {},
        requiresConfirm: true,
      },
      handler: async () => ({ status: "stopped" }),
    });
    const result = await orch.handle("stop the live one");
    expect(result.toolTrace[0]?.result).toMatchObject({
      error: "confirm_denied",
      toolName: "servers_stop",
    });
  });

  it("does not auto-approve watchers_delete even for a session-created server", async () => {
    const gate = {
      requestConfirmation: async () => ({ requestId: "r3", approved: false }),
    };
    const orch = new Orchestrator(
      {
        mode: "openai_compatible",
        async complete() {
          return {
            content: "",
            toolCalls: [{ id: "1", name: "watchers_delete", arguments: { watcherId: "w1" } }],
          };
        },
      },
      {
        confirmGate: gate,
        confirmPolicy: "gate",
        sessionCreatedServerIds: ["srv-new"],
      },
    );
    orch.registerEntry({
      def: {
        name: "watchers_delete",
        description: "d",
        parameters: {},
        requiresConfirm: true,
      },
      handler: async () => ({ ok: true }),
    });
    const result = await orch.handle("delete watcher");
    expect(result.toolTrace[0]?.result).toMatchObject({
      error: "confirm_denied",
      toolName: "watchers_delete",
    });
  });
});

