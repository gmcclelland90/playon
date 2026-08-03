/** Abstract cloud capacity provider (Vultr first — design-docs/14). */

export type CloudRegion = {
  id: string;
  city: string;
  country: string;
  /** Optional RTT ms measured from this install. */
  rttMs?: number;
};

export type CloudInstanceSize = {
  id: string;
  vcpus: number;
  ramMb: number;
  diskGb: number;
  /** Hourly USD estimate when known. */
  hourlyUsd?: number;
};

export type CloudInstance = {
  id: string;
  regionId: string;
  sizeId: string;
  status: "pending" | "active" | "stopped" | "destroyed" | "unknown";
  ipv4?: string;
  label: string;
};

export interface CloudProvider {
  readonly id: string;
  listRegions(): Promise<CloudRegion[]>;
  listSizes(regionId: string): Promise<CloudInstanceSize[]>;
  createInstance(opts: {
    regionId: string;
    sizeId: string;
    label: string;
    /** cloud-init / user-data to bootstrap PlayOn node-agent */
    userData?: string;
    tags?: string[];
  }): Promise<CloudInstance>;
  getInstance(id: string): Promise<CloudInstance>;
  destroyInstance(id: string): Promise<void>;
}
