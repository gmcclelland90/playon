import { createHash, randomBytes } from "node:crypto";

/**
 * Vultr OAuth via playon.games relay (design-docs/14).
 *
 * Flow:
 * 1. Control plane creates a connect session (state + PKCE).
 * 2. Browser opens Vultr authorize → redirects to https://connect.playon.games/vultr/callback
 * 3. Relay posts one-time code back to this install (loopback or device link).
 * 4. Control plane exchanges code for tokens; relay keeps nothing long-lived.
 */

export const DEFAULT_VULTR_RELAY = "https://connect.playon.games/vultr";

export type VultrConnectSession = {
  state: string;
  codeVerifier: string;
  codeChallenge: string;
  createdAt: string;
  /** Optional loopback port for desktop callback. */
  loopbackPort?: number;
};

export function createVultrConnectSession(): VultrConnectSession {
  const state = randomBytes(16).toString("hex");
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return {
    state,
    codeVerifier,
    codeChallenge,
    createdAt: new Date().toISOString(),
  };
}

/** Build the browser URL that starts Vultr OAuth through our relay. */
export function buildVultrAuthorizeUrl(opts: {
  session: VultrConnectSession;
  /** Public relay base (playon.games). */
  relayBase?: string;
  /** This install's callback receiver (device link or loopback). */
  installCallback: string;
  clientId: string;
}): string {
  const relay = (opts.relayBase ?? DEFAULT_VULTR_RELAY).replace(/\/$/, "");
  const url = new URL(`${relay}/start`);
  url.searchParams.set("state", opts.session.state);
  url.searchParams.set("code_challenge", opts.session.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("install_callback", opts.installCallback);
  url.searchParams.set("client_id", opts.clientId);
  return url.toString();
}

export type VultrTokenBundle = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
};

/** Exchange authorization code (after relay handoff) for tokens. */
export async function exchangeVultrCode(opts: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  clientSecret?: string;
}): Promise<VultrTokenBundle> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    code_verifier: opts.codeVerifier,
  });
  if (opts.clientSecret) body.set("client_secret", opts.clientSecret);

  const res = await fetch("https://api.vultr.com/v2/auth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`vultr_token_exchange_${res.status}`);
  }
  const json = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: new Date(Date.now() + json.expires_in * 1000).toISOString(),
  };
}
