import { execFileSync } from "node:child_process";
import { PassThrough } from "node:stream";
import Docker from "dockerode";
import { buildContainerCreateOptions } from "./docker-create-options.js";
import { listHostContainers } from "./docker-inventory.js";
import {
  inspectDockerEngine,
  parseDockerEngineInfo,
  type DockerEngineInfo,
} from "./docker-engine.js";
import { demuxDockerLogBuffer, splitLogLines } from "./docker-log-demux.js";
import {
  HostPortInUseError,
  assertHostPortsFree,
  hostPortsFromDockerInspect,
  hostPortsFromSpec,
  rewriteDockerPortBindError,
  type HostPortLookup,
} from "./host-port-bind.js";
import type { ContainerInfo, ContainerSpec, DockerAdapter, LogFollowHandle } from "./types.js";

function mapStatus(status: string | undefined): ContainerInfo["status"] {
  const s = (status ?? "").toLowerCase();
  if (s.includes("running")) return "running";
  if (s.includes("created")) return "created";
  if (s.includes("exited") || s.includes("dead") || s.includes("stopped")) return "exited";
  return "unknown";
}

function hostPortLookup(): HostPortLookup {
  return {
    listContainers: () => listHostContainers(),
    listenTable: (protocol) => {
      try {
        const args = protocol === "udp" ? ["-ulnp"] : ["-tlnp"];
        return execFileSync("ss", args, {
          encoding: "utf8",
          timeout: 5_000,
          windowsHide: true,
        });
      } catch {
        return null;
      }
    },
  };
}

/** Real Docker Engine adapter via dockerode. */
export class DockerodeAdapter implements DockerAdapter {
  private readonly docker: Docker;
  private engine: DockerEngineInfo | null = null;

  constructor(options?: Docker.DockerOptions) {
    this.docker = new Docker(options);
  }

  async ping(): Promise<void> {
    await this.docker.ping();
  }

  private async ensureEngine(): Promise<DockerEngineInfo> {
    if (this.engine) return this.engine;
    const inspected = await inspectDockerEngine({
      info: async () => (await this.docker.info()) as { OSType?: string; Isolation?: string },
    });
    this.engine = inspected ?? parseDockerEngineInfo({ OSType: "linux" })!;
    return this.engine;
  }

  /** Pull image if missing locally (createContainer does not auto-pull). */
  private async ensureImage(image: string, platform?: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
      return;
    } catch {
      /* missing — pull below */
    }
    const pullOpts = platform ? { platform } : {};
    await new Promise<void>((resolve, reject) => {
      this.docker.pull(image, pullOpts, (err, stream) => {
        if (err || !stream) {
          reject(err ?? new Error("docker_pull_no_stream"));
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
    const lookup = hostPortLookup();
    await assertHostPortsFree(hostPortsFromSpec(spec.ports), lookup);
    const engine = await this.ensureEngine();
    const platform = engine.osType === "windows" ? "windows/amd64" : undefined;
    await this.ensureImage(spec.image, platform);

    try {
      const container = await this.docker.createContainer(buildContainerCreateOptions(spec, engine));
      return { id: container.id, name: spec.name, status: "created" };
    } catch (err) {
      await rewriteDockerPortBindError(err, lookup);
      throw err;
    }
  }

  async start(id: string): Promise<void> {
    const lookup = hostPortLookup();
    try {
      const info = await this.docker.getContainer(id).inspect();
      await assertHostPortsFree(hostPortsFromDockerInspect(info), lookup);
    } catch (err) {
      if (err instanceof HostPortInUseError) throw err;
      /* inspect failed — start may still work; bind errors rewrite below */
    }
    try {
      await this.docker.getContainer(id).start();
    } catch (err) {
      await rewriteDockerPortBindError(err, lookup);
    }
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
    let tty = false;
    try {
      const info = await container.inspect();
      tty = Boolean(info.Config?.Tty);
    } catch {
      /* treat as multiplexed */
    }
    const stream = (await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      tail: opts?.tail ?? 40,
      timestamps: false,
    })) as NodeJS.ReadableStream;

    let aborted = false;
    const feedLine = (chunk: Buffer | string, carry: { value: string }) => {
      if (aborted) return;
      carry.value += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const parts = carry.value.split(/\r?\n/);
      carry.value = parts.pop() ?? "";
      for (const line of parts) {
        if (line) onLine(line);
      }
    };

    if (tty) {
      const carry = { value: "" };
      const onData = (chunk: Buffer | string) => feedLine(chunk, carry);
      stream.on("data", onData);
      const abort = () => {
        if (aborted) return;
        aborted = true;
        stream.off("data", onData);
        const destroyable = stream as unknown as { destroy?: () => void };
        destroyable.destroy?.();
      };
      stream.on("end", abort);
      stream.on("error", abort);
      return { abort };
    }

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    container.modem.demuxStream(stream, stdout, stderr);

    const buffers = { out: { value: "" }, err: { value: "" } };
    const onStdout = (chunk: Buffer | string) => feedLine(chunk, buffers.out);
    const onStderr = (chunk: Buffer | string) => feedLine(chunk, buffers.err);
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
