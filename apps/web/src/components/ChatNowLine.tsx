import { useEffect, useState } from "react";
import { liveNowText, type ChatNowView } from "../chat-now";

type Props = {
  view: ChatNowView;
};

export function ChatNowLine({ view }: Props) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (view.status !== "inflight") return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [view.status, view.since, view.now]);

  if (view.status === "empty") return null;

  const nowText = liveNowText(view, nowMs);
  const steps = view.steps;

  if (view.status === "done") {
    return (
      <div className="chat-now" data-state="done">
        <details className="chat-now-details">
          <summary>{steps.length ? `This turn · ${steps.length} steps` : "This turn"}</summary>
          {view.thinking ? <p className="chat-now-thinking">{view.thinking}</p> : null}
          {steps.length ? (
            <ol className="chat-now-steps">
              {steps.map((step, i) => (
                <li key={`${step.label}-${i}`} data-status={step.status}>
                  {step.label}
                </li>
              ))}
            </ol>
          ) : null}
        </details>
      </div>
    );
  }

  return (
    <div className="chat-now" data-state="inflight" role="status" aria-live="polite">
      <p className="chat-now-line">
        <span className="chat-now-pip" aria-hidden />
        <span>{nowText}</span>
      </p>
      {view.thinking ? <p className="chat-now-thinking">{view.thinking}</p> : null}
      {steps.length ? (
        <details className="chat-now-details">
          <summary>
            {steps.length} step{steps.length === 1 ? "" : "s"}
          </summary>
          <ol className="chat-now-steps">
            {steps.map((step, i) => (
              <li key={`${step.label}-${i}`} data-status={step.status}>
                {step.label}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </div>
  );
}
