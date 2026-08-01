import { describe, expect, it, vi } from "vitest";
import { postNodeLogs, postNodeMetrics } from "./fanin.js";

describe("fan-in helpers", () => {
  it("posts logs with bearer token", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    await postNodeLogs("http://api", "lab-1", "srv", ["hello"], "secret");
    expect(fetchMock).toHaveBeenCalledOnce();
    const call = fetchMock.mock.calls.at(0);
    expect(call).toBeTruthy();
    expect(String(call![0])).toContain("/api/nodes/lab-1/logs");
    expect(call![1]).toMatchObject({
      headers: { authorization: "Bearer secret" },
    });
    vi.unstubAllGlobals();
  });

  it("posts metrics", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    await postNodeMetrics("http://api/", "lab-1", { cpuPercent: 12, freeDiskBytes: 99 });
    const call = fetchMock.mock.calls.at(0);
    expect(String(call![0])).toContain("/api/nodes/lab-1/metrics");
    vi.unstubAllGlobals();
  });
});
