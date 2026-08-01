const SENSITIVE_KEY =
  /^(api[_-]?key|authorization|password|passwd|secret|token|access[_-]?token|refresh[_-]?token|private[_-]?key|session)$/i;

const INLINE_SECRET =
  /\b(sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._\-+=/]{16,}|api[_-]?key\s*[:=]\s*\S+)/gi;

export function redactString(input: string): string {
  return input.replace(INLINE_SECRET, "[REDACTED]");
}

export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactValue(nested);
    }
    return out;
  }
  return value;
}

export function redactJson(value: unknown): string {
  return JSON.stringify(redactValue(value));
}
