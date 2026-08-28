/**
 * Glanceable occupant mood for the Home board.
 *
 * Turns stay one conversation per server (see chat-channels). This is
 * presentation only — not a new OS process per tile.
 */

import { COMPOSE_CHANNEL_KEY, serverChannelKey } from "./chat-channels.js";

export type AgentMood = "idle" | "thinking" | "working";

export type ServerAgentPresence = {
  key: string;
  serverId: string | null;
  mood: AgentMood;
  nowLine?: string;
  skill?: string;
  verb?: string;
};

export function agentMoodFromActivity(input: {
  pending?: boolean;
  phase?: string | null;
}): AgentMood {
  const phase = input.phase ?? "";
  if (phase === "tool_start" || phase === "tool_done" || phase === "tool_fail") {
    return "working";
  }
  if (phase === "thinking" || phase === "confirm_wait") return "thinking";
  if (input.pending) return "thinking";
  return "idle";
}

export function glanceableNowLine(input: {
  mood: AgentMood;
  label?: string;
  verb?: string;
}): string | undefined {
  if (input.mood === "idle") return undefined;
  const raw = (input.label ?? input.verb ?? (input.mood === "working" ? "Working" : "Thinking")).trim();
  return raw ? raw.slice(0, 16) : undefined;
}

/**
 * One occupant per live server. Compose joins only while that add-server turn
 * is in flight.
 */
export function listServerAgents(input: {
  servers: Array<{ id: string }>;
  pendingKeys?: Iterable<string>;
  activityByKey?: Record<
    string,
    { phase?: string; label?: string; skill?: string; verb?: string }
  >;
  includeCompose?: boolean;
}): ServerAgentPresence[] {
  const pending = new Set(input.pendingKeys ?? []);
  const agents: ServerAgentPresence[] = input.servers.map((server) =>
    presenceForKey(serverChannelKey(server.id), server.id, pending, input.activityByKey),
  );
  if (input.includeCompose) {
    const composePending = new Set(pending);
    composePending.add(COMPOSE_CHANNEL_KEY);
    agents.push(presenceForKey(COMPOSE_CHANNEL_KEY, null, composePending, input.activityByKey));
  }
  return agents;
}

function presenceForKey(
  key: string,
  serverId: string | null,
  pending: Set<string>,
  activityByKey?: Record<
    string,
    { phase?: string; label?: string; skill?: string; verb?: string }
  >,
): ServerAgentPresence {
  const activity = activityByKey?.[key];
  const mood = agentMoodFromActivity({
    pending: pending.has(key),
    phase: activity?.phase,
  });
  return {
    key,
    serverId,
    mood,
    nowLine: glanceableNowLine({
      mood,
      label: activity?.label,
      verb: activity?.verb,
    }),
    skill: activity?.skill,
    verb: activity?.verb,
  };
}
