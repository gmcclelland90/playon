import { useEffect, useRef, useState } from "react";
import { Application, Container, Graphics, Text } from "pixi.js";
import type { ServerRow } from "../../api";
import { statusLabel } from "../../status";

export type AgentActivityView = {
  serverId: string;
  skill: string;
  phase: string;
  verb: string;
  label?: string;
};

export type AgentSkillView = {
  skill: string;
  level: number;
  title: string;
};

type Props = {
  servers: ServerRow[];
  /** True while the servers query has not settled — avoid false empty CTA. */
  serversLoading?: boolean;
  selectedId?: string;
  /** Latest agent activity (one agent). */
  activity?: AgentActivityView;
  /** Skill roster for accent colors while busy. */
  skills: AgentSkillView[];
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

type AgentSprite = {
  root: Container;
  body: Graphics;
  label: Text;
  statusText: Text;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  bobPhase: number;
};

/** Classic 2:1 isometric tile half-size — angled floor, not top-down. */
const ISO_TILE_W = 56;
const ISO_TILE_H = 28;
/** How many tiles out from origin along each iso axis. */
const ISO_RANGE = 48;
const LERP_SPEED = 8;

const SKILL_COLORS: Record<string, number> = {
  installer: 0x5ed4c8,
  monitor: 0x6aa8e8,
  configurer: 0xc4a35a,
  troubleshooter: 0xe08a4a,
  backup: 0x8a7fd4,
  player_panel: 0xe05a9c,
  modder: 0x7bc96f,
  orchestrator: 0xf2e8ee,
};

const IDLE_COLOR = 0x5ed4c8;

const SKILL_SHORT: Record<string, string> = {
  installer: "Install",
  monitor: "Monitor",
  configurer: "Config",
  troubleshooter: "Fix",
  backup: "Backup",
  player_panel: "Panel",
  modder: "Mod",
  orchestrator: "Lead",
};

export function skillShortLabel(skill: string): string {
  return SKILL_SHORT[skill] ?? skill.replace(/_/g, " ");
}

export function skillColor(skill: string): number {
  return SKILL_COLORS[skill] ?? IDLE_COLOR;
}

function layoutPosition(index: number): { x: number; y: number } {
  const col = index % 3;
  const row = Math.floor(index / 3);
  return { x: col * 280 - 280, y: row * 200 - 40 };
}

function homeSpot(): { x: number; y: number } {
  return { x: 0, y: 140 };
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

function drawFloorGrid(g: Graphics) {
  g.clear();
  const n = ISO_RANGE;
  for (let i = -n; i <= n; i++) {
    const a = isoPoint(i, -n);
    const b = isoPoint(i, n);
    g.moveTo(a.x, a.y).lineTo(b.x, b.y);
  }
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

function phaseRingColor(phase: string | undefined): number {
  if (phase === "working" || phase === "tool" || phase === "tool_start" || phase === "tool_done") {
    return 0x5ed4c8;
  }
  if (phase === "waiting" || phase === "confirm" || phase === "confirm_wait") return 0xc4a35a;
  if (phase === "error" || phase === "failed" || phase === "tool_fail") return 0xe05a5a;
  if (phase === "thinking") return 0x6aa8e8;
  return 0xe05a9c;
}

function drawAgentBody(
  g: Graphics,
  opts: { busy: boolean; phase?: string; skill?: string },
) {
  g.clear();
  const color = opts.busy && opts.skill ? skillColor(opts.skill) : IDLE_COLOR;
  const r = 18;
  g.circle(0, 0, r).fill({ color, alpha: opts.busy ? 1 : 0.75 });
  if (opts.busy) {
    g.circle(0, 0, r + 5).stroke({ width: 2.5, color: phaseRingColor(opts.phase), alpha: 0.95 });
  }
  // Eyes
  g.circle(-5, -3, 2.4).fill({ color: 0x111111 });
  g.circle(5, -3, 2.4).fill({ color: 0x111111 });
  // Soft highlight
  g.circle(-7, -8, 3).fill({ color: 0xffffff, alpha: 0.18 });
  // Cap accent when busy on a skill
  if (opts.busy && opts.skill) {
    g.roundRect(-10, -r - 4, 20, 5, 2).fill({ color: 0x2a1f28, alpha: 0.85 });
  }
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * Sparse Pixi stage: isometric floor, server crates, one agent sprite.
 */
export function AgentCanvas({
  servers,
  serversLoading = false,
  selectedId,
  activity,
  skills: _skills,
  onSelect,
  onDescribe,
  onAddServer,
  showAddButton = true,
}: Props) {
  void _skills;
  const hostRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<Application | null>(null);
  const worldRef = useRef<Container | null>(null);
  const nodesRef = useRef<Map<string, ServerNode>>(new Map());
  const agentRef = useRef<AgentSprite | null>(null);
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

      const reduceMotion = prefersReducedMotion();
      const tickerFn = () => {
        const sprite = agentRef.current;
        if (!sprite) return;
        if (reduceMotion) {
          sprite.x = sprite.targetX;
          sprite.y = sprite.targetY;
          sprite.root.x = sprite.x;
          sprite.root.y = sprite.y;
          return;
        }
        const dt = Math.min(app.ticker.deltaMS / 1000, 0.05);
        const t = 1 - Math.exp(-LERP_SPEED * dt);
        sprite.x += (sprite.targetX - sprite.x) * t;
        sprite.y += (sprite.targetY - sprite.y) * t;
        sprite.bobPhase += dt * 3.2;
        const bob = Math.sin(sprite.bobPhase) * 2.2;
        sprite.root.x = sprite.x;
        sprite.root.y = sprite.y + bob;
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
      agentRef.current = null;
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
      const busyHere =
        activity && activity.serverId === server.id && activity.phase !== "idle"
          ? activity
          : undefined;
      drawCrate(crate, selected, server.status === "running");
      name.text = server.name;
      status.text = busyHere
        ? `${statusLabel(server.status)} · ${busyHere.label || busyHere.verb}`
        : statusLabel(server.status);
    });

    for (const [id, node] of nodesRef.current) {
      if (!seen.has(id)) {
        world.removeChild(node.root);
        node.root.destroy({ children: true });
        nodesRef.current.delete(id);
      }
    }
  }, [servers, selectedId, activity, stageReady]);

  // Sync single agent sprite
  useEffect(() => {
    const world = worldRef.current;
    if (!world || !stageReady) return;

    let sprite = agentRef.current;
    if (!sprite) {
      const home = homeSpot();
      const root = new Container();
      root.x = home.x;
      root.y = home.y;
      root.zIndex = 10;

      const body = new Graphics();
      body.label = "body";
      root.addChild(body);

      const label = new Text({
        text: "Agent",
        style: { fill: 0xf2e8ee, fontSize: 11, fontFamily: "DM Sans, sans-serif" },
      });
      label.anchor.set(0.5, 0);
      label.y = 22;
      root.addChild(label);

      const statusText = new Text({
        text: "",
        style: { fill: 0xa898a0, fontSize: 9, fontFamily: "DM Sans, sans-serif" },
      });
      statusText.anchor.set(0.5, 0);
      statusText.y = 34;
      root.addChild(statusText);

      world.addChild(root);
      sprite = {
        root,
        body,
        label,
        statusText,
        x: home.x,
        y: home.y,
        targetX: home.x,
        targetY: home.y,
        bobPhase: 0,
      };
      agentRef.current = sprite;
    }

    const busy = Boolean(activity && activity.phase !== "idle");
    drawAgentBody(sprite.body, {
      busy,
      phase: activity?.phase,
      skill: activity?.skill,
    });
    sprite.statusText.text = busy
      ? (activity?.label ?? activity?.verb ?? "busy").slice(0, 18)
      : "";
    sprite.label.alpha = busy ? 1 : 0.85;

    if (busy && activity?.serverId) {
      const node = nodesRef.current.get(activity.serverId);
      if (node) {
        const off = verbOffset(activity.verb);
        sprite.targetX = node.x + off.x;
        sprite.targetY = node.y + off.y;
      }
    } else if (selectedId) {
      const node = nodesRef.current.get(selectedId);
      if (node) {
        sprite.targetX = node.x + 64;
        sprite.targetY = node.y;
      } else {
        const home = homeSpot();
        sprite.targetX = home.x;
        sprite.targetY = home.y;
      }
    } else {
      const home = homeSpot();
      sprite.targetX = home.x;
      sprite.targetY = home.y;
    }

    if (prefersReducedMotion()) {
      sprite.x = sprite.targetX;
      sprite.y = sprite.targetY;
      sprite.root.x = sprite.x;
      sprite.root.y = sprite.y;
    }

    world.sortableChildren = true;
  }, [activity, selectedId, servers, stageReady]);

  const serverBusyLabel = (serverId: string): string | undefined => {
    if (activity && activity.serverId === serverId && activity.phase !== "idle") {
      return activity.label;
    }
    return undefined;
  };

  const liveBusy = activity && activity.phase !== "idle" ? activity : undefined;

  return (
    <div className="agent-canvas-host">
      <div
        ref={hostRef}
        className="agent-canvas-stage"
        role="img"
        aria-label={
          servers.length === 0
            ? "Empty LAN map"
            : `LAN map with ${servers.length} server${servers.length === 1 ? "" : "s"}`
        }
      />
      {serversLoading && servers.length === 0 ? (
        <div className="agent-canvas-empty" aria-busy="true">
          <div className="empty-hint">
            <strong>Loading map…</strong>
            <p className="muted status-inline">Checking for servers on this host.</p>
          </div>
          <div className="skeleton" aria-hidden>
            <div className="skeleton-row compact" />
            <div className="skeleton-row" />
          </div>
        </div>
      ) : servers.length === 0 ? (
        <div className="agent-canvas-empty">
          <div className="empty-hint">
            <strong>Your LAN map is empty</strong>
            <p className="muted status-inline">Tell the agent what to stand up tonight.</p>
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
          <p className="agent-canvas-map-hint muted" aria-hidden>
            Drag to pan · Scroll to zoom
          </p>
          {liveBusy ? (
            <p className="agent-canvas-live-chip" role="status">
              {skillShortLabel(liveBusy.skill)} · {liveBusy.label ?? liveBusy.verb}
            </p>
          ) : null}
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
