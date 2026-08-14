import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { listenPortProxy, type LivePortProxy } from "./port-proxy.js";

const live: LivePortProxy[] = [];

afterEach(() => {
  while (live.length) live.pop()?.close();
});

function listenBackend(): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.on("data", (buf) => socket.write(`ack:${buf.toString()}`));
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("listen_failed"));
        return;
      }
      resolve({ server, port: addr.port });
    });
  });
}

describe("listenPortProxy", () => {
  it("forwards TCP from the listen address to the target", async () => {
    const backend = await listenBackend();
    try {
      const proxy = await listenPortProxy({
        listenHost: "127.0.0.1",
        listenPort: 0,
        protocol: "tcp",
        targetHost: "127.0.0.1",
        targetPort: backend.port,
      });
      live.push(proxy);
      expect(proxy.listenPort).toBeGreaterThan(0);
      const got = await new Promise<string>((resolve, reject) => {
        const client = net.connect({ host: "127.0.0.1", port: proxy.listenPort });
        client.once("error", reject);
        client.write("ping");
        client.once("data", (buf) => {
          client.end();
          resolve(buf.toString());
        });
      });
      expect(got).toBe("ack:ping");
    } finally {
      await new Promise<void>((resolve) => backend.server.close(() => resolve()));
    }
  });
});
