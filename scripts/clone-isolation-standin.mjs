#!/usr/bin/env node
/**
 * Disposable stand-in for a "live" game server.
 * Binds the given loopback ports and writes one save file. It does not run a
 * game binary and it never binds 0.0.0.0.
 */
import dgram from "node:dgram";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const spec = JSON.parse(process.env.PLAYON_STANDIN_SPEC || "");
if (!spec?.savePath || !Array.isArray(spec.ports) || !spec.readyPath) {
  console.error("stand-in spec missing");
  process.exit(2);
}

const handles = [];

function listen(port) {
  const protocol = port.protocol === "tcp" ? "tcp" : "udp";
  if (protocol === "tcp") {
    const server = net.createServer((socket) => socket.end());
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port.port, "127.0.0.1", () => resolve(server));
    });
  }
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: false });
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind({ port: port.port, address: "127.0.0.1", exclusive: true }, () => resolve(socket));
  });
}

async function main() {
  for (const port of spec.ports) {
    handles.push(await listen(port));
  }
  fs.mkdirSync(path.dirname(spec.savePath), { recursive: true });
  fs.writeFileSync(spec.savePath, spec.saveBody ?? `stand-in ${process.pid}\n`);
  fs.writeFileSync(
    spec.readyPath,
    JSON.stringify({ pid: process.pid, savePath: spec.savePath, name: spec.name ?? "" }),
  );
}

function shutdown() {
  for (const handle of handles) {
    try {
      handle.close();
    } catch {
      /* already closed */
    }
  }
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
