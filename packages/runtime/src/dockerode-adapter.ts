import { PassThrough } from "node:stream";
import Docker from "dockerode";
import { demuxDockerLogBuffer, splitLogLines } from "./docker-log-demux.js";
import type { ContainerInfo, ContainerSpec, DockerAdapter, LogFollowHandle } from "./types.js";

function mapStatus(status: string | undefined): ContainerInfo["status"] {
  const s = (status ?? "").toLowerCase();
  if (s.includes("running")) return "running";
  if (s.includes("created")) return "created";
  if (s.includes("exited") || s.includes("dead") || s.includes("stopped")) return "exited";
  return "unknown";
}

/** Real Docker Engine adapter via dockerode. */
export class DockerodeAdapter implements DockerAdapter {
  private readonly docker: Docker;

  constructor(options?: Docker.DockerOptions) {
    this.docker = new Docker(options);
  }

  async ping(): Promise<void> {
    await this.docker.ping();
  }

  /** Pull image if missing locally (createContainer does not auto-pull). */
  private async ensureImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
      return;
    } catch {
      /* missing — pull below */
    }
    await new Promise<void>((resolve, reject) => {
      this.docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) {
          reject(err);
          return;
        }
        this.docker.modem.followProgress(stream, (progressErr: Error | null) => {
          if (progressErr) reject(progressErr);
          else resolve();
        });
      });
    });
  }

  async create(spec: ContainerSpec): Promise<ContainerInfo> {
    const exposed: Record<string, object> = {};
    const portBindings: Record<string, Array<{ HostPort: string }>> = {};
    for (const p of spec.ports ?? []) {
      const proto = p.protocol ?? "tcp";
      const key = `${p.container}/${proto}`;
      exposed[key] = {};
      portBindings[key] = [{ HostPort: String(p.host) }];
    }

    const binds = (spec.binds ?? []).map((b) => `${b.hostPath}:${b.containerPath}`);

    await this.ensureImage(spec.image);

    const cmd = spec.cmd?.filter((a) => a.length > 0);
    const container = await this.docker.createContainer({
      name: spec.name,
      Image: spec.image,
      Env: Object.entries(spec.env ?? {}).map(([k, v]) => `${k}=${v}`),
      ...(cmd?.length ? { Cmd: cmd } : {}),
      // Keep stdin open so adminDialect=stdin can attach and write console commands.
      OpenStdin: true,
      AttachStdin: true,
      StdinOnce: false,
      Tty: false,
      ExposedPorts: exposed,
      HostConfig: {
        PortBindings: portBindings as Docker.PortMap,
        Binds: binds.length ? binds : undefined,
      },
    });


    return { id: container.id, name: spec.name, status: "created" };
  }

  async start(id: string): Promise<void> {
    await this.docker.getContainer(id).start();
  }

  async stop(id: string): Promise<void> {
    try {
      await this.docker.getContainer(id).stop({ t: 10 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/not running|already stopped|304/i.test(message)) throw err;
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await this.docker.getContainer(id).remove({ force: true, v: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/no such container|404/i.test(message)) throw err;
    }
  }

  async inspect(id: string): Promise<ContainerInfo> {
    const info = await this.docker.getContainer(id).inspect();
    return {
      id: info.Id,
      name: (info.Name ?? "").replace(/^\//, ""),
      status: mapStatus(info.State?.Status),
    };
  }

  async logs(id: string, tail = 100): Promise<string[]> {
    const raw = await this.docker.getContainer(id).logs({
      stdout: true,
      stderr: true,
      tail,
      timestamps: false,
    });
    // Non-TTY containers return multiplexed frames; decoding as UTF-8 leaves junk prefixes.
    const buf = Buffer.isBuffer(raw)
      ? raw
      : Buffer.from(raw as unknown as ArrayBuffer);
    return splitLogLines(demuxDockerLogBuffer(buf));
  }

  async followLogs(
    id: string,
    onLine: (line: string) => void,
    opts?: { tail?: number },
  ): Promise<LogFollowHandle> {
    const container = this.docker.getContainer(id);
    const stream = (await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      tail: opts?.tail ?? 40,
      timestamps: false,
    })) as NodeJS.ReadableStream;

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    container.modem.demuxStream(stream, stdout, stderr);

    let aborted = false;
    const buffers = { out: "", err: "" };

    const feed = (key: "out" | "err", chunk: Buffer | string) => {
      if (aborted) return;
      buffers[key] += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const parts = buffers[key].split(/\r?\n/);
      buffers[key] = parts.pop() ?? "";
      for (const line of parts) {
        if (line) onLine(line);
      }
    };

    const onStdout = (chunk: Buffer | string) => feed("out", chunk);
    const onStderr = (chunk: Buffer | string) => feed("err", chunk);
    stdout.on("data", onStdout);
    stderr.on("data", onStderr);

    const abort = () => {
      if (aborted) return;
      aborted = true;
      stdout.off("data", onStdout);
      stderr.off("data", onStderr);
      const destroyable = stream as unknown as { destroy?: () => void };
      destroyable.destroy?.();
      stdout.destroy();
      stderr.destroy();
    };

    stream.on("end", abort);
    stream.on("error", abort);

    return { abort };
  }

  async writeStdin(id: string, data: string): Promise<void> {
    const container = this.docker.getContainer(id);
    const payload = data.endsWith("\n") ? data : `${data}\n`;
    const stream = (await container.attach({
      stream: true,
      hijack: true,
      stdin: true,
      stdout: false,
      stderr: false,
    })) as NodeJS.WritableStream;

    await new Promise<void>((resolve, reject) => {
      stream.write(payload, (err) => {
        if (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        // Close this attach session; OpenStdin+!StdinOnce keeps container stdin usable.
        stream.end(() => resolve());
      });
    });
  }
}
