import { startControlPlane } from "./control-plane-lifecycle.js";

void startControlPlane({
  onStopped: (report) => {
    // Sockets destroyed past the grace period can still hold the event loop.
    if (!report.httpClosed || report.forcedConnections) process.exit(0);
  },
});
