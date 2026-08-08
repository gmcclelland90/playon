import { z } from "zod";

/**
 * Request contracts for the agent conversation surface: chat turns, the session
 * list and the confirm gate. They live here so the control plane and the web
 * client agree on the shape and a schema failure renders as the shared 400
 * envelope instead of a raw zod dump.
 */

/** Title is user text rendered in the session list, so it stays short. */
export const CreateConversationRequestSchema = z.object({
  title: z.string().min(1).max(120).optional(),
});

export type CreateConversationRequest = z.infer<typeof CreateConversationRequestSchema>;

/**
 * `message` is optional here on purpose: a blank or missing prompt is the
 * route's own `message_required` answer rather than a generic contract failure,
 * which is what clients already branch on.
 */
export const ChatRequestSchema = z.object({
  message: z.string().optional(),
  conversationId: z.string().min(1).optional(),
  serverId: z.string().min(1).optional(),
});

export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const ConfirmRequestSchema = z.object({
  requestId: z.string().min(1),
  approved: z.boolean(),
});

export type ConfirmRequest = z.infer<typeof ConfirmRequestSchema>;
