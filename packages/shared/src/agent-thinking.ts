/**
 * Sanitize model reasoning / next-step prose for the Home chat now-line.
 * Never a second model call — this only cleans text the loop already has.
 */

const INLINE_SECRET =
  /\b(sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._\-+=/]{16,}|api[_-]?key\s*[:=]\s*\S+)/gi;

const ENV_ASSIGN = /\b(?:PLAYON_[A-Z0-9_]+|[A-Z][A-Z0-9_]{3,})\s*=\s*\S+/g;

const JAIL_PATH =
  /(?:\/(?:var|home|opt|tmp|workspace|data|root|usr)\/[^\s,;]+|[A-Za-z]:\\[^\s,;]+)/g;

const FENCED = /```[\s\S]*?```/g;
const TOOL_XML = /<\/?(?:function|tool_call|call|start_function_call|end_function_call)[^>]*>/gi;
const TOOL_JSON =
  /\{[^{}]{0,800}"(?:name|arguments|parameters|type)"[^{}]{0,800}\}/g;

const MAX_CHARS = 320;
const MAX_SENTENCES = 3;

export function looksLikeHiddenDump(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (/^[A-Za-z0-9+/=_-]{40,}$/.test(trimmed)) return true;
  if (/```(?:json|tool|tool_code)\b/i.test(trimmed)) return true;
  if (/<\s*(?:function|tool_call|call)\b/i.test(trimmed)) return true;
  if (/"type"\s*:\s*"function"/i.test(trimmed)) return true;
  if (
    /"name"\s*:\s*"[a-zA-Z0-9_-]+"/.test(trimmed) &&
    /"(?:arguments|parameters)"\s*:/.test(trimmed)
  ) {
    return true;
  }
  return false;
}

/** Cap to a few plain sentences and strip secrets / dumps / jail paths. */
export function sanitizeAgentThinking(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  let text = raw.replace(/\r/g, "");
  if (looksLikeHiddenDump(text)) return undefined;
  text = text.replace(FENCED, " ");
  text = text.replace(TOOL_XML, " ");
  text = text.replace(TOOL_JSON, " ");
  text = text.replace(INLINE_SECRET, "[REDACTED]");
  text = text.replace(ENV_ASSIGN, "[REDACTED]");
  text = text.replace(JAIL_PATH, "[path]");
  text = text.replace(/\s+/g, " ").trim();
  if (!text || looksLikeHiddenDump(text)) return undefined;

  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim());
  text = sentences.slice(0, MAX_SENTENCES).join(" ").trim();
  if (text.length > MAX_CHARS) {
    text = `${text.slice(0, MAX_CHARS - 1).replace(/\s+\S*$/, "").trimEnd()}…`;
  }
  return text || undefined;
}
