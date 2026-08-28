import { describe, expect, it } from "vitest";
import { looksLikeHiddenDump, sanitizeAgentThinking } from "./agent-thinking.js";

describe("sanitizeAgentThinking", () => {
  it("keeps a short plain rationale", () => {
    expect(
      sanitizeAgentThinking(
        "Looks like win-1 is still on 0.2.10, so I’ll swap from the extracted tar.",
      ),
    ).toBe("Looks like win-1 is still on 0.2.10, so I’ll swap from the extracted tar.");
  });

  it("caps to three sentences", () => {
    const out = sanitizeAgentThinking("One. Two. Three. Four should drop. Five too.");
    expect(out).toBe("One. Two. Three.");
  });

  it("redacts secrets, env, and jail paths", () => {
    const out = sanitizeAgentThinking(
      "Need the key sk-abcdefghijklmnopqrstuv and PLAYON_VENICE_API_KEY=abc /var/lib/playon/nodes/win-1/agent.zip next.",
    );
    expect(out).toBeDefined();
    expect(out).not.toMatch(/sk-/);
    expect(out).not.toMatch(/PLAYON_VENICE_API_KEY=abc/);
    expect(out).not.toMatch(/\/var\/lib\/playon/);
    expect(out).toContain("[REDACTED]");
    expect(out).toContain("[path]");
  });

  it("drops tool JSON and fenced dumps", () => {
    expect(
      sanitizeAgentThinking(
        '{"name":"servers_stop","arguments":{"serverId":"abc"}}',
      ),
    ).toBeUndefined();
    expect(
      sanitizeAgentThinking('```tool\nservers_list({})\n```'),
    ).toBeUndefined();
  });

  it("drops signature-shaped blobs", () => {
    expect(
      sanitizeAgentThinking("CiQAAAA-gemini-thought-sig-that-is-long-enough-to-look-like-b64"),
    ).toBeUndefined();
  });

  it("returns undefined for empty input", () => {
    expect(sanitizeAgentThinking("")).toBeUndefined();
    expect(sanitizeAgentThinking("   ")).toBeUndefined();
    expect(sanitizeAgentThinking(undefined)).toBeUndefined();
  });
});

describe("looksLikeHiddenDump", () => {
  it("accepts prose", () => {
    expect(looksLikeHiddenDump("Waiting on the node heartbeat.")).toBe(false);
  });
});
