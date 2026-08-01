import type { PanelService } from "./panel.js";
import type { ServerService } from "./servers.js";

export async function publishServerPanel(
  servers: ServerService,
  panel: PanelService,
  serverId: string,
  status: "running" | "stopped",
): Promise<void> {
  const detail = await servers.detail(serverId);
  if (!detail?.runtime.join) return;
  const { address, port } = detail.runtime.join;
  await panel.replaceForServer(serverId, [
    {
      type: "join_info",
      title: "Join",
      body: {
        address,
        port,
        endpoint: `${address}:${port}`,
        runtime: detail.runtime.kind,
        container: detail.runtime.containerName,
      },
      sortOrder: 0,
    },
    {
      type: "server_status",
      title: "Status",
      body: {
        status,
        runtime: detail.runtime.kind,
        containerStatus: detail.runtime.containerStatus ?? status,
      },
      sortOrder: 1,
    },
    {
      type: "client_setup",
      title: "Client",
      body: {
        notes:
          detail.runtime.kind === "docker"
            ? `Real Docker container. Connect a Minecraft client to ${address}:${port}.`
            : `Runtime is ${detail.runtime.kind}.`,
      },
      sortOrder: 2,
    },
  ]);
}
