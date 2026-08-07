import { useEffect, useRef, useState } from "react";
import { Application, Container, Graphics, Text } from "pixi.js";
import type { ServerRow } from "../../api";
import { isPendingNodeSetup, nodePresenceLabel, statusLabel } from "../../status";
import {
  clusterServersByNode,
  crateOffsetInCluster,
  padPresenceClass,
  type MapNodeInput,
} from "./map-node-layout";

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

/** Host-local CSS pixels for the top-center of the selected crate. */
export type SelectedAnchor = { x: number; y: number };

export type { MapNodeInput };

/** Crate body is roundRect(-48, -40, 96, 80) — top edge is 40px above node center. */
const CRATE_TOP_OFFSET = 40;

type Props = {
  servers: ServerRow[];
  nodes?: MapNodeInput[];
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
  /** Open on-map Add node panel. */
  onAddNode?: () => void;
  /** Remove a stuck pending/offline remote node. */
  onRemoveNode?: (nodeId: string) => void;
  /** Open Scan / manage panel for an online host pad (incl. local). */
  onSelectHost?: (nodeId: string) => void;
  /** Screen-space anchor for overlays above the selected crate. */
  onSelectedAnchorChange?: (anchor: SelectedAnchor | null) => void;
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

function homeSpot(): { x: number; y: number } {
  return { x: 0, y: 140 };
}

const PAD_COLORS: Record<string, { fill: number; stroke: number }> = {
  online: { fill: 0x2a3d38, stroke: 0x5ed4c8 },
  stale: { fill: 0x3d3528, stroke: 0xc4a35a },
  offline: { fill: 0x3a282c, stroke: 0xc45a6a },
  pending_setup: { fill: 0x2e2a38, stroke: 0x8a7fd4 },
};

function drawHostPad(
  g: Graphics,
  presence: string,
  label: string,
  subtitle: string,
  width: number,
  height: number,
): void {
  const colors = PAD_COLORS[presence] ?? PAD_COLORS.offline!;
  g.clear();
  g.roundRect(-width / 2, -36, width, height, 18);
  g.fill({ color: colors.fill, alpha: 0.72 });
  g.stroke({ width: 2, color: colors.stroke, alpha: 0.85 });
  void label;
  void subtitle;
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
  nodes: hostNodes = [],
  serversLoading = false,
  selectedId,
  activity,
  skills: _skills,
  onSelect,
  onDescribe,
  onAddServer,
  onAddNode,
  onRemoveNode,
  onSelectHost,
  onSelectedAnchorChange,
  showAddButton = true,
}: Props) {
  void _skills;
  const hostRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<Application | null>(null);
  const worldRef = useRef<Container | null>(null);
  const nodesRef = useRef<Map<string, ServerNode>>(new Map());
  const padsRef = useRef<Map<string, Container>>(new Map());
  const agentRef = useRef<AgentSprite | null>(null);
  const onSelectRef = useRef(onSelect);
  const onDescribeRef = useRef(onDescribe);
  const onAddServerRef = useRef(onAddServer);
  const onRemoveNodeRef = useRef(onRemoveNode);
  const onSelectHostRef = useRef(onSelectHost);
  const onSelectedAnchorChangeRef = useRef(onSelectedAnchorChange);
  const selectedIdRef = useRef(selectedId);
  const lastAnchorRef = useRef<SelectedAnchor | null>(null);
  const [stageReady, setStageReady] = useState(false);
  onSelectRef.current = onSelect;
  onDescribeRef.current = onDescribe;
  onAddServerRef.current = onAddServer;
  onRemoveNodeRef.current = onRemoveNode;
  onSelectHostRef.current = onSelectHost;
  onSelectedAnchorChangeRef.current = onSelectedAnchorChange;
  selectedIdRef.current = selectedId;

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
      world.sortableChildren = true;
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
      const publishAnchor = () => {
        const cb = onSelectedAnchorChangeRef.current;
        if (!cb) return;
        const id = selectedIdRef.current;
        const world = worldRef.current;
        if (!id || !world) {
          if (lastAnchorRef.current !== null) {
            lastAnchorRef.current = null;
            cb(null);
          }
          return;
        }
        const node = nodesRef.current.get(id);
        if (!node) {
          if (lastAnchorRef.current !== null) {
            lastAnchorRef.current = null;
            cb(null);
          }
          return;
        }
        const scale = world.scale.x;
        const next: SelectedAnchor = {
          x: world.x + node.x * scale,
          y: world.y + (node.y - CRATE_TOP_OFFSET) * scale,
        };
        const prev = lastAnchorRef.current;
        if (
          prev &&
          Math.abs(prev.x - next.x) < 0.5 &&
          Math.abs(prev.y - next.y) < 0.5
        ) {
          return;
        }
        lastAnchorRef.current = next;
        cb(next);
      };

      const tickerFn = () => {
        publishAnchor();
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
      lastAnchorRef.current = null;
      onSelectedAnchorChangeRef.current?.(null);
      const app = appRef.current;
      if (app) {
        (app as Application & { __cleanup?: () => void }).__cleanup?.();
        app.destroy(true);
      }
      appRef.current = null;
      worldRef.current = null;
      nodesRef.current.clear();
      padsRef.current.clear();
      agentRef.current = null;
    };
  }, []);

  // Sync host pads + server crates (clustered by node)
  useEffect(() => {
    const world = worldRef.current;
    if (!world || !stageReady) return;

    const clusters = clusterServersByNode(hostNodes, servers);
    const serverById = new Map(servers.map((s) => [s.id, s]));
    const seenPads = new Set<string>();
    const seenCrates = new Set<string>();

    for (const cluster of clusters) {
      seenPads.add(cluster.node.id);
      const presence = padPresenceClass(cluster.node);
      const padW = Math.max(280, 160 + cluster.serverIds.length * 40);
      const padH = Math.max(200, 120 + Math.ceil(Math.max(cluster.serverIds.length, 1) / 2) * 160);

      let pad = padsRef.current.get(cluster.node.id);
      if (!pad) {
        pad = new Container();
        pad.zIndex = 0;
        const g = new Graphics();
        g.label = "pad";
        pad.addChild(g);
        const title = new Text({
          text: "",
          style: { fill: 0xf2e8ee, fontSize: 14, fontFamily: "DM Sans, sans-serif", fontWeight: "600" },
        });
        title.anchor.set(0.5, 0);
        title.y = -28;
        title.label = "title";
        pad.addChild(title);
        const sub = new Text({
          text: "",
          style: { fill: 0xa898a0, fontSize: 11, fontFamily: "DM Sans, sans-serif" },
        });
        sub.anchor.set(0.5, 0);
        sub.y = -10;
        sub.label = "sub";
        pad.addChild(sub);
        pad.eventMode = "static";
        pad.cursor = "pointer";
        const nodeId = cluster.node.id;
        pad.on("pointertap", () => {
          const n = hostNodes.find((x) => x.id === nodeId);
          if (!n) return;
          if (
            n.id !== "local" &&
            (isPendingNodeSetup({ agentVersion: n.agentVersion, status: n.status }) ||
              n.status === "offline")
          ) {
            if (
              window.confirm(
                `Remove incomplete node “${n.name}”? Bootstrap never finished or the agent is offline.`,
              )
            ) {
              onRemoveNodeRef.current?.(n.id);
            }
            return;
          }
          if (n.status === "online" || n.id === "local") {
            onSelectHostRef.current?.(n.id);
          }
        });
        world.addChild(pad);
        padsRef.current.set(cluster.node.id, pad);
      }

      pad.x = cluster.origin.x;
      pad.y = cluster.origin.y;
      const g = pad.getChildByLabel("pad") as Graphics;
      const title = pad.getChildByLabel("title") as Text;
      const sub = pad.getChildByLabel("sub") as Text;
      drawHostPad(g, presence, cluster.node.name, "", padW, padH);
      title.text = cluster.node.name;
      const presenceLabel = nodePresenceLabel({
        status: cluster.node.status,
        agentVersion: cluster.node.agentVersion,
      });
      const bits = [cluster.node.badge || cluster.node.kind || "", presenceLabel];
      if (cluster.node.joinHost) bits.push(cluster.node.joinHost);
      sub.text = bits.filter(Boolean).join(" · ");

      cluster.serverIds.forEach((serverId, index) => {
        const server = serverById.get(serverId);
        if (!server) return;
        seenCrates.add(server.id);
        const offset = crateOffsetInCluster(index);
        const pos = {
          x: cluster.origin.x + offset.x,
          y: cluster.origin.y + offset.y,
        };
        let node = nodesRef.current.get(server.id);
        if (!node) {
          const root = new Container();
          root.zIndex = 2;
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

        node.x = pos.x;
        node.y = pos.y;
        node.root.x = pos.x;
        node.root.y = pos.y;

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
    }

    for (const [id, pad] of padsRef.current) {
      if (!seenPads.has(id)) {
        world.removeChild(pad);
        pad.destroy({ children: true });
        padsRef.current.delete(id);
      }
    }
    for (const [id, node] of nodesRef.current) {
      if (!seenCrates.has(id)) {
        world.removeChild(node.root);
        node.root.destroy({ children: true });
        nodesRef.current.delete(id);
      }
    }
  }, [servers, hostNodes, selectedId, activity, stageReady]);

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
  const mapEmpty = servers.length === 0 && hostNodes.length === 0;

  return (
    <div className="agent-canvas-host">
      <div
        ref={hostRef}
        className="agent-canvas-stage"
        role="img"
        aria-label={
          mapEmpty
            ? "Empty LAN map"
            : `LAN map with ${hostNodes.length} host${hostNodes.length === 1 ? "" : "s"} and ${servers.length} server${servers.length === 1 ? "" : "s"}`
        }
      />
      {serversLoading && mapEmpty ? (
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
      ) : mapEmpty ? (
        <div className="agent-canvas-empty">
          <div className="empty-hint">
            <strong>Your LAN map is empty</strong>
            <p className="muted status-inline">
              Add a host, or tell the agent what to stand up tonight.
            </p>
          </div>
          <div className="btn-row">
            {onAddNode ? (
              <button type="button" className="btn" onClick={() => onAddNode()}>
                Add node
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => onDescribeRef.current()}
            >
              Describe a server
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="agent-canvas-map-hint muted" aria-hidden>
            Drag to pan · Scroll to zoom
            {hostNodes.some((n) => n.id !== "local")
              ? " · Click a pending host pad to remove it · Click an online pad to scan for servers"
              : ""}
          </p>
          {liveBusy ? (
            <p className="agent-canvas-live-chip" role="status">
              {skillShortLabel(liveBusy.skill)} · {liveBusy.label ?? liveBusy.verb}
            </p>
          ) : null}
          <div className="agent-canvas-rail">
            <p className="agent-canvas-rail-label" id="host-list-label">
              Hosts
            </p>
            <ul className="agent-canvas-list" aria-labelledby="host-list-label">
              {hostNodes.map((n) => (
                <li key={n.id}>
                  <div className="agent-canvas-list-item static">
                    <span className="agent-canvas-list-name">{n.name}</span>
                    <span className={`node-status node-${padPresenceClass(n)}`}>
                      {nodePresenceLabel({
                        status: n.status,
                        agentVersion: n.agentVersion,
                      })}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
            {servers.length ? (
              <>
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
              </>
            ) : null}
          </div>
          {showAddButton ? (
            <div className="agent-canvas-add-row">
              {onAddNode ? (
                <button type="button" className="btn agent-canvas-add-node" onClick={() => onAddNode()}>
                  + Add node
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn-primary agent-canvas-add"
                onClick={() => onAddServerRef.current()}
              >
                + Add server
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
