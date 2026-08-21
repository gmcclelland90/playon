export type RuntimeMode = "docker" | "native";

export interface ContainerSpec {
  name: string;
  image: string;
  env?: Record<string, string>;
  /** Docker Cmd (replaces image CMD). Empty/undefined keeps the image default. */
  cmd?: string[];
  ports?: Array<{ host: number; container: number; protocol?: "tcp" | "udp" }>;
  binds?: Array<{ hostPath: string; containerPath: string }>;
  /** `docker run -t`. Defaults on for Windows-container engines. */
  tty?: boolean;
  /** Windows container isolation. Omit to use the daemon default. */
  isolation?: "process" | "hyperv";
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
  /**
   * When set, stdout+stderr are appended here (keeps detached spawns workable).
   * Used for live Terminal log follow across native skills.
   */
  logFile?: string;
  /**
   * Keep a writable stdin (adminDialect=stdin). Linux uses a FIFO holder so
   * agent exit is not console EOF (GoldSrc/HLDS segfaults with detached+piped
   * stdin). Default is ignore.
   */
  keepStdin?: boolean;
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
  /** Remove container (and optionally volumes). Id may be name or hash. */
  remove(id: string): Promise<void>;
  inspect(id: string): Promise<ContainerInfo>;
  logs(id: string, tail?: number): Promise<string[]>;
  /** Stream new log lines until abort(). Optional for adapters that only support snapshots. */
  followLogs?(
    id: string,
    onLine: (line: string) => void,
    opts?: { tail?: number },
  ): Promise<LogFollowHandle>;
  /**
   * Write a line to the container's stdin (adminDialect=stdin).
   * Requires the container to have been created with OpenStdin.
   */
  writeStdin?(id: string, data: string): Promise<void>;
}

/**
 * Process supervisor contract. Only NativeProcessSupervisor implements this today;
 * kept as an interface so node-agent (or a future jail/sandbox adapter) can swap in without
 * changing DockerodeAdapter. Collapse to the concrete class if a second impl never appears.
 */
export interface ProcessSupervisor {
  start(spec: ProcessSpec): Promise<ProcessInfo>;
  stop(id: string): Promise<void>;
  status(id: string): Promise<ProcessInfo>;
  /**
   * Re-resolve the process for an identity (supervisor name + cwd) without a stored id.
   * Must also see OS orphans, so a restart that loses the in-memory map still answers.
   */
  find(name: string, cwd: string): Promise<ProcessInfo | null>;
  /**
   * Stop tracked processes with this name and best-effort kill OS orphans whose
   * cwd is under `cwd` (covers node-agent restarts that lose the in-memory map).
   */
  reclaim?(name: string, cwd: string): Promise<void>;
  /**
   * True when a running child still has a Node pipe write-end (not a FIFO
   * holder). Agent MAINPID exit would EOF that console (#909).
   */
  hasPipeStdinChildren?(): boolean;
  /**
   * Write a console line to the process behind an identity (adminDialect=stdin).
   * Only a process this supervisor still holds a stdin pipe for can be written
   * to: an OS orphan it merely re-resolved has no console left to address.
   */
  writeStdin?(name: string, cwd: string, data: string): Promise<void>;
  /** Tracked (and still running) processes — used for cheap heartbeat usage. */
  list?(): ProcessInfo[];
}
