import BonjourImport from "bonjour-service";
import { MDNS_HOST } from "./panel-urls.js";

// CJS export = Bonjour; ESM interop varies by bundler/tsx.
const BonjourCtor =
  (BonjourImport as unknown as { default?: new () => BonjourInstance }).default ??
  (BonjourImport as unknown as new () => BonjourInstance);

interface BonjourInstance {
  publish(opts: {
    name: string;
    type: string;
    port: number;
    host?: string;
    probe?: boolean;
  }): unknown;
  unpublishAll(cb?: () => void): void;
  destroy(): void;
}

export interface MdnsAdvertisement {
  /** True when a responder was started (best-effort; LAN peers may still fail). */
  active: boolean;
  hostname: string;
  port: number;
  stop(): void;
}

/**
 * Advertise PlayOn on the LAN as playon.local (HTTP).
 * Best-effort: failures must not prevent the control plane from starting.
 */
export function startMdnsAdvertisement(opts: {
  port: number;
  name?: string;
  log?: (record: Record<string, unknown>, level?: "info" | "warn") => void;
}): MdnsAdvertisement {
  const hostname = MDNS_HOST;
  const shortName = opts.name ?? "playon";
  const log = opts.log ?? (() => {});

  let bonjour: BonjourInstance | null = null;
  let stopped = false;

  const noop: MdnsAdvertisement = {
    active: false,
    hostname,
    port: opts.port,
    stop() {},
  };

  try {
    bonjour = new BonjourCtor();
    // Publish as "playon" → playon.local on most stacks (Bonjour/Avahi).
    bonjour.publish({
      name: shortName,
      type: "http",
      port: opts.port,
      host: hostname,
      probe: false,
    });
    log({ msg: "playon_mdns_advertise", hostname, port: opts.port });
  } catch (err) {
    log(
      {
        msg: "playon_mdns_failed",
        error: err instanceof Error ? err.message : String(err),
      },
      "warn",
    );
    try {
      bonjour?.destroy();
    } catch {
      // ignore
    }
    return noop;
  }

  return {
    active: true,
    hostname,
    port: opts.port,
    stop() {
      if (stopped) return;
      stopped = true;
      try {
        bonjour?.unpublishAll(() => {
          bonjour?.destroy();
        });
      } catch {
        try {
          bonjour?.destroy();
        } catch {
          // ignore
        }
      }
    },
  };
}
