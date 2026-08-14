import { describe, expect, it } from "vitest";
import { AGENT_SYSTEM_PROMPT } from "./agent-prompt.js";

describe("AGENT_SYSTEM_PROMPT", () => {
  it("forbids claiming the server is up without advertised join-path ready", () => {
    expect(AGENT_SYSTEM_PROMPT).toMatch(/ready=true/);
    expect(AGENT_SYSTEM_PROMPT).toMatch(/advertised panel join host:port/);
    expect(AGENT_SYSTEM_PROMPT).toMatch(/127\.0\.0\.1:port is not enough/);
    expect(AGENT_SYSTEM_PROMPT).toMatch(/loopback_open_join_host_closed/);
    expect(AGENT_SYSTEM_PROMPT).toMatch(/net_port_check on 127\.0\.0\.1/);
  });
});
