import { describe, expect, it } from "vitest";
import {
  createDockerLogFrameParser,
  demuxDockerLogBuffer,
  looksLikeDockerMultiplex,
  splitLogLines,
} from "./docker-log-demux.js";

function frame(streamType: number, text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const header = Buffer.alloc(8);
  header[0] = streamType;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

describe("demuxDockerLogBuffer", () => {
  it("strips multiplex headers from stdout/stderr frames", () => {
    const buf = Buffer.concat([
      frame(1, "[10:27:00 INFO]: Done\n"),
      frame(2, "[10:27:00 WARN]: oops\n"),
    ]);
    expect(looksLikeDockerMultiplex(buf)).toBe(true);
    expect(demuxDockerLogBuffer(buf)).toBe(
      "[10:27:00 INFO]: Done\n[10:27:00 WARN]: oops\n",
    );
    expect(splitLogLines(demuxDockerLogBuffer(buf))).toEqual([
      "[10:27:00 INFO]: Done",
      "[10:27:00 WARN]: oops",
    ]);
  });

  it("passes through plain TTY text", () => {
    const text = "[10:27:00 INFO]: Done (12.249s)! For help, type \"help\"\n";
    const buf = Buffer.from(text, "utf8");
    expect(looksLikeDockerMultiplex(buf)).toBe(false);
    expect(demuxDockerLogBuffer(buf)).toBe(text);
  });

  it("does not leave junk prefixes like the console tofu bug", () => {
    const line = '[10:27:00 INFO]: Thread RCON Client /172.17.0.1 started\n';
    const buf = frame(1, line);
    const demuxed = demuxDockerLogBuffer(buf);
    expect(demuxed.startsWith("[")).toBe(true);
    expect(demuxed).not.toMatch(/^\u0001/);
  });
});

describe("createDockerLogFrameParser", () => {
  it("reassembles split frames across chunks", () => {
    const full = frame(1, "hello\nworld\n");
    const parts: Buffer[] = [];
    const parser = createDockerLogFrameParser((c) => parts.push(c));
    parser.push(full.subarray(0, 5));
    parser.push(full.subarray(5, 12));
    parser.push(full.subarray(12));
    expect(Buffer.concat(parts).toString("utf8")).toBe("hello\nworld\n");
  });
});
