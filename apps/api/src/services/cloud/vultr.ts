import type {
  CloudInstance,
  CloudInstanceSize,
  CloudProvider,
  CloudRegion,
} from "./provider.js";

const VULTR_API = "https://api.vultr.com/v2";

/**
 * Vultr BYO provider using OAuth access token stored on the control plane.
 * Tokens must never appear in player panel / logs.
 */
export class VultrProvider implements CloudProvider {
  readonly id = "vultr";

  constructor(private readonly accessToken: string) {}

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${VULTR_API}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`vultr_api_${res.status}: ${text.slice(0, 200)}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async listRegions(): Promise<CloudRegion[]> {
    const body = await this.api<{
      regions: Array<{ id: string; city: string; country: string }>;
    }>("/regions");
    return (body.regions ?? []).map((r) => ({
      id: r.id,
      city: r.city,
      country: r.country,
    }));
  }

  async listSizes(_regionId: string): Promise<CloudInstanceSize[]> {
    const body = await this.api<{
      plans: Array<{
        id: string;
        vcpu_count: number;
        ram: number;
        disk: number;
        monthly_cost?: number;
      }>;
    }>("/plans");
    return (body.plans ?? []).map((p) => ({
      id: p.id,
      vcpus: p.vcpu_count,
      ramMb: p.ram,
      diskGb: p.disk,
      hourlyUsd: p.monthly_cost != null ? p.monthly_cost / 730 : undefined,
    }));
  }

  async createInstance(opts: {
    regionId: string;
    sizeId: string;
    label: string;
    userData?: string;
    tags?: string[];
  }): Promise<CloudInstance> {
    const body = await this.api<{ instance: Record<string, unknown> }>("/instances", {
      method: "POST",
      body: JSON.stringify({
        region: opts.regionId,
        plan: opts.sizeId,
        label: opts.label,
        user_data: opts.userData
          ? Buffer.from(opts.userData, "utf8").toString("base64")
          : undefined,
        tags: ["playon-managed", ...(opts.tags ?? [])],
      }),
    });
    return mapInstance(body.instance);
  }

  async getInstance(id: string): Promise<CloudInstance> {
    const body = await this.api<{ instance: Record<string, unknown> }>(`/instances/${id}`);
    return mapInstance(body.instance);
  }

  async destroyInstance(id: string): Promise<void> {
    await this.api(`/instances/${id}`, { method: "DELETE" });
  }
}

function mapInstance(raw: Record<string, unknown>): CloudInstance {
  const statusRaw = String(raw.status ?? "unknown");
  let status: CloudInstance["status"] = "unknown";
  if (statusRaw === "active") status = "active";
  else if (statusRaw === "pending") status = "pending";
  else if (statusRaw === "stopped" || statusRaw === "suspended") status = "stopped";
  return {
    id: String(raw.id ?? ""),
    regionId: String(raw.region ?? ""),
    sizeId: String(raw.plan ?? ""),
    status,
    ipv4: typeof raw.main_ip === "string" ? raw.main_ip : undefined,
    label: String(raw.label ?? "playon"),
  };
}

/** cloud-init snippet that installs PlayOn node and joins Home. */
export function vultrNodeUserData(opts: {
  apiUrl: string;
  nodeToken: string;
  nodeId: string;
  bundleUrl?: string;
}): string {
  const bundle = opts.bundleUrl ?? "https://playon.games/downloads/playon-home-latest.tar.gz";
  return `#cloud-config
package_update: true
runcmd:
  - curl -fsSL ${bundle} -o /tmp/playon-home.tar.gz
  - mkdir -p /opt/playon-src && tar -xzf /tmp/playon-home.tar.gz -C /opt/playon-src --strip-components=1
  - bash /opt/playon-src/deploy/install-node.sh --api ${opts.apiUrl} --token ${opts.nodeToken} --node-id ${opts.nodeId} --runtime docker
`;
}
