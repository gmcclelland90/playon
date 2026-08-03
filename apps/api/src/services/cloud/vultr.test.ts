import { describe, expect, it } from "vitest";
import { buildVultrAuthorizeUrl, createVultrConnectSession } from "./oauth-relay.js";
import { vultrNodeUserData } from "./vultr.js";

describe("vultr oauth relay helpers", () => {
  it("creates PKCE session and authorize URL", () => {
    const session = createVultrConnectSession();
    expect(session.state).toHaveLength(32);
    expect(session.codeVerifier.length).toBeGreaterThan(20);
    expect(session.codeChallenge.length).toBeGreaterThan(20);
    const url = buildVultrAuthorizeUrl({
      session,
      installCallback: "http://127.0.0.1:8787/api/cloud/vultr/callback",
      clientId: "playon-dev",
    });
    expect(url).toContain("connect.playon.games");
    expect(url).toContain("code_challenge=");
    expect(url).toContain("state=");
  });
});

describe("vultrNodeUserData", () => {
  it("embeds join args", () => {
    const ud = vultrNodeUserData({
      apiUrl: "http://192.168.1.10:8787",
      nodeToken: "tok",
      nodeId: "cloud-1",
    });
    expect(ud).toContain("install-node.sh");
    expect(ud).toContain("cloud-1");
    expect(ud).toContain("192.168.1.10:8787");
  });
});
