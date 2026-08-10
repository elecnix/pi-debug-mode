/**
 * Capture-time redaction. Everything that enters the trace passes through this
 * module first, so a crash can never leak what a flush would have stripped:
 * the in-memory buffer only ever holds redacted data.
 *
 * Two layers:
 *  1. Name-based — any header or object key that looks sensitive is replaced
 *     wholesale ("authorization", "x-api-key", "cookie", "apiKey", ...).
 *  2. Value-based — strings that match common credential shapes (provider
 *     keys, JWTs, bearer tokens) are replaced even under benign-looking keys.
 *
 * Long strings are truncated (never stored verbatim) to keep every record
 * bounded in size.
 */

export const REDACTED = "[redacted]";

/** Sensitive header/field names (case-insensitive, kebab / snake / camel case). */
const SENSITIVE_NAME =
  /(^|[_-])(api[_-]?key|apikey|authorization|auth[_-]?token|access[_-]?token|refresh[_-]?token|bearer|token|secret|password|passwd|credential|private[_-]?key|client[_-]?secret|client[_-]?id|session[_-]?(id|key|token)|cookie)([_-]|$)/i;

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /^bearer\s+\S+$/i,
  // JWT: header.payload.signature
  /^eyj[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{4,}$/i,
  // Provider-style keys (sk-…, pk-…, rk-…)
  /^(sk|pk|rk)-[a-z0-9_-]{16,}$/i,
  // Google API keys
  /^aiza[0-9a-z_-]{20,}$/i,
  // GitHub tokens
  /^(ghp_|gho_|ghu_|ghs_|github_pat_)[a-z0-9_]{16,}$/i,
  // GitLab personal access tokens
  /^glpat-[a-z0-9_-]{16,}$/i,
  // Slack tokens
  /^xox[baprs]-[a-z0-9-]{8,}$/i,
  // AWS access key ids
  /^akia[a-z0-9]{16}$/i,
];

// Same shapes as substrings, so a credential embedded in a longer value
// (a shell command, a URL, a JSON blob) is still caught. Heuristic and
// deliberately biased toward redaction: a false positive costs a redacted
// line, a false negative could leak a key.
const SECRET_SUBSTRING_PATTERNS: RegExp[] = [
  /bearer\s+[a-z0-9._~+/=-]{12,}/i,
  /(sk|pk|rk)-[a-z0-9_-]{16,}/i,
  /eyj[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{4,}/i,
  /aiza[0-9a-z_-]{20,}/i,
  /(ghp_|gho_|ghu_|ghs_|github_pat_)[a-z0-9_]{16,}/i,
  /glpat-[a-z0-9_-]{16,}/i,
  /xox[baprs]-[a-z0-9-]{8,}/i,
  /akia[a-z0-9]{16}/i,
];

export function isSensitiveName(name: string): boolean {
  return SENSITIVE_NAME.test(name);
}

export function looksLikeSecret(value: string): boolean {
  const v = value.trim();
  if (v.length < 8) return false;
  if (SECRET_VALUE_PATTERNS.some((re) => re.test(v))) return true;
  return SECRET_SUBSTRING_PATTERNS.some((re) => re.test(v));
}

/** Truncate a string to `max` chars, appending an explicit truncation marker. */
export function truncateString(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max) + `…[+${value.length - max} chars]`;
}

/** Copy of headers with sensitive values replaced; benign values kept as-is. */
export function redactHeaders(headers: Record<string, string | null>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = value === null ? null : isSensitiveName(name) ? REDACTED : value;
  }
  return out;
}

/**
 * Deep-copy a value, redacting sensitive keys and secret-looking strings and
 * truncating long strings. Used as the single capture-time choke point.
 */
export function redactDeep(value: unknown, key: string | undefined, maxString: number): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (key !== undefined && isSensitiveName(key)) return REDACTED;
    if (looksLikeSecret(value)) return REDACTED;
    return truncateString(value, maxString);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    if (key !== undefined && isSensitiveName(key)) return REDACTED;
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, undefined, maxString));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v, k, maxString);
    }
    return out;
  }
  return value;
}
