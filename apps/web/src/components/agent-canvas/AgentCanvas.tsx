import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  COMPOSE_CHANNEL_KEY,
  hostMeterRows,
  type ServerAgentPresence,
} from "@playon/shared";
import type { ServerRow } from "../../api";
import { gameBadgeText, gameHue } from "../../game-badge";
import { HostUsageMeters, ServerUsageMeters } from "../UsageMeters";
import {
  isPendingNodeSetup,
  nodePresenceLabel,
  shortDisplayName,
  displayServerStatus,
} from "../../status";
import {
  boardCrateKind,
  boardCrateStatusText,
  clusterServersByNode,
  isPlayerGameCrate,
  OTHER_SERVICES_COLLAPSE_AT,
  otherServicesStackLabel,
  padPresenceClass,
  placeClusterCrates,
  type MapNodeInput,
  type NodeCluster,
} from "./map-node-layout";
import {
  stationSeats,
  switchSpot,
  type Box,
  type Point,
  type ServerPlayers,
} from "./lan-room-layout";

export type AgentActivityView = {
  serverId?: string;
  skill: string;
  phase: string;
  verb: string;
  label?: string;
  thinking?: string;
};

export type AgentSkillView = {
  skill: string;
  level: number;
  title: string;
};

/** Host-local CSS pixels for the top-center of the selected station. */
export type SelectedAnchor = { x: number; y: number };

export type { MapNodeInput, ServerPlayers };

type Props = {
  servers: ServerRow[];
  nodes?: MapNodeInput[];
  /** True while the servers query has not settled — avoid false empty CTA. */
  serversLoading?: boolean;
  selectedId?: string;
  /** Host table / rail selection (Scan panel), independent of server selection. */
  selectedHostId?: string | null;
  /** One agent per managed server (plus compose while in flight). */
  agents?: ServerAgentPresence[];
  /** Who is on each game, from live server_status panel blocks. */
  players?: Record<string, ServerPlayers>;
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
  /** Open Scan / manage panel for an online host table (incl. local). */
  onSelectHost?: (nodeId: string) => void;
  /** Click empty floor — parent should deselect and close overlays. */
  onBackgroundClick?: () => void;
  /** Screen-space anchor for overlays above the selected station. */
  onSelectedAnchorChange?: (anchor: SelectedAnchor | null) => void;
  /** Hide floating add when the chat dock already covers that corner. */
  showAddButton?: boolean;
};

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

/** Diameter of the LAN switch in CSS px; keep in step with `.lan-switch` in styles.css. */
const SWITCH_SIZE = 56;

type Cable = { id: string; to: Point; tone: string };

/** Offline and half-set-up hosts can only be removed from the map (never Local). */
function hostNeedsRemoval(node: MapNodeInput): boolean {
  return (
    node.id !== "local" &&
    (isPendingNodeSetup({
      agentVersion: node.agentVersion,
      status: node.status,
    }) ||
      node.status === "offline")
  );
}

function stationTone(server: ServerRow): "live" | "idle" | "failed" | "busy" {
  const shown = displayServerStatus(server.status, server.ready);
  if (shown === "error" || shown === "failed") return "failed";
  if (shown === "running") return "live";
  if (shown === "starting" || shown === "stopping" || shown === "degraded")
    return "busy";
  return "idle";
}

/**
 * Top-down LAN party: each host is a table cabled to the switch, each game a station
 * with its players seated around it. Plain DOM, so it scrolls and stays accessible.
 */
export function AgentCanvas({
  servers,
  nodes: hostNodes = [],
  serversLoading = false,
  selectedId,
  selectedHostId = null,
  agents = [],
  players = {},
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
  const floorRef = useRef<HTMLDivElement>(null);
  const roomRef = useRef<HTMLDivElement>(null);
  const tableRefs = useRef<Map<string, HTMLElement>>(new Map());
  const stationRefs = useRef<Map<string, HTMLElement>>(new Map());
  const onSelectRef = useRef(onSelect);
  const onDescribeRef = useRef(onDescribe);
  const onAddServerRef = useRef(onAddServer);
  const onRemoveNodeRef = useRef(onRemoveNode);
  const onSelectHostRef = useRef(onSelectHost);
  const onSelectedAnchorChangeRef = useRef(onSelectedAnchorChange);
  const lastAnchorRef = useRef<SelectedAnchor | null>(null);
  const [pendingRemoveNodeId, setPendingRemoveNodeId] = useState<string | null>(
    null,
  );
  const [expandedOtherNodes, setExpandedOtherNodes] = useState<
    Record<string, boolean>
  >({});
  const [railOthersOpen, setRailOthersOpen] = useState(false);
  const [wiring, setWiring] = useState<{
    hub: Point | null;
    below: boolean;
    cables: Cable[];
  }>({
    hub: null,
    below: false,
    cables: [],
  });
  onSelectRef.current = onSelect;
  onDescribeRef.current = onDescribe;
  onAddServerRef.current = onAddServer;
  onRemoveNodeRef.current = onRemoveNode;
  onSelectHostRef.current = onSelectHost;
  onSelectedAnchorChangeRef.current = onSelectedAnchorChange;

  const clusters: NodeCluster[] = clusterServersByNode(hostNodes, servers);
  const serverById = new Map(servers.map((s) => [s.id, s]));
  const selectedServer = selectedId ? serverById.get(selectedId) : undefined;

  const selectHost = (node: MapNodeInput) => {
    if (hostNeedsRemoval(node)) {
      setPendingRemoveNodeId(node.id);
      return;
    }
    if (node.status === "online" || node.id === "local")
      onSelectHostRef.current?.(node.id);
  };

  /** Measure tables, place the switch between them and run a cable to each. */
  const measure = useCallback(() => {
    const room = roomRef.current;
    const host = hostRef.current;
    if (!room) return;
    const origin = room.getBoundingClientRect();
    const boxes: Array<{ id: string; box: Box; tone: string }> = [];
    for (const [id, el] of tableRefs.current) {
      const r = el.getBoundingClientRect();
      boxes.push({
        id,
        box: {
          x: r.left - origin.left,
          y: r.top - origin.top,
          w: r.width,
          h: r.height,
        },
        tone: el.dataset.presence ?? "online",
      });
    }
    const hub = switchSpot(
      boxes.map((b) => b.box),
      SWITCH_SIZE,
    );
    const below = Boolean(
      hub && boxes.every(({ box }) => hub.y > box.y + box.h),
    );
    const cables = hub
      ? boxes.map(({ id, box, tone }) => ({
          id,
          tone,
          to: { x: box.x + box.w / 2, y: box.y + box.h / 2 },
        }))
      : [];
    setWiring((prev) => {
      const same =
        prev.hub?.x === hub?.x &&
        prev.hub?.y === hub?.y &&
        prev.below === below &&
        prev.cables.length === cables.length &&
        prev.cables.every(
          (c, i) =>
            c.id === cables[i]!.id &&
            c.tone === cables[i]!.tone &&
            c.to.x === cables[i]!.to.x &&
            c.to.y === cables[i]!.to.y,
        );
      return same ? prev : { hub, below, cables };
    });

    const cb = onSelectedAnchorChangeRef.current;
    if (!cb) return;
    const station = selectedId
      ? stationRefs.current.get(selectedId)
      : undefined;
    let next: SelectedAnchor | null = null;
    if (station && host) {
      const hr = host.getBoundingClientRect();
      const sr = station.getBoundingClientRect();
      next = { x: sr.left - hr.left + sr.width / 2, y: sr.top - hr.top };
    }
    const prev = lastAnchorRef.current;
    if (
      (prev === null && next === null) ||
      (prev &&
        next &&
        Math.abs(prev.x - next.x) < 0.5 &&
        Math.abs(prev.y - next.y) < 0.5)
    ) {
      return;
    }
    lastAnchorRef.current = next;
    cb(next);
  }, [selectedId]);

  useLayoutEffect(() => {
    measure();
  });

  useLayoutEffect(() => {
    const floor = floorRef.current;
    if (!floor) return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(floor);
    if (roomRef.current) observer.observe(roomRef.current);
    for (const el of tableRefs.current.values()) observer.observe(el);
    floor.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      floor.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, [measure, clusters.length]);

  useLayoutEffect(
    () => () => {
      lastAnchorRef.current = null;
      onSelectedAnchorChangeRef.current?.(null);
    },
    [],
  );

  const agentByServerId = new Map(
    agents.filter((row) => row.serverId).map((row) => [row.serverId, row]),
  );
  const serverBusyLabel = (serverId: string): string | undefined => {
    const presence = agentByServerId.get(serverId);
    if (presence && presence.mood !== "idle") return presence.nowLine;
    return undefined;
  };
  const composeAgent = agents.find(
    (a) => a.key === COMPOSE_CHANNEL_KEY && a.mood !== "idle",
  );
  const mapEmpty = servers.length === 0 && hostNodes.length === 0;
  const playerServers = servers.filter(isPlayerGameCrate);
  const otherServers = servers.filter((s) => !isPlayerGameCrate(s));
  const othersCollapsed =
    otherServers.length >= OTHER_SERVICES_COLLAPSE_AT && !railOthersOpen;
  const railServers = othersCollapsed
    ? playerServers
    : [...playerServers, ...otherServers];

  const renderStation = (server: ServerRow) => {
    const tone = stationTone(server);
    const selected = server.id === selectedId;
    const occupant = agentByServerId.get(server.id);
    const busyLine = serverBusyLabel(server.id);
    const seated = players[server.id];
    const seats = tone === "live" ? stationSeats(seated) : [];
    const countText =
      tone === "live" && seated
        ? ` · ${seated.count}${seated.max !== undefined ? `/${seated.max}` : ""}`
        : "";
    return (
      <li key={server.id}>
        <button
          type="button"
          ref={(el) => {
            if (el) stationRefs.current.set(server.id, el);
            else stationRefs.current.delete(server.id);
          }}
          className={[
            "lan-station",
            `is-${tone}`,
            selected ? "is-selected" : "",
            occupant && occupant.mood !== "idle" ? "has-agent" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          style={{ "--game-h": gameHue(server.game) } as CSSProperties}
          aria-pressed={selected}
          onClick={(e) => {
            e.stopPropagation();
            onSelectRef.current(server.id);
          }}
        >
          <span className="lan-station-disc" aria-hidden>
            {gameBadgeText(server.game)}
            {seats.map((seat, i) => (
              <span
                key={seat.key}
                className={seat.overflow ? "lan-seat is-more" : "lan-seat"}
                style={
                  {
                    "--seat-a": `${(i / seats.length) * 360}deg`,
                  } as CSSProperties
                }
                title={seat.title}
              >
                {seat.label}
              </span>
            ))}
            {occupant && occupant.mood !== "idle" ? (
              <span className="lan-station-agent" />
            ) : null}
          </span>
          <span className="lan-station-name" title={server.name}>
            {shortDisplayName(server.name, 28)}
          </span>
          <span
            className={
              busyLine ? "lan-station-status is-busy" : "lan-station-status"
            }
          >
            {busyLine || `${boardCrateStatusText(server)}${countText}`}
          </span>
        </button>
      </li>
    );
  };

  const renderTable = (cluster: NodeCluster) => {
    const node = cluster.node;
    const presence = padPresenceClass(node);
    const asleep = presence !== "online" && node.id !== "local";
    const clusterServers = cluster.serverIds
      .map((id) => serverById.get(id))
      .filter((s): s is ServerRow => Boolean(s));
    const othersExpanded =
      Boolean(expandedOtherNodes[node.id]) ||
      Boolean(
        selectedServer &&
        (selectedServer.nodeId ?? "") === node.id &&
        !isPlayerGameCrate(selectedServer),
      );
    const placements = placeClusterCrates(clusterServers, { othersExpanded });
    const games = placements.filter(
      (p) => p.role === "hero" || p.role === "player",
    );
    const extras = placements.filter(
      (p) => p.role === "other" || p.role === "stack",
    );
    const meters = hostMeterRows(node, node.usageHistory ?? []).filter(
      (r) => r.key !== "disk",
    );
    const hostSelected = node.id === selectedHostId;
    return (
      <section
        key={node.id}
        ref={(el) => {
          if (el) tableRefs.current.set(node.id, el);
          else tableRefs.current.delete(node.id);
        }}
        data-presence={presence}
        className={[
          "lan-table",
          `is-${presence}`,
          hostSelected ? "is-selected" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        aria-label={`${node.name} host`}
      >
        <button
          type="button"
          className="lan-table-head"
          aria-pressed={hostSelected}
          onClick={(e) => {
            e.stopPropagation();
            selectHost(node);
          }}
        >
          <span className="lan-table-name" title={node.name}>
            {shortDisplayName(node.name, 24)}
          </span>
          {asleep ? (
            <span className="lan-table-meta is-asleep">
              {nodePresenceLabel({
                status: node.status,
                agentVersion: node.agentVersion,
              })}
            </span>
          ) : (
            <span className="lan-table-meta">
              {meters.map((row) => (
                <span key={row.key} className={`lan-meter tone-${row.tone}`} title={row.value}>
                  <b>{row.label}</b>{" "}
                  {row.key === "cpu" || row.value.includes("/")
                    ? `${Math.round(row.fill * 100)}%`
                    : row.value}
                </span>
              ))}
            </span>
          )}
        </button>
        {asleep ? (
          <p className="lan-table-note">
            {presence === "pending_setup" ? "Still setting up" : "Asleep"} · tap
            the name to remove it
          </p>
        ) : (
          <ul className="lan-stations">
            {games.map((p) => {
              const server = serverById.get(p.serverId);
              return server ? renderStation(server) : null;
            })}
            <li>
              <button
                type="button"
                className="lan-station is-add"
                onClick={(e) => {
                  e.stopPropagation();
                  onAddServerRef.current();
                }}
              >
                <span className="lan-station-disc" aria-hidden>
                  +
                </span>
                <span className="lan-station-name">Add server</span>
              </button>
            </li>
          </ul>
        )}
        {extras.length ? (
          <ul className="lan-gear">
            {extras.map((p) => {
              if (p.role === "stack") {
                return (
                  <li key={p.serverId}>
                    <button
                      type="button"
                      className="lan-gear-item is-stack"
                      onClick={(e) => {
                        e.stopPropagation();
                        setExpandedOtherNodes((prev) => ({
                          ...prev,
                          [node.id]: true,
                        }));
                        setRailOthersOpen(true);
                      }}
                    >
                      {otherServicesStackLabel(p.stackCount ?? 0)}
                    </button>
                  </li>
                );
              }
              const server = serverById.get(p.serverId);
              if (!server) return null;
              return (
                <li key={server.id}>
                  <button
                    type="button"
                    disabled={Boolean(server.unmanaged)}
                    className={[
                      "lan-gear-item",
                      `kind-${boardCrateKind(server)}`,
                      server.id === selectedId ? "is-selected" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    title={`${server.name} · ${boardCrateStatusText(server)}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!server.unmanaged) onSelectRef.current(server.id);
                    }}
                  >
                    {shortDisplayName(server.name, 18)}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>
    );
  };

  return (
    <div className="agent-canvas-host" ref={hostRef}>
      {serversLoading && mapEmpty ? (
        <div className="agent-canvas-empty" aria-busy="true">
          <div className="empty-hint">
            <strong>Loading map…</strong>
            <p className="muted status-inline">
              Checking for servers on this host.
            </p>
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
          <div
            ref={floorRef}
            className="lan-room"
            role="region"
            aria-label={`LAN room with ${hostNodes.length} host${hostNodes.length === 1 ? "" : "s"} and ${servers.length} server${servers.length === 1 ? "" : "s"}`}
            onClick={() => onBackgroundClick?.()}
          >
            <div
              ref={roomRef}
              className={
                wiring.below ? "lan-room-inner has-hub-below" : "lan-room-inner"
              }
            >
              <svg className="lan-cables" aria-hidden>
                {wiring.hub
                  ? wiring.cables.map((c) => (
                      <line
                        key={c.id}
                        className={`lan-cable is-${c.tone}`}
                        x1={wiring.hub!.x}
                        y1={wiring.hub!.y}
                        x2={c.to.x}
                        y2={c.to.y}
                      />
                    ))
                  : null}
              </svg>
              <div className="lan-tables">{clusters.map(renderTable)}</div>
              {wiring.hub ? (
                <div
                  className={
                    composeAgent ? "lan-switch has-agent" : "lan-switch"
                  }
                  style={{ left: wiring.hub.x, top: wiring.hub.y }}
                  aria-hidden
                >
                  LAN
                </div>
              ) : null}
              {composeAgent?.nowLine ? (
                <p className="lan-compose-line" role="status">
                  {composeAgent.nowLine}
                </p>
              ) : null}
            </div>
          </div>
          <p className="agent-canvas-map-hint muted" id="map-gesture-hint">
            <span className="hint-full">
              Esc clear · A add · N node · S start · X stop · Tap a host name to
              scan it · Tap a game to chat
              {hostNodes.some((n) => n.id !== "local")
                ? " · Tap a sleeping host to remove it"
                : ""}
            </span>
            <span className="hint-short">Esc clear · tap a host or a game</span>
          </p>
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
                  isPendingNodeSetup({
                    agentVersion: n.agentVersion,
                    status: n.status,
                  }) ||
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
                      <span
                        className={`node-status node-${padPresenceClass(n)}`}
                      >
                        {nodePresenceLabel({
                          status: n.status,
                          agentVersion: n.agentVersion,
                        })}
                        {n.id === "local" || n.status === "online"
                          ? " · Scan for installs"
                          : ""}
                      </span>
                      <HostUsageMeters
                        variant="strip"
                        cpuPercent={n.cpuPercent}
                        memUsedBytes={n.memUsedBytes}
                        memTotalBytes={n.memTotalBytes}
                        freeDiskBytes={n.freeDiskBytes}
                        history={n.usageHistory}
                      />
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
                        railServers[
                          (idx - 1 + railServers.length) % railServers.length
                        ]!;
                      if (!prev.unmanaged) onSelectRef.current(prev.id);
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      onSelectRef.current(undefined);
                    }
                  }}
                >
                  {railServers.map((server) => {
                    const selected = server.id === selectedId;
                    const occupant = agentByServerId.get(server.id);
                    const busyLabel = serverBusyLabel(server.id);
                    const secondary = !isPlayerGameCrate(server);
                    const shownState = displayServerStatus(
                      server.status,
                      server.ready,
                    );
                    return (
                      <li
                        key={server.id}
                        role="option"
                        aria-selected={selected}
                      >
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
                          <span
                            className={`agent-canvas-list-agent mood-${occupant?.mood ?? "idle"}`}
                            title={
                              occupant?.nowLine ?? occupant?.mood ?? "idle"
                            }
                            aria-hidden
                          />
                          {secondary ? null : (
                            <span
                              className={`dash-game-badge map-game-badge${shownState === "running" ? "" : " is-idle"}`}
                              style={
                                {
                                  "--game-h": gameHue(server.game),
                                } as CSSProperties
                              }
                              aria-hidden
                            >
                              {gameBadgeText(server.game)}
                              <span
                                className={`dash-dot state-${shownState}`}
                              />
                            </span>
                          )}
                          <span
                            className="agent-canvas-list-name"
                            title={server.name}
                          >
                            {server.name}
                          </span>
                          <span
                            className={
                              busyLabel
                                ? "muted"
                                : `dash-state state-${shownState}`
                            }
                          >
                            {busyLabel || boardCrateStatusText(server)}
                          </span>
                          <ServerUsageMeters
                            variant="strip"
                            cpuPercent={server.cpuPercent}
                            memUsedBytes={server.memUsedBytes}
                            history={server.usageHistory}
                          />
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
                          otherServers
                            .map((s) => s.nodeId)
                            .filter((id): id is string => Boolean(id)),
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
            <div
              className="map-inline-confirm"
              role="alertdialog"
              aria-labelledby="map-remove-node-title"
            >
              <p id="map-remove-node-title">
                Remove incomplete node “
                {hostNodes.find((h) => h.id === pendingRemoveNodeId)?.name ??
                  pendingRemoveNodeId}
                ”?
              </p>
              <p className="muted small">
                Bootstrap never finished or the agent is offline.
              </p>
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
