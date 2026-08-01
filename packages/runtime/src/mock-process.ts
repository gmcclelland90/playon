import type { ProcessInfo, ProcessSpec, ProcessSupervisor } from "./types.js";

export class MockProcessSupervisor implements ProcessSupervisor {
  private procs = new Map<string, ProcessInfo>();

  async start(spec: ProcessSpec): Promise<ProcessInfo> {
    const id = `proc-${spec.name}`;
    const info: ProcessInfo = {
      id,
      name: spec.name,
      pid: Math.floor(Math.random() * 10_000) + 1000,
      status: "running",
    };
    this.procs.set(id, info);
    return info;
  }

  async stop(id: string): Promise<void> {
    const p = this.require(id);
    p.status = "stopped";
    p.pid = undefined;
  }

  async status(id: string): Promise<ProcessInfo> {
    return { ...this.require(id) };
  }

  private require(id: string) {
    const p = this.procs.get(id);
    if (!p) throw new Error(`unknown process: ${id}`);
    return p;
  }
}
