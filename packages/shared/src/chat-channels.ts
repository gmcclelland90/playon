/** How Home chat threads are keyed: one per server, plus a stable add-server compose channel. */

export const COMPOSE_CHANNEL_KEY = "compose";

export type ChatChannelKind = "compose" | "server";

export type ChatChannelId =
  | { kind: "compose" }
  | { kind: "server"; serverId: string };

export function serverChannelKey(serverId: string): string {
  return `server:${serverId}`;
}

export function chatChannelKey(id: ChatChannelId): string {
  return id.kind === "compose" ? COMPOSE_CHANNEL_KEY : serverChannelKey(id.serverId);
}

export function parseChatChannelKey(key: string): ChatChannelId {
  if (key === COMPOSE_CHANNEL_KEY) return { kind: "compose" };
  if (key.startsWith("server:") && key.length > 7) {
    return { kind: "server", serverId: key.slice("server:".length) };
  }
  return { kind: "compose" };
}

/** Unbound / add-server conversations have no serverId yet. */
export function channelKeyForConversation(serverId: string | null | undefined): string {
  return serverId ? serverChannelKey(serverId) : COMPOSE_CHANNEL_KEY;
}

export type ChatChannelRecord<TProgress = unknown, TLine = unknown> = {
  conversationId?: string;
  boundServerId?: string;
  lines: TLine[];
  progress: TProgress | null;
  pending: boolean;
};

export type ChatChannelMap<TProgress = unknown, TLine = unknown> = Record<
  string,
  ChatChannelRecord<TProgress, TLine>
>;

export type ChatChannelListItem = {
  key: string;
  kind: ChatChannelKind;
  title: string;
  pending: boolean;
  conversationId?: string;
};

/**
 * Always lists Add server first, then one channel per server.
 * Compose stays in the list while an add-server turn is in flight — no server id required.
 */
export function listChatChannels(input: {
  servers: Array<{ id: string; name: string }>;
  compose?: { pending?: boolean; conversationId?: string };
  pendingByServer?: Record<string, boolean>;
  conversationByServer?: Record<string, string | undefined>;
}): ChatChannelListItem[] {
  return [
    {
      key: COMPOSE_CHANNEL_KEY,
      kind: "compose",
      title: "Add server",
      pending: Boolean(input.compose?.pending),
      conversationId: input.compose?.conversationId,
    },
    ...input.servers.map((server) => ({
      key: serverChannelKey(server.id),
      kind: "server" as const,
      title: server.name,
      pending: Boolean(input.pendingByServer?.[server.id]),
      conversationId: input.conversationByServer?.[server.id],
    })),
  ];
}

/** Park an in-flight snapshot so switching tiles cannot overwrite it. */
export function parkChatChannel<TProgress, TLine>(
  channels: ChatChannelMap<TProgress, TLine>,
  key: string,
  snapshot: ChatChannelRecord<TProgress, TLine>,
): ChatChannelMap<TProgress, TLine> {
  return { ...channels, [key]: snapshot };
}

export function routeConversationToChannelKey(
  channels: ChatChannelMap,
  conversationId: string,
  serverId?: string | null,
): string {
  let composeMatch: string | undefined;
  let serverMatch: string | undefined;
  for (const [key, channel] of Object.entries(channels)) {
    if (channel.conversationId !== conversationId) continue;
    if (key === COMPOSE_CHANNEL_KEY) composeMatch = key;
    else serverMatch = key;
  }
  // After bind, the same id may still sit on compose until it is detached.
  // Live events belong to the server channel so two tiles cannot steal tokens.
  if (serverMatch) return serverMatch;
  if (composeMatch) return composeMatch;
  return channelKeyForConversation(serverId);
}

/**
 * After add-server binds a server, the same conversation becomes that server's
 * channel. Compose stays listed (and keeps the transcript on screen); a new
 * unbound id is created the next time Add server needs a session.
 */
export function attachBoundComposeToServer<TProgress, TLine>(
  channels: ChatChannelMap<TProgress, TLine>,
  serverId: string,
  snapshot: ChatChannelRecord<TProgress, TLine>,
): ChatChannelMap<TProgress, TLine> {
  const bound: ChatChannelRecord<TProgress, TLine> = {
    ...snapshot,
    boundServerId: serverId,
    pending: snapshot.pending,
  };
  return {
    ...channels,
    [COMPOSE_CHANNEL_KEY]: {
      ...bound,
      conversationId: undefined,
    },
    [serverChannelKey(serverId)]: bound,
  };
}

export function composeNeedsFreshConversation(
  compose: ChatChannelRecord | undefined,
): boolean {
  if (!compose) return true;
  if (compose.pending) return false;
  if (compose.conversationId && !compose.boundServerId) return false;
  return true;
}
