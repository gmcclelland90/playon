import { buildPanelUrls, type PanelUrlSet } from "./panel-urls.js";
import type { HomeHostnameState } from "./home-hostname.js";

/** Mutable listen / discovery state after the control plane binds. */
export interface PanelRuntimeState {
  lanPort: number;
  loopbackPort: number;
  privilegedLan: boolean;
  mdnsAdvertised: boolean;
  hostnameState: HomeHostnameState | null;
  httpsListening: boolean;
}

let runtime: PanelRuntimeState | null = null;

export function setPanelRuntime(state: PanelRuntimeState): void {
  runtime = state;
}

export function getPanelRuntime(): PanelRuntimeState | null {
  return runtime;
}

export function clearPanelRuntime(): void {
  runtime = null;
}

export function panelUrlsFor(advertiseHost: string): PanelUrlSet {
  const r = runtime;
  const lanPort = r?.lanPort ?? 8787;
  const httpsReady = Boolean(r?.httpsListening && r.hostnameState && r.hostnameState.certPem);
  return buildPanelUrls({
    advertiseHost,
    lanPort,
    mdnsAdvertised: r?.mdnsAdvertised ?? true,
    publicHostname: r?.hostnameState?.hostname,
    httpsReady,
  });
}
