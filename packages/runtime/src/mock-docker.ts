import type { ContainerInfo, ContainerSpec, DockerAdapter, LogFollowHandle } from "./types.js";

type MockContainer = ContainerInfo & {
  image: string;
  logs: string[];
  followers: Set<(line: string) => void>;
  tick?: ReturnType<typeof setInterval>;
  tickCount: number;
};

export class MockDockerAdapter implements DockerAdapter {
  private containers = new Map<string, MockContainer>();

  async create(spec: ContainerSpec): Promise<ContainerInfo> {
    const id = `mock-${spec.name}`;
    const info: MockContainer = {
      id,
      name: spec.name,
      status: "created",
      image: spec.image,
      logs: [`created ${spec.image}`],
      followers: new Set(),
      tickCount: 0,
    };
    this.containers.set(id, info);
    return { id, name: info.name, status: info.status };
  }

  async start(idOrName: string): Promise<void> {
    const c = this.require(idOrName);
    c.status = "running";
    this.append(c, "started");
    if (!c.tick) {
      c.tick = setInterval(() => {
        if (c.status !== "running") return;
        c.tickCount += 1;
        this.append(c, `heartbeat ${c.tickCount}`);
      }, 200);
      c.tick.unref?.();
    }
  }

  async stop(idOrName: string): Promise<void> {
    const c = this.require(idOrName);
    c.status = "exited";
    this.append(c, "stopped");
    if (c.tick) {
      clearInterval(c.tick);
      c.tick = undefined;
    }
  }

  async inspect(idOrName: string): Promise<ContainerInfo> {
    const c = this.require(idOrName);
    return { id: c.id, name: c.name, status: c.status };
  }

  async logs(idOrName: string, tail = 100): Promise<string[]> {
    const c = this.require(idOrName);
    return c.logs.slice(-tail);
  }

  async followLogs(
    idOrName: string,
    onLine: (line: string) => void,
    opts?: { tail?: number },
  ): Promise<LogFollowHandle> {
    const c = this.require(idOrName);
    const tail = opts?.tail ?? 20;
    for (const line of c.logs.slice(-tail)) onLine(line);
    c.followers.add(onLine);
    return {
      abort: () => {
        c.followers.delete(onLine);
      },
    };
  }

  /** Test helper: push a log line as if the container wrote it. */
  emitLog(idOrName: string, line: string): void {
    this.append(this.require(idOrName), line);
  }

  private append(c: MockContainer, line: string): void {
    c.logs.push(line);
    for (const follower of c.followers) follower(line);
  }

  private require(idOrName: string) {
    const byId = this.containers.get(idOrName);
    if (byId) return byId;
    for (const c of this.containers.values()) {
      if (c.name === idOrName) return c;
    }
    throw new Error(`unknown container: ${idOrName}`);
  }
}
