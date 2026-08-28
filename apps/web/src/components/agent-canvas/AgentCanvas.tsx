import { useEffect, useRef, useState } from "react";
import { Application, Container, Graphics, Text } from "pixi.js";
import type { ServerRow } from "../../api";
import { formatHostUsage, formatServerUsage } from "../../format-usage";
import {
  isPendingNodeSetup,
  nodePresenceLabel,
  shortDisplayName,
  displayServerStatus,
} from "../../status";
import {
  boardCrateKind,
  boardCrateStatusText,
  boardCrateTone,
  clusterPadSize,
  clusterServersByNode,
  isPlayerGameCrate,
  OTHER_SERVICES_COLLAPSE_AT,
  otherServicesStackLabel,
  padPresenceClass,
  placeClusterCrates,
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

/** Iso crate apex sits above node center — used for overlay anchors. */
const CRATE_TOP_OFFSET = 56;

type Props = {
  servers: ServerRow[];
  nodes?: MapNodeInput[];
  /** True while the servers query has not settled — avoid false empty CTA. */
  serversLoading?: boolean;
  selectedId?: string;
  /** Host pad / rail selection (Scan panel), independent of server selection. */
  selectedHostId?: string | null;
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
  /** Click empty map space — parent should deselect and close overlays. */
  onBackgroundClick?: () => void;
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

/**
 * Dimetric floor (wider than classic 2:1) — lower camera, more foreshortened ground.
 * Screen Y is further compressed via WORLD_Y_SQUASH on the stage.
 */
const ISO_TILE_W = 54;
const ISO_TILE_H = 18;
/** How many tiles out from origin along each iso axis. */
const ISO_RANGE = 56;
const LERP_SPEED = 8;
/** Extra vertical squash for a lowered 2.5D camera. */
const WORLD_Y_SQUASH = 0.88;
const DEFAULT_ZOOM = 0.62;
const MIN_ZOOM = 0.38;
const MAX_ZOOM = 1.35;

function shade(hex: number, factor: number): number {
  const r = Math.min(255, Math.max(0, Math.round(((hex >> 16) & 0xff) * factor)));
  const g = Math.min(255, Math.max(0, Math.round(((hex >> 8) & 0xff) * factor)));
  const b = Math.min(255, Math.max(0, Math.round((hex & 0xff) * factor)));
  return (r << 16) | (g << 8) | b;
}

function setWorldZoom(world: Container, zoom: number): void {
  const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
  world.scale.set(z, z * WORLD_Y_SQUASH);
}

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
  return { x: 0, y: 120 };
}

const PAD_COLORS: Record<string, { fill: number; stroke: number; accent: number }> = {
  online: { fill: 0x243632, stroke: 0x5ed4c8, accent: 0x3d8f8a },
  stale: { fill: 0x3a3224, stroke: 0xc4a35a, accent: 0x8a7340 },
  offline: { fill: 0x342428, stroke: 0xc45a6a, accent: 0x6a3a48 },
  pending_setup: { fill: 0x2a2634, stroke: 0x8a7fd4, accent: 0x5a5488 },
};

/** Iso diamond corners for a footprint of screen half-width / half-depth. */
function isoFootprint(hw: number, hd: number): Array<{ x: number; y: number }> {
  return [
    { x: 0, y: -hd },
    { x: hw, y: 0 },
    { x: 0, y: hd },
    { x: -hw, y: 0 },
  ];
}

function fillPoly(g: Graphics, pts: Array<{ x: number; y: number }>, color: number, alpha = 1): void {
  if (pts.length < 3) return;
  g.moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i]!.x, pts[i]!.y);
  g.closePath().fill({ color, alpha });
}

function strokePoly(g: Graphics, pts: Array<{ x: number; y: number }>, color: number, width = 1.5, alpha = 1): void {
  if (pts.length < 2) return;
  g.moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i]!.x, pts[i]!.y);
  g.closePath().stroke({ width, color, alpha });
}

function drawHostPad(
  g: Graphics,
  presence: string,
  label: string,
  subtitle: string,
  width: number,
  height: number,
  selected = false,
): void {
  const colors = PAD_COLORS[presence] ?? PAD_COLORS.offline!;
  const hw = Math.max(110, width * 0.42);
  const hd = Math.max(48, height * 0.28);
  const extrude = 18;
  const top = isoFootprint(hw, hd);
  const bottom = top.map((p) => ({ x: p.x, y: p.y + extrude }));
  const stroke = selected ? 0x5ed4c8 : colors.stroke;
  g.clear();
  // Ground shadow
  g.ellipse(4, hd + extrude + 6, hw * 0.92, hd * 0.55).fill({ color: 0x000000, alpha: 0.28 });
  if (selected) {
    g.ellipse(0, hd * 0.2, hw * 1.05, hd * 0.7).fill({ color: 0x5ed4c8, alpha: 0.1 });
  }
  // Side walls (far → near for paint order)
  fillPoly(g, [top[3]!, top[2]!, bottom[2]!, bottom[3]!], shade(colors.fill, 0.55), 0.95);
  fillPoly(g, [top[1]!, top[2]!, bottom[2]!, bottom[1]!], shade(colors.fill, 0.7), 0.95);
  // Top deck
  fillPoly(g, top, colors.fill, 0.94);
  strokePoly(g, top, stroke, selected ? 3 : 2, selected ? 1 : 0.92);
  // Rack block on the far edge of the pad
  const rackHw = Math.min(54, hw * 0.35);
  const rackHd = 12;
  const rackLift = 22;
  const rackBase = [
    { x: 0, y: -hd + 10 },
    { x: rackHw, y: -hd + 10 + rackHd },
    { x: 0, y: -hd + 10 + rackHd * 2 },
    { x: -rackHw, y: -hd + 10 + rackHd },
  ];
  const rackTop = rackBase.map((p) => ({ x: p.x, y: p.y - rackLift }));
  fillPoly(g, [rackBase[3]!, rackBase[2]!, rackTop[2]!, rackTop[3]!], shade(colors.accent, 0.55));
  fillPoly(g, [rackBase[1]!, rackBase[2]!, rackTop[2]!, rackTop[1]!], shade(colors.accent, 0.75));
  fillPoly(g, rackTop, colors.accent, 0.9);
  strokePoly(g, rackTop, colors.stroke, 1.25, 0.55);
  // Status LED near near-corner
  g.circle(0, hd - 10, 3.5).fill({
    color: colors.stroke,
    alpha: presence === "online" ? 0.95 : 0.4,
  });
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
  const fillRange = 22;
  for (let i = -fillRange; i < fillRange; i++) {
    for (let j = -fillRange; j < fillRange; j++) {
      const tl = isoPoint(i, j);
      const tr = isoPoint(i + 1, j);
      const br = isoPoint(i + 1, j + 1);
      const bl = isoPoint(i, j + 1);
      const checker = (i + j) & 1;
      const dist = Math.sqrt(i * i + j * j);
      const fade = Math.max(0, 1 - dist / (fillRange * 0.95));
      if (fade <= 0.04) continue;
      const base = checker ? 0x1a1418 : 0x141018;
      g.moveTo(tl.x, tl.y)
        .lineTo(tr.x, tr.y)
        .lineTo(br.x, br.y)
        .lineTo(bl.x, bl.y)
        .closePath()
        .fill({ color: base, alpha: 0.42 * fade });
      if ((i * 17 + j * 31) % 9 === 0) {
        g.moveTo(tl.x, tl.y)
          .lineTo(tr.x, tr.y)
          .lineTo(br.x, br.y)
          .lineTo(bl.x, bl.y)
          .closePath()
          .fill({ color: 0x2a1c24, alpha: 0.14 * fade });
      }
    }
  }
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
  g.stroke({ width: 1, color: 0xf2e8ee, alpha: 0.04 });
  g.ellipse(0, 36, 520, 160).fill({ color: 0x9e3a5c, alpha: 0.055 });
  g.ellipse(90, -10, 300, 110).fill({ color: 0x3a8a84, alpha: 0.035 });
}

type CrateTone = "live" | "idle" | "inventory" | "lab";
type CrateSize = "hero" | "player" | "other";

const CRATE_TONES: Record<CrateTone, { fill: number; top: number; stroke: number }> = {
  live: { fill: 0x2f6f6c, top: 0x3d8f8a, stroke: 0x6ab8b0 },
  idle: { fill: 0x3a4048, top: 0x4a5058, stroke: 0x6a7080 },
  inventory: { fill: 0x3a3840, top: 0x4a4650, stroke: 0x6a6670 },
  lab: { fill: 0x3a3540, top: 0x4a4050, stroke: 0x7a6880 },
};

function crateMetrics(size: CrateSize): { hw: number; hd: number; extrude: number } {
  if (size === "hero") return { hw: 44, hd: 24, extrude: 54 };
  if (size === "other") return { hw: 22, hd: 12, extrude: 26 };
  return { hw: 36, hd: 20, extrude: 44 };
}

function drawCrate(
  g: Graphics,
  opts: { selected: boolean; tone: CrateTone; size: CrateSize },
) {
  g.clear();
  const { hw, hd, extrude } = crateMetrics(opts.size);
  const colors = CRATE_TONES[opts.tone];
  const fill = colors.fill;
  const topFill = colors.top;
  const stroke = opts.selected ? 0x5ed4c8 : colors.stroke;
  const top = isoFootprint(hw, hd).map((p) => ({ x: p.x, y: p.y - extrude * 0.35 }));
  const bottom = top.map((p) => ({ x: p.x, y: p.y + extrude }));
  g.ellipse(6, bottom[2]!.y + 4, hw * 0.95, hd * 0.55).fill({
    color: 0x000000,
    alpha: opts.size === "other" ? 0.2 : 0.3,
  });
  fillPoly(g, [top[3]!, top[2]!, bottom[2]!, bottom[3]!], shade(fill, 0.55));
  fillPoly(g, [top[1]!, top[2]!, bottom[2]!, bottom[1]!], shade(fill, 0.72));
  fillPoly(g, top, topFill, 0.96);
  strokePoly(g, top, stroke, opts.selected ? 2.5 : 1.5, opts.selected ? 1 : 0.9);
  const midY = (top[2]!.y + bottom[2]!.y) / 2;
  g.moveTo(top[3]!.x, midY - 3)
    .lineTo(top[2]!.x, midY + hd * 0.15)
    .lineTo(top[1]!.x, midY - 3)
    .stroke({ width: opts.size === "other" ? 3 : 5, color: 0x2a1f28, alpha: 0.45 });
  if (opts.tone === "live") {
    g.circle(top[1]!.x - 8, top[1]!.y + 6, opts.size === "hero" ? 4 : 3.5).fill({
      color: 0x5ed4c8,
      alpha: 0.95,
    });
  }
  if (opts.selected) {
    const halo = isoFootprint(hw + 10, hd + 6).map((p) => ({
      x: p.x,
      y: p.y - extrude * 0.35 - 4,
    }));
    strokePoly(g, halo, 0x5ed4c8, 1.5, 0.4);
  }
}

function drawStackCrate(g: Graphics, selected: boolean) {
  g.clear();
  const offsets = [
    { x: -14, y: 8, alpha: 0.45 },
    { x: 12, y: -4, alpha: 0.6 },
    { x: 0, y: 0, alpha: 0.95 },
  ];
  for (const off of offsets) {
    const { hw, hd, extrude } = crateMetrics("other");
    const fill = 0x3a3840;
    const topFill = 0x4a4650;
    const stroke = selected ? 0x5ed4c8 : 0x6a6670;
    const top = isoFootprint(hw, hd).map((p) => ({
      x: p.x + off.x,
      y: p.y - extrude * 0.35 + off.y,
    }));
    const bottom = top.map((p) => ({ x: p.x, y: p.y + extrude }));
    g.ellipse(off.x + 4, bottom[2]!.y + 3, hw * 0.9, hd * 0.5).fill({
      color: 0x000000,
      alpha: 0.16 * off.alpha,
    });
    fillPoly(g, [top[3]!, top[2]!, bottom[2]!, bottom[3]!], shade(fill, 0.55), off.alpha);
    fillPoly(g, [top[1]!, top[2]!, bottom[2]!, bottom[1]!], shade(fill, 0.72), off.alpha);
    fillPoly(g, top, topFill, 0.92 * off.alpha);
    strokePoly(g, top, stroke, selected ? 2 : 1.25, 0.85 * off.alpha);
  }
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
  const hw = 14;
  const hd = 9;
  const extrude = 26;
  const top = isoFootprint(hw, hd).map((p) => ({ x: p.x, y: p.y - 18 }));
  const bottom = top.map((p) => ({ x: p.x, y: p.y + extrude }));
  g.ellipse(3, bottom[2]!.y + 2, 16, 7).fill({ color: 0x000000, alpha: 0.3 });
  fillPoly(g, [top[3]!, top[2]!, bottom[2]!, bottom[3]!], shade(color, 0.55), opts.busy ? 1 : 0.85);
  fillPoly(g, [top[1]!, top[2]!, bottom[2]!, bottom[1]!], shade(color, 0.75), opts.busy ? 1 : 0.88);
  fillPoly(g, top, color, opts.busy ? 1 : 0.9);
  // Head disc sitting on the top face
  g.circle(0, top[0]!.y - 2, 11).fill({ color, alpha: opts.busy ? 1 : 0.92 });
  g.circle(0, top[0]!.y - 2, 11).stroke({ width: 1.25, color: shade(color, 0.65), alpha: 0.8 });
  if (opts.busy) {
    g.circle(0, top[0]!.y - 2, 16).stroke({ width: 2.25, color: phaseRingColor(opts.phase), alpha: 0.95 });
    g.circle(0, top[0]!.y - 2, 20).stroke({ width: 1, color: phaseRingColor(opts.phase), alpha: 0.28 });
  }
  g.roundRect(-8, top[0]!.y - 6, 16, 6, 3).fill({ color: 0x111111, alpha: 0.55 });
  g.circle(-3.5, top[0]!.y - 3, 1.8).fill({ color: 0xf2e8ee, alpha: 0.92 });
  g.circle(3.5, top[0]!.y - 3, 1.8).fill({ color: 0xf2e8ee, alpha: 0.92 });
  if (opts.busy && opts.skill) {
    g.circle(0, top[0]!.y - 16, 3).fill({ color: phaseRingColor(opts.phase), alpha: 0.95 });
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
  selectedHostId = null,
  activity,
  skills: _skills,
  onSelect,
  onDescribe,
  onAddServer,
  onAddNode,
  onRemoveNode,
  onSelectHost,
  onBackgroundClick,
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
  const onBackgroundClickRef = useRef(onBackgroundClick);
  const onSelectedAnchorChangeRef = useRef(onSelectedAnchorChange);
  const selectedIdRef = useRef(selectedId);
  const lastAnchorRef = useRef<SelectedAnchor | null>(null);
  const [stageReady, setStageReady] = useState(false);
  const [pendingRemoveNodeId, setPendingRemoveNodeId] = useState<string | null>(null);
  const [expandedOtherNodes, setExpandedOtherNodes] = useState<Record<string, boolean>>({});
  const [railOthersOpen, setRailOthersOpen] = useState(false);
  onSelectRef.current = onSelect;
  onDescribeRef.current = onDescribe;
  onAddServerRef.current = onAddServer;
  onRemoveNodeRef.current = onRemoveNode;
  onSelectHostRef.current = onSelectHost;
  onBackgroundClickRef.current = onBackgroundClick;
  onSelectedAnchorChangeRef.current = onSelectedAnchorChange;
  selectedIdRef.current = selectedId;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let destroyed = false;
    const app = new Application();

    void (async () => {
      await app.init({
        background: 0x141016,
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
      world.y = host.clientHeight * 0.42;
      setWorldZoom(world, DEFAULT_ZOOM);
      worldRef.current = world;
      app.stage.addChild(world);

      const floor = new Graphics();
      drawFloorGrid(floor);
      floor.eventMode = "static";
      floor.cursor = "grab";
      // Large hit target so empty space between tiles still clears selection.
      floor.hitArea = {
        contains: (x: number, y: number) => Math.abs(x) < 8000 && Math.abs(y) < 8000,
      };
      let dragging = false;
      let dragMoved = false;
      let lastX = 0;
      let lastY = 0;
      let userPanned = false;

      floor.on("pointertap", () => {
        // Pan-drag should not clear selection / close overlays.
        if (dragMoved) return;
        onBackgroundClickRef.current?.();
      });
      world.addChild(floor);
      setStageReady(true);

      app.canvas.style.cursor = "grab";

      const onPointerDown = (e: PointerEvent) => {
        if (e.button !== 0) return;
        dragging = true;
        dragMoved = false;
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
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        if (!dragMoved && dx * dx + dy * dy > 36) dragMoved = true;
        if (!dragMoved) return;
        world.x += dx;
        world.y += dy;
        lastX = e.clientX;
        lastY = e.clientY;
        userPanned = true;
      };
      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        setWorldZoom(world, world.scale.x * (e.deltaY > 0 ? 0.92 : 1.08));
      };
      const onResize = () => {
        if (userPanned) return;
        world.x = host.clientWidth / 2;
        world.y = host.clientHeight * 0.42;
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
        const next: SelectedAnchor = {
          x: world.x + node.x * world.scale.x,
          y: world.y + (node.y - CRATE_TOP_OFFSET) * world.scale.y,
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
    const selectedServer = selectedId ? serverById.get(selectedId) : undefined;
    const seenPads = new Set<string>();
    const seenCrates = new Set<string>();

    for (const cluster of clusters) {
      seenPads.add(cluster.node.id);
      const presence = padPresenceClass(cluster.node);
      const clusterServers = cluster.serverIds
        .map((id) => serverById.get(id))
        .filter((s): s is ServerRow => Boolean(s));
      const othersExpanded =
        Boolean(expandedOtherNodes[cluster.node.id]) ||
        Boolean(
          selectedServer &&
            (selectedServer.nodeId ?? "") === cluster.node.id &&
            !isPlayerGameCrate(selectedServer),
        );
      const placements = placeClusterCrates(clusterServers, { othersExpanded });
      const { w: padW, h: padH } = clusterPadSize(placements);

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
        title.anchor.set(0.5, 1);
        title.y = -58;
        title.label = "title";
        pad.addChild(title);
        const sub = new Text({
          text: "",
          style: { fill: 0xc4b4bc, fontSize: 11, fontFamily: "DM Sans, sans-serif" },
        });
        sub.anchor.set(0.5, 1);
        sub.y = -42;
        sub.label = "sub";
        pad.addChild(sub);
        pad.eventMode = "static";
        pad.cursor = "pointer";
        const nodeId = cluster.node.id;
        pad.on("pointertap", (e) => {
          e.stopPropagation();
          const n = hostNodes.find((x) => x.id === nodeId);
          if (!n) return;
          if (
            n.id !== "local" &&
            (isPendingNodeSetup({ agentVersion: n.agentVersion, status: n.status }) ||
              n.status === "offline")
          ) {
            setPendingRemoveNodeId(n.id);
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
      const hostSelected = cluster.node.id === selectedHostId;
      drawHostPad(g, presence, cluster.node.name, "", padW, padH, hostSelected);
      title.text = cluster.node.name;
      title.style.fill = hostSelected ? 0x5ed4c8 : 0xf2e8ee;
      const padHd = Math.max(48, padH * 0.28);
      title.y = -padHd - 10;
      const presenceLabel = nodePresenceLabel({
        status: cluster.node.status,
        agentVersion: cluster.node.agentVersion,
      });
      const bits = [cluster.node.badge || cluster.node.kind || "", presenceLabel];
      if (cluster.node.joinHost) bits.push(cluster.node.joinHost);
      const hostUsage = formatHostUsage(cluster.node);
      if (hostUsage) bits.push(hostUsage);
      sub.text = bits.filter(Boolean).join(" · ");
      sub.y = title.y + 16;

      for (const placement of placements) {
        seenCrates.add(placement.serverId);
        const pos = {
          x: cluster.origin.x + placement.offset.x,
          y: cluster.origin.y + placement.offset.y,
        };
        const isStack = placement.role === "stack";
        const server = isStack ? undefined : serverById.get(placement.serverId);
        if (!isStack && !server) continue;

        let node = nodesRef.current.get(placement.serverId);
        if (!node) {
          const root = new Container();
          root.zIndex = 2;
          const clickable = isStack || Boolean(server && !server.unmanaged);
          root.eventMode = clickable ? "static" : "none";
          root.cursor = clickable ? "pointer" : "default";

          const crate = new Graphics();
          crate.label = "crate";
          root.addChild(crate);

          const label = new Text({
            text: "",
            style: {
              fill: 0xf2e8ee,
              fontSize: 12,
              fontFamily: "DM Sans, sans-serif",
              wordWrap: true,
              wordWrapWidth: 128,
              align: "center",
            },
          });
          label.anchor.set(0.5, 0);
          label.y = 36;
          label.label = "name";
          root.addChild(label);

          const status = new Text({
            text: "",
            style: { fill: 0xa898a0, fontSize: 11, fontFamily: "DM Sans, sans-serif", align: "center" },
          });
          status.anchor.set(0.5, 0);
          status.y = 52;
          status.label = "status";
          root.addChild(status);

          if (isStack) {
            const nodeId = cluster.node.id;
            root.on("pointertap", (e) => {
              e.stopPropagation();
              setExpandedOtherNodes((prev) => ({ ...prev, [nodeId]: true }));
              setRailOthersOpen(true);
            });
          } else if (server && !server.unmanaged) {
            const sid = server.id;
            root.on("pointertap", (e) => {
              e.stopPropagation();
              onSelectRef.current(sid);
            });
          }

          world.addChild(root);
          node = { id: placement.serverId, x: pos.x, y: pos.y, root };
          nodesRef.current.set(placement.serverId, node);
        }

        node.x = pos.x;
        node.y = pos.y;
        node.root.x = pos.x;
        node.root.y = pos.y;

        const crate = node.root.getChildByLabel("crate") as Graphics;
        const name = node.root.getChildByLabel("name") as Text;
        const status = node.root.getChildByLabel("status") as Text;
        const selected = !isStack && server?.id === selectedId;
        const size =
          placement.role === "hero" ? "hero" : placement.role === "other" ? "other" : "player";
        const wrapWidth = size === "hero" ? 156 : size === "other" ? 86 : 128;
        const fontSize = size === "hero" ? 13 : size === "other" ? 10 : 12;
        name.style.fontSize = fontSize;
        name.style.fontWeight = placement.role === "hero" ? "600" : "400";
        name.style.wordWrap = true;
        name.style.wordWrapWidth = wrapWidth;
        name.style.align = "center";
        name.style.fill = placement.role === "hero" ? 0xf2e8ee : 0xd8c8d0;
        status.style.fontSize = size === "other" || isStack ? 9 : 11;
        name.y = size === "hero" ? 42 : size === "other" || isStack ? 22 : 36;

        if (isStack) {
          drawStackCrate(crate, false);
          name.text = otherServicesStackLabel(placement.stackCount ?? 0);
          status.text = "Tap to show";
        } else if (server) {
          const kind = boardCrateKind(server);
          const shown = displayServerStatus(server.status, server.ready);
          const busyHere =
            activity && activity.serverId === server.id && activity.phase !== "idle"
              ? activity
              : undefined;
          drawCrate(crate, {
            selected: Boolean(selected),
            tone: boardCrateTone(kind, shown),
            size,
          });
          const nameMax = size === "hero" ? 32 : size === "other" ? 16 : 24;
          name.text = shortDisplayName(server.name, nameMax);
          const baseStatus = boardCrateStatusText(server);
          const usage = formatServerUsage(server);
          const labeled = usage ? `${baseStatus} · ${usage}` : baseStatus;
          status.text =
            busyHere && kind === "player"
              ? `${labeled} · ${busyHere.label || busyHere.verb}`
              : labeled;
        }
        status.y = name.y + Math.max(name.height, fontSize + 2) + 2;
      }
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
  }, [servers, hostNodes, selectedId, selectedHostId, activity, stageReady, expandedOtherNodes]);

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
  const playerServers = servers.filter(isPlayerGameCrate);
  const otherServers = servers.filter((s) => !isPlayerGameCrate(s));
  const othersCollapsed =
    otherServers.length >= OTHER_SERVICES_COLLAPSE_AT && !railOthersOpen;
  const railServers = othersCollapsed
    ? playerServers
    : [...playerServers, ...otherServers];

  return (
    <div className="agent-canvas-host">
      <div
        ref={hostRef}
        className="agent-canvas-stage"
        role="img"
        aria-label={
          mapEmpty
            ? "Decorative empty LAN map. Use Add node or Describe a server."
            : `Decorative LAN map with ${hostNodes.length} host${hostNodes.length === 1 ? "" : "s"} and ${servers.length} server${servers.length === 1 ? "" : "s"}. Use the Hosts and Servers lists to select.`
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
          <p className="agent-canvas-map-hint muted" id="map-gesture-hint">
            <span className="hint-full">
              Drag to pan · Scroll to zoom · Esc clear · A add · N node · S start · X stop ·
              Hosts/pad: scan · Games: chat · Other services: tap stack
              {hostNodes.some((n) => n.id !== "local")
                ? " · Pending pad: remove setup"
                : ""}
            </span>
            <span className="hint-short">Esc clear · tap host or server</span>
          </p>
          {liveBusy ? (
            <p className="agent-canvas-live-chip" role="status">
              {skillShortLabel(liveBusy.skill)} · {liveBusy.label ?? liveBusy.verb}
            </p>
          ) : null}
          <div className="agent-canvas-rail">
            <p className="sr-only" role="status" aria-live="polite">
              {selectedHostId
                ? `Host selected: ${hostNodes.find((h) => h.id === selectedHostId)?.name ?? selectedHostId}. Scan for installs open.`
                : selectedId
                  ? `Server selected: ${servers.find((s) => s.id === selectedId)?.name ?? selectedId}.`
                  : "Nothing selected on the map."}
            </p>
            <p className="agent-canvas-rail-label" id="host-list-label">
              Hosts
            </p>
            <ul className="agent-canvas-list" aria-labelledby="host-list-label">
              {hostNodes.map((n) => {
                const selected = n.id === selectedHostId;
                const canSelect =
                  n.id === "local" ||
                  n.status === "online" ||
                  isPendingNodeSetup({ agentVersion: n.agentVersion, status: n.status }) ||
                  n.status === "offline";
                return (
                  <li key={n.id}>
                    <button
                      type="button"
                      aria-pressed={selected}
                      aria-describedby="map-gesture-hint"
                      className={
                        selected
                          ? "agent-canvas-list-item selected"
                          : "agent-canvas-list-item"
                      }
                      disabled={!canSelect || !onSelectHost}
                      onClick={() => {
                        if (
                          n.id !== "local" &&
                          (isPendingNodeSetup({
                            agentVersion: n.agentVersion,
                            status: n.status,
                          }) ||
                            n.status === "offline")
                        ) {
                          setPendingRemoveNodeId(n.id);
                          return;
                        }
                        if (n.status === "online" || n.id === "local") {
                          onSelectHostRef.current?.(n.id);
                        }
                      }}
                    >
                      <span className="agent-canvas-list-name" title={n.name}>
                        {shortDisplayName(n.name)}
                      </span>
                      <span className={`node-status node-${padPresenceClass(n)}`}>
                        {nodePresenceLabel({
                          status: n.status,
                          agentVersion: n.agentVersion,
                        })}
                        {formatHostUsage(n) ? ` · ${formatHostUsage(n)}` : ""}
                        {n.id === "local" || n.status === "online"
                          ? " · Scan for installs"
                          : ""}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {playerServers.length || otherServers.length ? (
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
                    if (!railServers.length) return;
                    const idx = Math.max(
                      0,
                      railServers.findIndex((s) => s.id === selectedId),
                    );
                    if (e.key === "ArrowDown" || e.key === "ArrowRight") {
                      e.preventDefault();
                      const next = railServers[(idx + 1) % railServers.length]!;
                      if (!next.unmanaged) onSelectRef.current(next.id);
                    } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
                      e.preventDefault();
                      const prev =
                        railServers[(idx - 1 + railServers.length) % railServers.length]!;
                      if (!prev.unmanaged) onSelectRef.current(prev.id);
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      onSelectRef.current(undefined);
                    }
                  }}
                >
                  {railServers.map((server) => {
                    const selected = server.id === selectedId;
                    const busyLabel = serverBusyLabel(server.id);
                    const secondary = !isPlayerGameCrate(server);
                    return (
                      <li key={server.id} role="option" aria-selected={selected}>
                        <button
                          type="button"
                          disabled={Boolean(server.unmanaged)}
                          className={[
                            "agent-canvas-list-item",
                            selected ? "selected" : "",
                            secondary ? "secondary" : "",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          onClick={() => {
                            if (server.unmanaged) return;
                            onSelectRef.current(server.id);
                          }}
                        >
                          <span className="agent-canvas-list-name" title={server.name}>
                            {server.name}
                          </span>
                          <span className="muted">
                            {busyLabel ||
                              [boardCrateStatusText(server), formatServerUsage(server)]
                                .filter(Boolean)
                                .join(" · ")}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {otherServers.length >= OTHER_SERVICES_COLLAPSE_AT ? (
                  <button
                    type="button"
                    className="agent-canvas-others-toggle"
                    aria-expanded={!othersCollapsed}
                    onClick={() => {
                      const next = othersCollapsed;
                      setRailOthersOpen(next);
                      if (next) {
                        const nodeIds = new Set(
                          otherServers.map((s) => s.nodeId).filter((id): id is string => Boolean(id)),
                        );
                        setExpandedOtherNodes((prev) => {
                          const copy = { ...prev };
                          for (const id of nodeIds) copy[id] = true;
                          return copy;
                        });
                      } else {
                        setExpandedOtherNodes({});
                      }
                    }}
                  >
                    {othersCollapsed
                      ? `Show ${otherServicesStackLabel(otherServers.length)}`
                      : `Hide ${otherServicesStackLabel(otherServers.length)}`}
                  </button>
                ) : null}
              </>
            ) : null}
          </div>
          {showAddButton ? (
            <div className="agent-canvas-add-row">
              {onAddNode ? (
                <button
                  type="button"
                  className="btn btn-ghost agent-canvas-add-node"
                  onClick={() => onAddNode()}
                >
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
          {pendingRemoveNodeId ? (
            <div className="map-inline-confirm" role="alertdialog" aria-labelledby="map-remove-node-title">
              <p id="map-remove-node-title">
                Remove incomplete node “
                {hostNodes.find((h) => h.id === pendingRemoveNodeId)?.name ?? pendingRemoveNodeId}”?
              </p>
              <p className="muted small">Bootstrap never finished or the agent is offline.</p>
              <div className="btn-row">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setPendingRemoveNodeId(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => {
                    onRemoveNodeRef.current?.(pendingRemoveNodeId);
                    setPendingRemoveNodeId(null);
                  }}
                >
                  Remove
                </button>
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
