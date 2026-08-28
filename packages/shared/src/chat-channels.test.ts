import { describe, expect, it } from "vitest";
import {
  COMPOSE_CHANNEL_KEY,
  attachBoundComposeToServer,
  channelKeyForConversation,
  chatChannelKey,
  composeNeedsFreshConversation,
  listChatChannels,
  parkChatChannel,
  parseChatChannelKey,
  routeConversationToChannelKey,
  serverChannelKey,
} from "./chat-channels.js";

describe("chat channel identity", () => {
  it("keys one channel per server plus compose", () => {
    expect(chatChannelKey({ kind: "compose" })).toBe(COMPOSE_CHANNEL_KEY);
    expect(chatChannelKey({ kind: "server", serverId: "paper-1" })).toBe("server:paper-1");
    expect(serverChannelKey("zomboid")).toBe("server:zomboid");
    expect(channelKeyForConversation(null)).toBe(COMPOSE_CHANNEL_KEY);
    expect(channelKeyForConversation("paper-1")).toBe("server:paper-1");
    expect(parseChatChannelKey("server:paper-1")).toEqual({
      kind: "server",
      serverId: "paper-1",
    });
  });

  it("lists Add server even with no conversation id, plus each server", () => {
    const items = listChatChannels({
      servers: [
        { id: "a", name: "Paper" },
        { id: "b", name: "Zomboid" },
      ],
      compose: { pending: true },
      pendingByServer: { a: true },
    });
    expect(items.map((i) => i.key)).toEqual(["compose", "server:a", "server:b"]);
    expect(items[0]).toMatchObject({ title: "Add server", pending: true, kind: "compose" });
    expect(items[1]).toMatchObject({ title: "Paper", pending: true });
    expect(items[2]).toMatchObject({ title: "Zomboid", pending: false });
  });

  it("keeps an in-flight compose channel when switching to another server", () => {
    const inflight = {
      conversationId: "c-add",
      lines: [
        { role: "user" as const, content: "Stand up a Paper server" },
        { role: "assistant" as const, content: "" },
      ],
      progress: { now: "Creating Paper" },
      pending: true,
    };
    const parked = parkChatChannel({}, COMPOSE_CHANNEL_KEY, inflight);
    const afterSwitch = parkChatChannel(parked, serverChannelKey("zomboid"), {
      conversationId: "c-zom",
      lines: [{ role: "user" as const, content: "status" }],
      progress: null,
      pending: false,
    });
    expect(afterSwitch[COMPOSE_CHANNEL_KEY]).toEqual(inflight);
    expect(afterSwitch[COMPOSE_CHANNEL_KEY]?.pending).toBe(true);
    expect(afterSwitch[serverChannelKey("zomboid")]?.conversationId).toBe("c-zom");
  });

  it("routes live events to the parked conversation, not the active tile", () => {
    const channels = {
      [COMPOSE_CHANNEL_KEY]: {
        conversationId: "c-add",
        lines: [],
        progress: null,
        pending: true,
      },
      [serverChannelKey("paper")]: {
        conversationId: "c-paper",
        lines: [],
        progress: null,
        pending: false,
      },
    };
    expect(routeConversationToChannelKey(channels, "c-add")).toBe(COMPOSE_CHANNEL_KEY);
    expect(routeConversationToChannelKey(channels, "c-paper")).toBe("server:paper");
    expect(routeConversationToChannelKey({}, "ghost", "paper")).toBe("server:paper");
    expect(routeConversationToChannelKey({}, "ghost")).toBe(COMPOSE_CHANNEL_KEY);
  });

  it("does not let a parked compose steal tokens after the conversation binds", () => {
    const stale = {
      [COMPOSE_CHANNEL_KEY]: {
        conversationId: "c-add",
        boundServerId: "paper",
        lines: [],
        progress: null,
        pending: false,
      },
      [serverChannelKey("paper")]: {
        conversationId: "c-add",
        boundServerId: "paper",
        lines: [],
        progress: { now: "Starting Paper" },
        pending: true,
      },
      [serverChannelKey("zomboid")]: {
        conversationId: "c-zom",
        lines: [],
        progress: { now: "Stopping Zomboid" },
        pending: true,
      },
    };
    expect(routeConversationToChannelKey(stale, "c-add")).toBe(serverChannelKey("paper"));
    expect(routeConversationToChannelKey(stale, "c-zom")).toBe(serverChannelKey("zomboid"));
  });

  it("attaches a bound add-server turn to the new server without dropping compose", () => {
    const snapshot = {
      conversationId: "c-add",
      lines: [{ role: "assistant" as const, content: "Paper is up." }],
      progress: { now: "Done" },
      pending: false,
    };
    const next = attachBoundComposeToServer(
      { [COMPOSE_CHANNEL_KEY]: { ...snapshot, pending: true } },
      "paper-1",
      snapshot,
    );
    expect(next[COMPOSE_CHANNEL_KEY]?.boundServerId).toBe("paper-1");
    expect(next[COMPOSE_CHANNEL_KEY]?.conversationId).toBeUndefined();
    expect(next[serverChannelKey("paper-1")]?.conversationId).toBe("c-add");
    expect(routeConversationToChannelKey(next, "c-add")).toBe(serverChannelKey("paper-1"));
    expect(listChatChannels({
      servers: [{ id: "paper-1", name: "Paper" }],
      compose: { pending: false, conversationId: next[COMPOSE_CHANNEL_KEY]?.conversationId },
    }).map((i) => i.key)).toEqual(["compose", "server:paper-1"]);
  });

  it("opens a fresh compose conversation after the previous one bound to a server", () => {
    expect(composeNeedsFreshConversation(undefined)).toBe(true);
    expect(
      composeNeedsFreshConversation({
        conversationId: "c1",
        lines: [],
        progress: null,
        pending: false,
      }),
    ).toBe(false);
    expect(
      composeNeedsFreshConversation({
        conversationId: "c1",
        boundServerId: "paper-1",
        lines: [],
        progress: null,
        pending: false,
      }),
    ).toBe(true);
    expect(
      composeNeedsFreshConversation({
        conversationId: "c1",
        boundServerId: "paper-1",
        lines: [],
        progress: null,
        pending: true,
      }),
    ).toBe(false);
  });
});
