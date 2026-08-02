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

export type AgentCastView = {
  persona: string;
  level: number;
  title: string;
};

type Props = {
  servers: ServerRow[];
  selectedId?: string;
  /** Latest activity keyed by persona (global cast). */
  activityByPersona: Record<string, AgentActivityView | undefined>;
  /** Global cast for map sprites. */
  cast: AgentCastView[];
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

type PersonaSprite = {
  persona: string;
  root: Container;
  body: Graphics;
  label: Text;
  levelText: Text;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  lastServerId?: string;
};

/** Classic 2:1 isometric tile half-size — angled floor, not top-down. */
const ISO_TILE_W = 56;
const ISO_TILE_H = 28;
/** How many tiles out from origin along each iso axis. */
const ISO_RANGE = 48;
const LERP_SPEED = 8;

const PERSONA_COLORS: Record<string, number> = {
  installer: 0x5ed4c8,
  monitor: 0x6aa8e8,
  configurer: 0xc4a35a,
  troubleshooter: 0xe08a4a,
  backup: 0x8a7fd4,
  player_panel: 0xe05a9c,
  modder: 0x7bc96f,
  orchestrator: 0xf2e8ee,
};

function layoutPosition(index: number): { x: number; y: number } {
  const col = index % 3;
  const row = Math.floor(index / 3);
  return { x: col * 280 - 280, y: row * 200 - 40 };
}

function homeSlot(index: number, total: number): { x: number; y: number } {
  const angle = (index / Math.max(total, 1)) * Math.PI * 2 - Math.PI / 2;
  const radius = 160;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius + 120 };
}

function shortPersona(persona: string): string {
  const map: Record<string, string> = {
    installer: "install",
    monitor: "monitor",
    configurer: "config",
    troubleshooter: "fix",
    backup: "backup",
    player_panel: "panel",
    modder: "mod",
    orchestrator: "orch",
  };
  return map[persona] ?? persona.slice(0, 6);
}

function verbOffset(verb: string): { x: number; y: number } {
  if (verb === "fetch" || verb === "search") return { x: 70, y: -36 };
  if (verb === "write" || verb === "skill") return { x: -56, y: 28 };
  if (verb === "run" || verb === "snapshot") return { x: 56, y: 28 };
  return { x: 64, y: 0 };
}

/** Screen point for isometric lattice indices (i, j). */
function isoPoint(i: number, j: number): { x: number; y: number } {
  return {
    x: (i - j) * ISO_TILE_W,
    y: (i + j) * ISO_TILE_H,
  };
}

/**
 * Proper parallelogram / 2:1 isometric floor — same “looking at an angle”
 * feel as before, but both line families share consistent slopes so the
 * lattice tiles cleanly and spans a large pan/zoom range.
 */
function drawFloorGrid(g: Graphics) {
  g.clear();
  const n = ISO_RANGE;
  // Lines of constant i (run along +j): direction (-W, H)
  for (let i = -n; i <= n; i++) {
    const a = isoPoint(i, -n);
    const b = isoPoint(i, n);
    g.moveTo(a.x, a.y).lineTo(b.x, b.y);
  }
  // Lines of constant j (run along +i): direction (+W, H)
  for (let j = -n; j <= n; j++) {
    const a = isoPoint(-n, j);
    const b = isoPoint(n, j);
    g.moveTo(a.x, a.y).lineTo(b.x, b.y);
  }
  g.stroke({ width: 1, color: 0xffffff, alpha: 0.05 });
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

function drawPersonaBody(g: Graphics, persona: string, busy: boolean) {
  g.clear();
  const color = PERSONA_COLORS[persona] ?? 0x5ed4c8;
  const body = busy ? 0xe05a9c : color;
  g.circle(0, 0, 12).fill({ color: body });
  g.circle(-4, -2.5, 2).fill({ color: 0x111111 });
  g.circle(4, -2.5, 2).fill({ color: 0x111111 });
  // Tiny hat / accent so personas read apart at a glance
  if (persona === "installer") {
    g.rect(-7, -14, 14, 4).fill({ color: 0x2a1f28 });
  } else if (persona === "monitor") {
    g.circle(0, -13, 3).fill({ color: 0x2a1f28 });
  } else if (persona === "troubleshooter") {
    g.moveTo(-6, -12).lineTo(0, -17).lineTo(6, -12).fill({ color: 0x2a1f28 });
  } else if (persona === "orchestrator") {
    g.circle(0, -13, 3.5).stroke({ width: 1.5, color: 0x2a1f28 });
  }
}

/**
 * Sparse Pixi stage: flat pan/zoom floor, server crates, global persona sprites.
 */
export function AgentCanvas({
  servers,
  selectedId,
  activityByPersona,
  cast,
  onSelect,
  onDescribe,
  onAddServer,
  showAddButton = true,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<Application | null>(null);
  const worldRef = useRef<Container | null>(null);
  const nodesRef = useRef<Map<string, ServerNode>>(new Map());
  const personasRef = useRef<Map<string, PersonaSprite>>(new Map());
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

      const floor = new Graphics();
      drawFloorGrid(floor);
      world.addChild(floor);
      setStageReady(true);

      let dragging = false;
      let lastX = 0;
      let lastY = 0;
      let userPanned = false;
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
        userPanned = true;
      };
      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        const scale = Math.min(1.8, Math.max(0.55, world.scale.x * (e.deltaY > 0 ? 0.92 : 1.08)));
        world.scale.set(scale);
      };
      const onResize = () => {
        if (userPanned) return;
        world.x = host.clientWidth / 2;
        world.y = host.clientHeight / 2;
      };

      const tickerFn = () => {
        const dt = Math.min(app.ticker.deltaMS / 1000, 0.05);
        const t = 1 - Math.exp(-LERP_SPEED * dt);
        for (const sprite of personasRef.current.values()) {
          sprite.x += (sprite.targetX - sprite.x) * t;
          sprite.y += (sprite.targetY - sprite.y) * t;
          sprite.root.x = sprite.x;
          sprite.root.y = sprite.y;
        }
      };
      app.ticker.add(tickerFn);

      app.canvas.addEventListener("pointerdown", onPointerDown);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointermove", onPointerMove);
      app.canvas.addEventListener("wheel", onWheel, { passive: false });
      window.addEventListener("resize", onResize);

      (app as Application & { __cleanup?: () => void }).__cleanup = () => {
        app.ticker.remove(tickerFn);
        app.canvas.removeEventListener("pointerdown", onPointerDown);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointermove", onPointerMove);
        app.canvas.removeEventListener("wheel", onWheel);
        window.removeEventListener("resize", onResize);
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
      personasRef.current.clear();
    };
  }, []);

  // Sync server crates
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
      const name = node.root.getChildByLabel("name") as Text;
      const status = node.root.getChildByLabel("status") as Text;
      const selected = server.id === selectedId;
      const busyActivity = Object.values(activityByPersona).find(
        (a) => a && a.serverId === server.id && a.phase !== "idle",
      );
      drawCrate(crate, selected, server.status === "running");
      name.text = server.name;
      status.text = busyActivity?.label || statusLabel(server.status);
    });

    for (const [id, node] of nodesRef.current) {
      if (!seen.has(id)) {
        world.removeChild(node.root);
        node.root.destroy({ children: true });
        nodesRef.current.delete(id);
      }
    }
  }, [servers, selectedId, activityByPersona, stageReady]);

  // Sync global persona sprites + movement targets
  useEffect(() => {
    const world = worldRef.current;
    if (!world || !stageReady) return;

    const roster = cast.length
      ? cast
      : [
          "installer",
          "monitor",
          "configurer",
          "troubleshooter",
          "backup",
          "player_panel",
          "modder",
          "orchestrator",
        ].map((persona) => ({ persona, level: 1, title: `Rookie ${persona}` }));

    const seen = new Set<string>();
    roster.forEach((agent, index) => {
      seen.add(agent.persona);
      let sprite = personasRef.current.get(agent.persona);
      if (!sprite) {
        const home = homeSlot(index, roster.length);
        const root = new Container();
        root.x = home.x;
        root.y = home.y;
        root.zIndex = 10;

        const body = new Graphics();
        body.label = "body";
        root.addChild(body);

        const label = new Text({
          text: shortPersona(agent.persona),
          style: { fill: 0xf2e8ee, fontSize: 10, fontFamily: "DM Sans, sans-serif" },
        });
        label.anchor.set(0.5, 0);
        label.y = 14;
        root.addChild(label);

        const levelText = new Text({
          text: `Lv${agent.level}`,
          style: { fill: 0xa898a0, fontSize: 9, fontFamily: "DM Sans, sans-serif" },
        });
        levelText.anchor.set(0.5, 0);
        levelText.y = 25;
        root.addChild(levelText);

        world.addChild(root);
        sprite = {
          persona: agent.persona,
          root,
          body,
          label,
          levelText,
          x: home.x,
          y: home.y,
          targetX: home.x,
          targetY: home.y,
        };
        personasRef.current.set(agent.persona, sprite);
      }

      const activity = activityByPersona[agent.persona];
      const busy = Boolean(activity && activity.phase !== "idle");
      drawPersonaBody(sprite.body, agent.persona, busy);
      sprite.levelText.text = `Lv${agent.level}`;

      if (activity && activity.phase !== "idle" && activity.serverId) {
        const node = nodesRef.current.get(activity.serverId);
        if (node) {
          const off = verbOffset(activity.verb);
          sprite.targetX = node.x + off.x;
          sprite.targetY = node.y + off.y;
          sprite.lastServerId = activity.serverId;
        }
      } else if (sprite.lastServerId) {
        const node = nodesRef.current.get(sprite.lastServerId);
        if (node) {
          sprite.targetX = node.x + 64;
          sprite.targetY = node.y + (index % 3) * 18 - 18;
        }
      } else {
        const home = homeSlot(index, roster.length);
        sprite.targetX = home.x;
        sprite.targetY = home.y;
      }
    });

    for (const [persona, sprite] of personasRef.current) {
      if (!seen.has(persona)) {
        world.removeChild(sprite.root);
        sprite.root.destroy({ children: true });
        personasRef.current.delete(persona);
      }
    }

    world.sortableChildren = true;
  }, [cast, activityByPersona, servers, stageReady]);

  const serverBusyLabel = (serverId: string): string | undefined => {
    const hit = Object.values(activityByPersona).find(
      (a) => a && a.serverId === serverId && a.phase !== "idle",
    );
    return hit?.label;
  };

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
                const busyLabel = serverBusyLabel(server.id);
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
                        {busyLabel || statusLabel(server.status)}
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
