/**
 * Discord-linked panel hostname state + ACME via playon.games DNS helper.
 * Traffic stays on LAN; playon.games only updates DNS A/TXT records.
 */
import fs from "node:fs";
import path from "node:path";
import acme from "acme-client";

export const HOME_DNS_STATE_FILE = "home-hostname.json";

export interface HomeHostnameState {
  installId: string;
  deviceKey: string;
  hostname: string;
  slug: string;
  discordUsername?: string;
  linkedAt?: string;
  /** Last LAN IPv4 published to DNS. */
  publishedIpv4?: string;
  accountKeyPem?: string;
  certPem?: string;
  keyPem?: string;
  certExpiresAt?: string;
  lastError?: string;
  updatedAt: string;
}

export interface HomeDnsApi {
  baseUrl: string;
  fetchFn?: typeof fetch;
}

function statePath(dataRoot: string): string {
  return path.join(dataRoot, HOME_DNS_STATE_FILE);
}

export function loadHomeHostnameState(dataRoot: string): HomeHostnameState | null {
  const file = statePath(dataRoot);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as HomeHostnameState;
  } catch {
    return null;
  }
}

export function saveHomeHostnameState(dataRoot: string, state: HomeHostnameState): void {
  fs.mkdirSync(dataRoot, { recursive: true });
  const tmp = `${statePath(dataRoot)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, statePath(dataRoot));
}

export function clearHomeHostnameState(dataRoot: string): void {
  const file = statePath(dataRoot);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

export function certIsUsable(state: HomeHostnameState | null, now = Date.now()): boolean {
  if (!state?.certPem || !state?.keyPem || !state.certExpiresAt) return false;
  const exp = Date.parse(state.certExpiresAt);
  if (!Number.isFinite(exp)) return false;
  // Renew window handled separately; usable until expiry
  return exp > now + 60_000;
}

export function needsRenewal(state: HomeHostnameState | null, now = Date.now()): boolean {
  if (!state?.certExpiresAt) return true;
  const exp = Date.parse(state.certExpiresAt);
  if (!Number.isFinite(exp)) return true;
  // Renew when < 30 days left
  return exp - now < 30 * 24 * 60 * 60 * 1000;
}

async function dnsApi<T>(
  api: HomeDnsApi,
  route: string,
  init: RequestInit & { deviceKey?: string } = {},
): Promise<T> {
  const fetchFn = api.fetchFn ?? fetch;
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (init.deviceKey) headers.set("Authorization", `Bearer ${init.deviceKey}`);
  const res = await fetchFn(`${api.baseUrl.replace(/\/$/, "")}${route}`, {
    ...init,
    headers,
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(body.error || `home_dns_http_${res.status}`);
  }
  return body;
}

/** Start Discord link: returns URL + user code for playon.games. */
export async function beginDiscordLink(
  api: HomeDnsApi,
  opts: { installId?: string },
): Promise<{
  linkUrl: string;
  userCode: string;
  expiresAt: string;
  installId: string;
  deviceKey: string;
}> {
  return dnsApi(api, "/api/home-dns/link/start", {
    method: "POST",
    body: JSON.stringify({ installId: opts.installId }),
  });
}

/** Poll / complete link + claim handle hostname. */
export async function completeDiscordLink(
  api: HomeDnsApi,
  opts: { userCode: string },
): Promise<{
  installId: string;
  deviceKey: string;
  hostname: string;
  slug: string;
  discordUsername: string;
}> {
  return dnsApi(api, "/api/home-dns/link/complete", {
    method: "POST",
    body: JSON.stringify({ userCode: opts.userCode }),
  });
}

export async function updateDnsA(
  api: HomeDnsApi,
  opts: { deviceKey: string; ipv4: string },
): Promise<void> {
  await dnsApi(api, "/api/home-dns/update-a", {
    method: "POST",
    deviceKey: opts.deviceKey,
    body: JSON.stringify({ ipv4: opts.ipv4 }),
  });
}

export async function setAcmeTxt(
  api: HomeDnsApi,
  opts: { deviceKey: string; token: string; content: string | null },
): Promise<void> {
  await dnsApi(api, "/api/home-dns/acme-txt", {
    method: "POST",
    deviceKey: opts.deviceKey,
    body: JSON.stringify({ token: opts.token, content: opts.content }),
  });
}

function parseCertExpiry(certPem: string): string | undefined {
  try {
    // acme-client / node may not parse easily; use openssl-less heuristic via crypto if available
    const b64 = certPem
      .replace(/-----BEGIN CERTIFICATE-----/, "")
      .replace(/-----END CERTIFICATE-----/, "")
      .replace(/\s+/g, "");
    const der = Buffer.from(b64, "base64");
    // Fallback: 90 days from now if we cannot parse
    void der;
  } catch {
    // ignore
  }
  return new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
}

export async function issueOrRenewCertificate(opts: {
  dataRoot: string;
  api: HomeDnsApi;
  state: HomeHostnameState;
  directoryUrl?: string;
}): Promise<HomeHostnameState> {
  const directoryUrl = opts.directoryUrl ?? acme.directory.letsencrypt.production;
  let accountKeyPem = opts.state.accountKeyPem;
  if (!accountKeyPem) {
    accountKeyPem = (await acme.crypto.createPrivateKey()).toString();
  }

  const client = new acme.Client({
    directoryUrl,
    accountKey: accountKeyPem,
  });

  const [keyPem, csr] = await acme.crypto.createCsr({
    commonName: opts.state.hostname,
  });

  const certPem = await client.auto({
    csr,
    email: `playon-home+${opts.state.slug}@playon.games`,
    termsOfServiceAgreed: true,
    challengeCreateFn: async (_authz, challenge, keyAuthorization) => {
      if (challenge.type !== "dns-01") {
        throw new Error(`unsupported_challenge_${challenge.type}`);
      }
      await setAcmeTxt(opts.api, {
        deviceKey: opts.state.deviceKey,
        token: challenge.token,
        content: keyAuthorization,
      });
      // Allow DNS propagation
      await new Promise((r) => setTimeout(r, 5000));
    },
    challengeRemoveFn: async (_authz, challenge) => {
      if (challenge.type !== "dns-01") return;
      await setAcmeTxt(opts.api, {
        deviceKey: opts.state.deviceKey,
        token: challenge.token,
        content: null,
      });
    },
    challengePriority: ["dns-01"],
  });

  const next: HomeHostnameState = {
    ...opts.state,
    accountKeyPem,
    certPem: typeof certPem === "string" ? certPem : String(certPem),
    keyPem: keyPem.toString(),
    certExpiresAt: parseCertExpiry(typeof certPem === "string" ? certPem : String(certPem)),
    lastError: undefined,
    updatedAt: new Date().toISOString(),
  };
  saveHomeHostnameState(opts.dataRoot, next);
  return next;
}

/** Ensure DNS A + cert are current for the linked hostname. */
export async function syncHomeHostname(opts: {
  dataRoot: string;
  api: HomeDnsApi;
  advertiseHost: string;
  directoryUrl?: string;
}): Promise<HomeHostnameState | null> {
  const state = loadHomeHostnameState(opts.dataRoot);
  if (!state?.deviceKey || !state.hostname) return null;

  const ipv4 = opts.advertiseHost.trim();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ipv4) && ipv4 !== state.publishedIpv4) {
    try {
      await updateDnsA(opts.api, { deviceKey: state.deviceKey, ipv4 });
      state.publishedIpv4 = ipv4;
      state.updatedAt = new Date().toISOString();
      saveHomeHostnameState(opts.dataRoot, state);
    } catch (err) {
      state.lastError = err instanceof Error ? err.message : String(err);
      saveHomeHostnameState(opts.dataRoot, state);
    }
  }

  if (!certIsUsable(state) || needsRenewal(state)) {
    try {
      return await issueOrRenewCertificate({
        dataRoot: opts.dataRoot,
        api: opts.api,
        state,
        directoryUrl: opts.directoryUrl,
      });
    } catch (err) {
      const failed = {
        ...state,
        lastError: err instanceof Error ? err.message : String(err),
        updatedAt: new Date().toISOString(),
      };
      saveHomeHostnameState(opts.dataRoot, failed);
      return failed;
    }
  }

  return state;
}
