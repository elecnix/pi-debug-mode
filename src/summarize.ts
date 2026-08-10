/**
 * Event summarization. Prompt and completion text is never stored verbatim:
 * messages become counts (chars per role, tool-call counts, token usage),
 * provider payloads become model + message counts + safe scalar params, and
 * tool results are reduced to sizes and error previews. Only the explicitly
 * opted-in full-capture mode (PI_DEBUG_FULL_CAPTURE=1) writes payload bodies,
 * and even those pass through capture-time redaction and truncation.
 */
import type { DebugConfig } from "./config.ts";
import { redactDeep } from "./redact.ts";

/** Numeric/boolean provider request params safe to record as-is. */
const SAFE_PARAM_KEYS = [
  "max_tokens",
  "maxTokens",
  "temperature",
  "top_p",
  "topP",
  "stream",
  "reasoning_effort",
] as const;

/** Reduce a serialized provider payload to a bounded summary. */
export function summarizeProviderPayload(payload: unknown, cfg: DebugConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (payload === null || typeof payload !== "object") {
    out.shape = payload === null ? "null" : typeof payload;
    return out;
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.model === "string") out.model = p.model;

  const messages = p.messages;
  if (Array.isArray(messages)) {
    out.messageCount = messages.length;
    const roles: Record<string, number> = {};
    let textChars = 0;
    for (const m of messages) {
      if (m === null || typeof m !== "object") continue;
      const msg = m as Record<string, unknown>;
      const role = typeof msg.role === "string" ? msg.role : "unknown";
      roles[role] = (roles[role] ?? 0) + 1;
      if (typeof msg.content === "string") {
        textChars += msg.content.length;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (
            block !== null &&
            typeof block === "object" &&
            typeof (block as Record<string, unknown>).text === "string"
          ) {
            textChars += ((block as Record<string, unknown>).text as string).length;
          }
        }
      }
    }
    out.roles = roles;
    out.textChars = textChars;
  }

  if (typeof p.system === "string") out.systemChars = p.system.length;

  for (const key of SAFE_PARAM_KEYS) {
    const v = p[key];
    if (v === undefined) continue;
    if (typeof v === "number" || typeof v === "boolean") out[key] = v;
    else if (typeof v === "string") out[`${key}Chars`] = v.length;
  }

  if (cfg.fullCapture) {
    // Loud opt-in: full payload, deeply redacted and truncated.
    out.payload = redactDeep(payload, undefined, cfg.maxString);
  }
  return out;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/** Reduce a finalized message to a bounded summary (text is never stored verbatim). */
export function summarizeMessage(msg: unknown, maxString: number): Record<string, unknown> | undefined {
  if (msg === null || typeof msg !== "object") return undefined;
  const m = msg as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  if (typeof m.role === "string") out.role = m.role;
  if (typeof m.model === "string") out.model = m.model;
  if (typeof m.provider === "string") out.provider = m.provider;
  if (typeof m.stopReason === "string") out.stopReason = m.stopReason;
  if (typeof m.rawStopReason === "string") out.rawStopReason = m.rawStopReason;
  if (typeof m.errorMessage === "string") {
    out.errorMessage = m.errorMessage.length > maxString ? m.errorMessage.slice(0, maxString) + "…" : m.errorMessage;
  }

  const usage = m.usage;
  if (usage !== null && typeof usage === "object") {
    const u = usage as Record<string, unknown>;
    const cost = u.cost as Record<string, unknown> | undefined;
    out.usage = {
      input: num(u.input),
      output: num(u.output),
      cacheRead: num(u.cacheRead),
      cacheWrite: num(u.cacheWrite),
      totalTokens: num(u.totalTokens),
      costTotal: typeof cost?.total === "number" ? cost.total : undefined,
    };
  }

  const content = m.content;
  if (Array.isArray(content)) {
    let textChars = 0;
    let thinkingChars = 0;
    let toolCalls = 0;
    for (const block of content) {
      if (block === null || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      const text = typeof b.text === "string" ? b.text : undefined;
      if (b.type === "text" && text !== undefined) textChars += text.length;
      else if (b.type === "thinking" && text !== undefined) thinkingChars += text.length;
      else if (b.type === "toolCall") toolCalls++;
    }
    out.content = { textChars, thinkingChars, toolCalls };
  }

  if (typeof m.timestamp === "number") out.ts = m.timestamp;
  return out;
}

/** Convert an arbitrary tool result to a bounded string preview (used for error previews only). */
export function stringPreview(value: unknown, maxString: number): string {
  let s: string;
  if (typeof value === "string") s = value;
  else if (value === undefined || value === null) s = String(value);
  else {
    try {
      s = JSON.stringify(value);
    } catch {
      s = String(value);
    }
  }
  return s.length > maxString ? s.slice(0, maxString) + "…" : s;
}
