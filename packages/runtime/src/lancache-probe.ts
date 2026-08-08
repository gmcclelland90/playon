import net from "node:net";

/** TCP reachability check for a LANCache monolithic HTTP port. */
export function probeLancacheTcp(
  host: string,
  port = 80,
  timeoutMs = 800,
): Promise<boolean> {
  const ip = host.trim();
  if (!ip) return Promise.resolve(false);

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    try {
      socket.connect(port, ip);
    } catch {
      done(false);
    }
  });
}
