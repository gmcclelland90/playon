import { timingSafeEqual } from "node:crypto";
import type { Context } from "hono";

/** Returns false when a token is configured and the request does not present it. */
export function nodeTokenAuthorized(
  c: Context,
  expectedToken: string | undefined,
): boolean {
  const expected = expectedToken?.trim();
  if (!expected) return true;
  const header = c.req.header("authorization") ?? "";
  const bearer = header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : (c.req.header("x-playon-node-token") ?? "").trim();
  const a = Buffer.from(bearer);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
