import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { isHttpError, toErrorResult, type HttpErrorResult } from "@playon/shared";
import { redactString } from "./services/redaction.js";

/**
 * Turns anything a route throws into the shared error envelope. Routes that
 * already `return c.json({ error }, status)` keep working unchanged — the
 * envelope is a superset of that shape.
 */
export function httpErrorHandler(err: Error, c: Context): Response {
  if (err instanceof HTTPException) return err.getResponse();

  const result: HttpErrorResult = toErrorResult(err);
  if (result.status >= 500 && !isHttpError(err)) {
    console.error(
      `[api] unhandled error on ${c.req.method} ${new URL(c.req.url).pathname}:`,
      redactString(err.stack ?? err.message ?? String(err)),
    );
  }
  return c.json(result.body, result.status);
}
