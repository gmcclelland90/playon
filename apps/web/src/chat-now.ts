import {
  formatLiveNowLine,
  nowLineForPhase,
  type ChatProgressStep,
} from "@playon/shared";

export type ChatNowStatus = "empty" | "inflight" | "done";

export type ChatNowView = {
  status: ChatNowStatus;
  now?: string;
  thinking?: string;
  steps: ChatProgressStep[];
  since?: number;
};

export type ChatNowInput = {
  pending: boolean;
  phase?: string;
  now?: string;
  thinking?: string;
  steps?: ChatProgressStep[];
  updatedAt?: number;
  nowMs?: number;
};

/** Empty / in-flight / done — the dock never sits still while pending. */
export function chatNowView(input: ChatNowInput): ChatNowView {
  const steps = input.steps ?? [];
  const thinking = input.thinking?.trim() || undefined;
  const pending = input.pending;
  const phase = input.phase;

  if (!pending && (phase === "idle" || phase === "done" || !phase)) {
    if (!thinking && steps.length === 0) {
      return { status: "empty", steps: [] };
    }
    if (phase === "idle" || phase === "done") {
      return { status: "done", thinking, steps };
    }
    return { status: "empty", steps: [] };
  }

  if (pending || (phase && phase !== "idle")) {
    const now = input.now?.trim() || nowLineForPhase("thinking");
    return {
      status: "inflight",
      now,
      thinking,
      steps,
      since: input.updatedAt,
    };
  }

  return { status: "empty", steps: [] };
}

export function liveNowText(view: ChatNowView, nowMs = Date.now()): string | undefined {
  if (view.status !== "inflight" || !view.now) return view.status === "done" ? "Done" : undefined;
  const elapsed = view.since != null ? Math.max(0, nowMs - view.since) : 0;
  return formatLiveNowLine(view.now, elapsed);
}

export { formatLiveNowLine };
