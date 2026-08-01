export type RuntimeMode = "docker" | "native" | "mock";

export interface ContainerSpec {
  name: string;
  image: string;
  env?: Record<string, string>;
  ports?: Array<{ host: number; container: number; protocol?: "tcp" | "udp" }>;
  binds?: Array<{ hostPath: string; containerPath: string }>;
}

export interface ContainerInfo {
  id: string;
  name: string;
  status: "created" | "running" | "exited" | "unknown";
}

export interface ProcessSpec {
  name: string;
  command: string;
  args?: string[];
  cwd: string;
  env?: Record<string, string>;
}

export interface ProcessInfo {
  id: string;
  name: string;
  pid?: number;
  status: "running" | "stopped" | "unknown";
}

export interface LogFollowHandle {
  abort: () => void;
}

export interface DockerAdapter {
  create(spec: ContainerSpec): Promise<ContainerInfo>;
  start(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  inspect(id: string): Promise<ContainerInfo>;
  logs(id: string, tail?: number): Promise<string[]>;
  /** Stream new log lines until abort(). Optional for adapters that only support snapshots. */
  followLogs?(
    id: string,
    onLine: (line: string) => void,
    opts?: { tail?: number },
  ): Promise<LogFollowHandle>;
}

export interface ProcessSupervisor {
  start(spec: ProcessSpec): Promise<ProcessInfo>;
  stop(id: string): Promise<void>;
  status(id: string): Promise<ProcessInfo>;
}
