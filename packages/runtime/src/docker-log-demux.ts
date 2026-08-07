/**
 * Docker non-TTY log streams are multiplexed frames:
 *   [streamType:u8][0][0][0][size:u32BE][payload…]
 * streamType: 0=stdin, 1=stdout, 2=stderr.
 *
 * When these headers are decoded as UTF-8 they show up as tofu / junk
 * characters before each line in the console UI.
 */

/** True when `buf` walks cleanly as multiplexed frames covering the whole buffer. */
export function looksLikeDockerMultiplex(buf: Buffer): boolean {
  if (buf.length < 8) return false;
  let offset = 0;
  let frames = 0;
  while (offset + 8 <= buf.length) {
    const streamType = buf[offset]!;
    if (streamType > 2) return false;
    // reserved zeros
    if (buf[offset + 1] !== 0 || buf[offset + 2] !== 0 || buf[offset + 3] !== 0) {
      return false;
    }
    const size = buf.readUInt32BE(offset + 4);
    offset += 8;
    if (offset + size > buf.length) return false;
    offset += size;
    frames += 1;
  }
  return frames > 0 && offset === buf.length;
}

/** Strip multiplex headers; pass through plain/TTY text unchanged. */
export function demuxDockerLogBuffer(buf: Buffer): string {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return "";
  if (!looksLikeDockerMultiplex(buf)) {
    return buf.toString("utf8");
  }
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const size = buf.readUInt32BE(offset + 4);
    offset += 8;
    chunks.push(buf.subarray(offset, offset + size));
    offset += size;
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function splitLogLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.length > 0);
}

/**
 * Incremental demuxer for follow streams when modem.demuxStream is unavailable
 * or the raw multiplexed bytes are delivered on a single readable.
 */
export function createDockerLogFrameParser(onPayload: (chunk: Buffer) => void): {
  push: (chunk: Buffer | string) => void;
  flush: () => void;
} {
  let buf = Buffer.alloc(0);
  let multiplex: boolean | null = null;

  const push = (chunk: Buffer | string) => {
    const incoming = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    if (incoming.length === 0) return;
    buf = Buffer.concat([buf, incoming]);

    if (multiplex === null) {
      if (buf.length < 8) return;
      multiplex = buf[0]! <= 2 && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
    }

    if (!multiplex) {
      onPayload(buf);
      buf = Buffer.alloc(0);
      return;
    }

    while (buf.length >= 8) {
      const size = buf.readUInt32BE(4);
      if (buf.length < 8 + size) break;
      onPayload(buf.subarray(8, 8 + size));
      buf = buf.subarray(8 + size);
    }
  };

  const flush = () => {
    if (buf.length === 0) return;
    onPayload(buf);
    buf = Buffer.alloc(0);
  };

  return { push, flush };
}
