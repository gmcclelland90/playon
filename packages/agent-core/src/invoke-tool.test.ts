import { describe, expect, it, vi } from "vitest";
import { runToolInvocation } from "./invoke-tool.js";
import type { ConfirmGate } from "./orchestrator.js";

describe("runToolInvocation", () => {
  it("runs handlers that do not require confirm", async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const result = await runToolInvocation(
      { def: { name: "servers_list", description: "", parameters: {} }, handler },
      {},
    );
    expect(result).toEqual({ ok: true });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("waits on confirm gate when required", async () => {
    const handler = vi.fn(async () => ({ stopped: true }));
    const gate: ConfirmGate = {
      requestConfirmation: vi.fn(async () => ({ requestId: "r1", approved: true })),
    };
    const result = await runToolInvocation(
      {
        def: {
          name: "servers_stop",
          description: "",
          parameters: {},
          requiresConfirm: true,
        },
        handler,
      },
      { serverId: "s1" },
      { confirmGate: gate },
    );
    expect(gate.requestConfirmation).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ stopped: true, confirmRequestId: "r1" });
  });

  it("returns confirm_denied when host rejects", async () => {
    const handler = vi.fn(async () => ({ stopped: true }));
    const gate: ConfirmGate = {
      requestConfirmation: vi.fn(async () => ({ requestId: "r2", approved: false })),
    };
    const result = await runToolInvocation(
      {
        def: {
          name: "servers_stop",
          description: "",
          parameters: {},
          requiresConfirm: true,
        },
        handler,
      },
      {},
      { confirmGate: gate },
    );
    expect(result).toEqual({
      error: "confirm_denied",
      requestId: "r2",
      toolName: "servers_stop",
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("auto-approves when confirmPolicy is auto", async () => {
    const handler = vi.fn(async () => ({ deleted: true }));
    const gate: ConfirmGate = {
      requestConfirmation: vi.fn(async () => ({ requestId: "x", approved: false })),
    };
    const result = await runToolInvocation(
      {
        def: {
          name: "servers_delete",
          description: "",
          parameters: {},
          requiresConfirm: true,
        },
        handler,
      },
      {},
      { confirmGate: gate, confirmPolicy: "auto", autoApproveActor: "token:abc" },
    );
    expect(gate.requestConfirmation).not.toHaveBeenCalled();
    expect(result).toEqual({
      deleted: true,
      confirmAutoApproved: true,
      confirmActor: "token:abc",
    });
  });
});
