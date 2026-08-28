import { describe, expect, it } from "vitest";
import {
  channelKeyForConversation,
  COMPOSE_CHANNEL_KEY,
  serverChannelKey,
} from "../chat-channels.js";
import {
  ChatRequestSchema,
  ConfirmRequestSchema,
  CreateConversationRequestSchema,
} from "./chat.js";

describe("conversation identity contract", () => {
  it("keys unbound add-server separately from a bound serverId", () => {
    expect(channelKeyForConversation(undefined)).toBe(COMPOSE_CHANNEL_KEY);
    expect(channelKeyForConversation(null)).toBe(COMPOSE_CHANNEL_KEY);
    expect(channelKeyForConversation("srv-1")).toBe(serverChannelKey("srv-1"));
    expect(serverChannelKey("srv-1")).not.toBe(COMPOSE_CHANNEL_KEY);
  });
});

describe("conversation request contract", () => {
  it("accepts an empty body and caps the title", () => {
    expect(CreateConversationRequestSchema.parse({})).toEqual({});
    expect(CreateConversationRequestSchema.parse({ title: "Paper night" }).title).toBe(
      "Paper night",
    );
    expect(CreateConversationRequestSchema.safeParse({ title: "" }).success).toBe(false);
    expect(CreateConversationRequestSchema.safeParse({ title: "x".repeat(121) }).success).toBe(
      false,
    );
  });
});

describe("chat request contract", () => {
  it("leaves a missing prompt to the route so it can answer message_required", () => {
    expect(ChatRequestSchema.parse({})).toEqual({});
    expect(ChatRequestSchema.parse({ message: "   " }).message).toBe("   ");
  });

  it("rejects non-string ids and prompts", () => {
    expect(ChatRequestSchema.safeParse({ message: 42 }).success).toBe(false);
    expect(ChatRequestSchema.safeParse({ message: "hi", conversationId: "" }).success).toBe(false);
    expect(ChatRequestSchema.safeParse({ message: "hi", serverId: 7 }).success).toBe(false);
  });
});

describe("confirm request contract", () => {
  it("requires both the request id and the decision", () => {
    expect(ConfirmRequestSchema.parse({ requestId: "req-1", approved: false })).toEqual({
      requestId: "req-1",
      approved: false,
    });
    const missing = ConfirmRequestSchema.safeParse({ requestId: "req-1" });
    expect(missing.success).toBe(false);
    expect(missing.error?.issues.map((issue) => issue.path.join("."))).toEqual(["approved"]);
    expect(ConfirmRequestSchema.safeParse({ requestId: "", approved: true }).success).toBe(false);
  });
});
