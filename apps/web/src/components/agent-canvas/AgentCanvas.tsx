import { useEffect, useRef, useState } from "react";
import { Application, Container, Graphics, Text } from "pixi.js";
import type { ServerRow } from "../../api";
import { statusLabel } from "../../status";

export type AgentActivityView = {
  serverId: string;
  persona: string;
  phase: string;
  verb: string;
  label?: string;
};

type Props = {
  servers: ServerRow[];
  selectedId?: string;
  activityByServer: Record<string, AgentActivityView | undefined>;
  onSelect: (serverId: string | undefined) => void;
  /** Empty map: open unbound install chat. */
  onDescribe: () => void;
  /** Non-empty map: deselect + open install chat for another server. */
  onAddServer: () => void;
  /** Hide floating add when the chat dock already covers that corner. */
  showAddButton?: boolean;
};

type ServerNode = {
  id: string;
  x: number;
  y: number;
  root: Container;
};

function layoutPosition(index: number): { x: number; y: number } {
  const col = index % 3;
  const row = Math.floor(index / 3);
  return { x: col * 280 - 280, y: row * 200 - 40 };
}

function drawCrate(g: Graphics, selected: boolean, running: boolean) {
  g.clear();
  const fill = running ? 0x3d8f8a : 0x4a3548;
  g.roundRect(-48, -40, 96, 80, 10).fill({ color: fill });
  g.roundRect(-48, -40, 96, 80, 10).stroke({
    width: selected ? 3 : 1.5,
    color: selected ? 0x5ed4c8 : 0x8a6078,
  });
  g.rect(-30, -18, 60, 8).fill({ color: 0x2a1f28, alpha: 0.5 });
}

function drawAgent(g: Graphics, busy: boolean) {
  g.clear();
  const body = busy ? 0xe05a9c : 0x5ed4c8;
  g.circle(0, 0, 14).fill({ color: body });
  g.circle(-5, -3, 2.5).fill({ color: 0x111111 });
  g.circle(5, -3, 2.5).fill({ color: 0x111111 });
}

/**
 * Sparse 2.5D-ish Pixi stage: pan/zoom world with server crates + agent sprites.
 */
export function AgentCanvas({
  servers,
  selectedId,
  activityByServer,
  onSelect,
  onDescribe,
  onAddServer,
  showAddButton = true,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<Application | null>(null);
  const worldRef = useRef<Container | null>(null);
  const nodesRef = useRef<Map<string, ServerNode>>(new Map());
  const onSelectRef = useRef(onSelect);
  const onDescribeRef = useRef(onDescribe);
  const onAddServerRef = useRef(onAddServer);
  const [stageReady, setStageReady] = useState(false);
  onSelectRef.current = onSelect;
  onDescribeRef.current = onDescribe;
  onAddServerRef.current = onAddServer;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let destroyed = false;
    const app = new Application();

    void (async () => {
      await app.init({
        background: 0x1c1418,
        antialias: true,
        resizeTo: host,
        resolution: window.devicePixelRatio || 1,
        autoDensity: true,
      });
      if (destroyed) {
        app.destroy(true);
        return;
      }
      host.appendChild(app.canvas);
      appRef.current = app;

      const world = new Container();
      world.x = host.clientWidth / 2;
      world.y = host.clientHeight / 2;
      worldRef.current = world;
      app.stage.addChild(world);
      setStageReady(true);

      // Soft isometric floor hint
      const floor = new Graphics();
      for (let i = -12; i <= 12; i++) {
        floor.moveTo(i * 60 - 400, -300).lineTo(i * 60 + 400, 500);
        floor.moveTo(-400, i * 50).lineTo(500, i * 50 + 200);
      }
      floor.stroke({ width: 1, color: 0xffffff, alpha: 0.04 });
      world.addChild(floor);

      let dragging = false;
      let lastX = 0;
      let lastY = 0;
      app.canvas.style.cursor = "grab";

      const onPointerDown = (e: PointerEvent) => {
        if (e.button !== 0) return;
        dragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
        app.canvas.style.cursor = "grabbing";
      };
      const onPointerUp = () => {
        dragging = false;
        app.canvas.style.cursor = "grab";
      };
      const onPointerMove = (e: PointerEvent) => {
        if (!dragging) return;
        world.x += e.clientX - lastX;
        world.y += e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
      };
      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        const scale = Math.min(1.8, Math.max(0.55, world.scale.x * (e.deltaY > 0 ? 0.92 : 1.08)));
        world.scale.set(scale);
      };

      app.canvas.addEventListener("pointerdown", onPointerDown);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointermove", onPointerMove);
      app.canvas.addEventListener("wheel", onWheel, { passive: false });

      (app as Application & { __cleanup?: () => void }).__cleanup = () => {
        app.canvas.removeEventListener("pointerdown", onPointerDown);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointermove", onPointerMove);
        app.canvas.removeEventListener("wheel", onWheel);
      };
    })();

    return () => {
      destroyed = true;
      setStageReady(false);
      const app = appRef.current;
      if (app) {
        (app as Application & { __cleanup?: () => void }).__cleanup?.();
        app.destroy(true);
      }
      appRef.current = null;
      worldRef.current = null;
      nodesRef.current.clear();
    };
  }, []);

  // Sync server nodes
  useEffect(() => {
    const world = worldRef.current;
    if (!world || !stageReady) return;

    const seen = new Set<string>();
    servers.forEach((server, index) => {
      seen.add(server.id);
      let node = nodesRef.current.get(server.id);
      if (!node) {
        const pos = layoutPosition(index);
        const root = new Container();
        root.x = pos.x;
        root.y = pos.y;
        root.eventMode = "static";
        root.cursor = "pointer";

        const crate = new Graphics();
        crate.label = "crate";
        root.addChild(crate);

        const agent = new Graphics();
        agent.label = "agent";
        agent.x = 70;
        agent.y = 10;
        root.addChild(agent);

        const label = new Text({
          text: server.name,
          style: { fill: 0xf2e8ee, fontSize: 13, fontFamily: "DM Sans, sans-serif" },
        });
        label.anchor.set(0.5, 0);
        label.y = 50;
        label.label = "name";
        root.addChild(label);

        const status = new Text({
          text: "",
          style: { fill: 0xa898a0, fontSize: 11, fontFamily: "DM Sans, sans-serif" },
        });
        status.anchor.set(0.5, 0);
        status.y = 68;
        status.label = "status";
        root.addChild(status);

        root.on("pointertap", () => {
          onSelectRef.current(server.id);
        });

        world.addChild(root);
        node = { id: server.id, x: pos.x, y: pos.y, root };
        nodesRef.current.set(server.id, node);
      }

      const crate = node.root.getChildByLabel("crate") as Graphics;
      const agent = node.root.getChildByLabel("agent") as Graphics;
      const name = node.root.getChildByLabel("name") as Text;
      const status = node.root.getChildByLabel("status") as Text;
      const selected = server.id === selectedId;
      const activity = activityByServer[server.id];
      drawCrate(crate, selected, server.status === "running");
      drawAgent(agent, Boolean(activity && activity.phase !== "idle"));
      name.text = server.name;
      status.text = activity?.label || statusLabel(server.status);

      // Simple motion toward "portal" when fetching
      if (activity?.verb === "fetch" || activity?.verb === "search") {
        agent.x = 110;
        agent.y = -20;
      } else if (activity?.verb === "write" || activity?.verb === "skill") {
        agent.x = 40;
        agent.y = 35;
      } else {
        agent.x = 70;
        agent.y = 10;
      }
    });

    for (const [id, node] of nodesRef.current) {
      if (!seen.has(id)) {
        world.removeChild(node.root);
        node.root.destroy({ children: true });
        nodesRef.current.delete(id);
      }
    }
  }, [servers, selectedId, activityByServer, stageReady]);

  return (
    <div className="agent-canvas-host">
      <div ref={hostRef} className="agent-canvas-stage" aria-hidden={servers.length > 0} />
      {servers.length === 0 ? (
        <div className="agent-canvas-empty">
          <div className="empty-hint">
            <strong>Your LAN map is empty</strong>
            <p className="muted status-inline">Tell the agents what to stand up tonight.</p>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => onDescribeRef.current()}
          >
            Describe a server
          </button>
        </div>
      ) : (
        <>
          <div className="agent-canvas-rail">
            <p className="agent-canvas-rail-label" id="server-list-label">
              Servers
            </p>
            <ul
              className="agent-canvas-list"
              role="listbox"
              aria-labelledby="server-list-label"
              tabIndex={0}
              onKeyDown={(e) => {
                if (!servers.length) return;
                const idx = Math.max(
                  0,
                  servers.findIndex((s) => s.id === selectedId),
                );
                if (e.key === "ArrowDown" || e.key === "ArrowRight") {
                  e.preventDefault();
                  const next = servers[(idx + 1) % servers.length]!;
                  onSelectRef.current(next.id);
                } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
                  e.preventDefault();
                  const prev = servers[(idx - 1 + servers.length) % servers.length]!;
                  onSelectRef.current(prev.id);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  onSelectRef.current(undefined);
                }
              }}
            >
              {servers.map((server) => {
                const selected = server.id === selectedId;
                const busy = Boolean(
                  activityByServer[server.id] &&
                    activityByServer[server.id]!.phase !== "idle",
                );
                return (
                  <li key={server.id} role="option" aria-selected={selected}>
                    <button
                      type="button"
                      className={
                        selected
                          ? "agent-canvas-list-item selected"
                          : "agent-canvas-list-item"
                      }
                      onClick={() => onSelectRef.current(server.id)}
                    >
                      <span className="agent-canvas-list-name">{server.name}</span>
                      <span className="muted">
                        {busy
                          ? activityByServer[server.id]?.label || "busy"
                          : statusLabel(server.status)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
          {showAddButton ? (
            <button
              type="button"
              className="btn btn-primary agent-canvas-add"
              onClick={() => onAddServerRef.current()}
            >
              + Add server
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
