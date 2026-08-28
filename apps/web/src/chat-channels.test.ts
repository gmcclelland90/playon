import { describe, expect, it } from "vitest";
import {
  COMPOSE_CHANNEL_KEY,
  listChatChannels,
  parkChatChannel,
  serverChannelKey,
} from "@playon/shared";

/** UI fixture: switching tiles mid-turn must keep the parked channel. */
describe("canvas chat channels", () => {
  it("keeps add-server listed and in-flight after switching to another server", () => {
    const inflight = {
      conversationId: "c-add",
      lines: [
        { role: "user" as const, content: "I want a vanilla Minecraft server" },
        { role: "assistant" as const, content: "" },
      ],
      progress: { now: "Thinking…", thinking: "I’ll look up a Paper skill first." },
      pending: true,
    };
    const channels = parkChatChannel(
      parkChatChannel({}, COMPOSE_CHANNEL_KEY, inflight),
      serverChannelKey("zomboid"),
      {
        conversationId: "c-zom",
        lines: [{ role: "user" as const, content: "restart tonight" }],
        progress: null,
        pending: false,
      },
    );

    const listed = listChatChannels({
      servers: [
        { id: "paper", name: "Paper" },
        { id: "zomboid", name: "Zomboid" },
      ],
      compose: {
        pending: channels[COMPOSE_CHANNEL_KEY]?.pending,
        conversationId: channels[COMPOSE_CHANNEL_KEY]?.conversationId,
      },
      pendingByServer: { zomboid: Boolean(channels[serverChannelKey("zomboid")]?.pending) },
      conversationByServer: {
        zomboid: channels[serverChannelKey("zomboid")]?.conversationId,
      },
    });

    expect(listed[0]).toMatchObject({
      key: COMPOSE_CHANNEL_KEY,
      title: "Add server",
      pending: true,
      conversationId: "c-add",
    });
    expect(channels[COMPOSE_CHANNEL_KEY]?.lines[0]?.content).toMatch(/vanilla Minecraft/);
    expect(channels[COMPOSE_CHANNEL_KEY]?.progress).toMatchObject({ now: "Thinking…" });
    expect(listed.some((c) => c.key === serverChannelKey("zomboid"))).toBe(true);
  });

  it("allows two servers to stay in flight without sharing a conversation", () => {
    const channels = parkChatChannel(
      parkChatChannel({}, serverChannelKey("paper"), {
        conversationId: "c-paper",
        lines: [],
        progress: { now: "Starting Paper" },
        pending: true,
      }),
      serverChannelKey("zomboid"),
      {
        conversationId: "c-zom",
        lines: [],
        progress: { now: "Stopping Zomboid" },
        pending: true,
      },
    );
    expect(channels[serverChannelKey("paper")]?.conversationId).toBe("c-paper");
    expect(channels[serverChannelKey("zomboid")]?.conversationId).toBe("c-zom");
    expect(channels[serverChannelKey("paper")]?.progress).not.toEqual(
      channels[serverChannelKey("zomboid")]?.progress,
    );
  });
});
