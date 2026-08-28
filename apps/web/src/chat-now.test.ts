import { describe, expect, it } from "vitest";
import { chatNowView, liveNowText } from "./chat-now";

describe("chatNowView", () => {
  it("is empty when the dock is quiet", () => {
    expect(chatNowView({ pending: false })).toEqual({ status: "empty", steps: [] });
  });

  it("is in-flight as soon as a turn is pending, even before the first event", () => {
    const view = chatNowView({ pending: true });
    expect(view.status).toBe("inflight");
    expect(view.now).toBe("Thinking…");
  });

  it("keeps the last thought while a tool now-line is showing", () => {
    const view = chatNowView({
      pending: true,
      phase: "tool_start",
      now: "Waiting for a heartbeat from win-1",
      thinking: "Looks like win-1 is still on 0.2.10, so I’ll swap from the extracted tar.",
      steps: [{ label: "Waiting for a heartbeat from win-1", status: "active" }],
      updatedAt: 1_000,
    });
    expect(view.status).toBe("inflight");
    expect(view.now).toBe("Waiting for a heartbeat from win-1");
    expect(view.thinking).toMatch(/win-1 is still on 0\.2\.10/);
  });

  it("collapses to done after idle with leftover thinking/steps", () => {
    const view = chatNowView({
      pending: false,
      phase: "idle",
      now: "Done",
      thinking: "I’ll list what’s on the board first.",
      steps: [{ label: "Checking servers", status: "done" }],
    });
    expect(view.status).toBe("done");
    expect(view.thinking).toMatch(/list what’s on the board/);
  });
});

describe("liveNowText", () => {
  it("appends elapsed so a long wait is never a still screen", () => {
    const view = chatNowView({
      pending: true,
      now: "Stopping PlayOnNodeAgent",
      updatedAt: 0,
    });
    expect(liveNowText(view, 500)).toBe("Stopping PlayOnNodeAgent");
    expect(liveNowText(view, 4_200)).toBe("Stopping PlayOnNodeAgent · 4s");
  });
});
