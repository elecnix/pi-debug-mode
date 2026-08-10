import { describe, expect, it } from "vitest";
import { REDACTED, isSensitiveName, looksLikeSecret, redactDeep, redactHeaders, truncateString } from "../src/redact.ts";

describe("redactHeaders", () => {
  it("redacts authorization, api keys and cookies", () => {
    const out = redactHeaders({
      authorization: "Bearer sk-live-1234567890abcdef",
      "x-api-key": "sk-ant-abcdef1234567890",
      cookie: "session=abc123",
      "set-cookie": "sid=xyz; Path=/",
      "x-auth-token": "tok-123",
    });
    expect(out.authorization).toBe(REDACTED);
    expect(out["x-api-key"]).toBe(REDACTED);
    expect(out.cookie).toBe(REDACTED);
    expect(out["set-cookie"]).toBe(REDACTED);
    expect(out["x-auth-token"]).toBe(REDACTED);
  });

  it("keeps benign headers", () => {
    const out = redactHeaders({
      "content-type": "application/json",
      "x-request-id": "req_123",
      "retry-after": "42",
      accept: "text/event-stream",
      "user-agent": "pi/0.84",
    });
    expect(out).toEqual({
      "content-type": "application/json",
      "x-request-id": "req_123",
      "retry-after": "42",
      accept: "text/event-stream",
      "user-agent": "pi/0.84",
    });
  });

  it("preserves null values (header deletion markers) and does not mutate input", () => {
    const input = { "x-remove-me": null as string | null, authorization: "Bearer x" };
    const out = redactHeaders(input);
    expect(out["x-remove-me"]).toBeNull();
    expect(input.authorization).toBe("Bearer x");
  });
});

describe("redactDeep", () => {
  const max = 500;

  it("redacts sensitive keys at any depth, including camel/snake case", () => {
    const out = redactDeep(
      {
        apiKey: "sk-abc",
        api_key: "sk-abc",
        APIKey: "sk-abc",
        Authorization: "Bearer x",
        "auth-token": "t",
        nested: { accessToken: "t", refresh_token: "t", clientSecret: "s" },
      },
      undefined,
      max,
    ) as Record<string, unknown>;
    expect(out.apiKey).toBe(REDACTED);
    expect(out.api_key).toBe(REDACTED);
    expect(out.APIKey).toBe(REDACTED);
    expect(out.Authorization).toBe(REDACTED);
    expect(out["auth-token"]).toBe(REDACTED);
    expect(out.nested).toEqual({
      accessToken: REDACTED,
      refresh_token: REDACTED,
      clientSecret: REDACTED,
    });
  });

  it("keeps benign fields and token counts intact", () => {
    const out = redactDeep(
      { model: "gpt-4", temperature: 0.7, usage: { input: 10, output: 5, totalTokens: 42, costTotal: 0.01 } },
      undefined,
      max,
    ) as Record<string, unknown>;
    expect(out.model).toBe("gpt-4");
    expect(out.temperature).toBe(0.7);
    expect(out.usage).toEqual({ input: 10, output: 5, totalTokens: 42, costTotal: 0.01 });
  });

  it("redacts credential-shaped string values even under benign keys", () => {
    const out = redactDeep(
      {
        key_phrase: "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
        value: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
        bearer: "Bearer eyJhbGciOiJIUzI1NiJ9.some.payload.signature",
      },
      undefined,
      max,
    ) as Record<string, unknown>;
    expect(out.key_phrase).toBe(REDACTED);
    expect(out.value).toBe(REDACTED);
    expect(out.bearer).toBe(REDACTED);
  });

  it("does not redact ordinary strings", () => {
    const out = redactDeep({ text: "the quick brown fox jumps over the lazy dog", model: "gpt-4" }, undefined, max) as Record<string, unknown>;
    expect(out.text).toBe("the quick brown fox jumps over the lazy dog");
  });

  it("truncates long strings with an explicit marker", () => {
    const long = "x".repeat(10_000);
    const out = redactDeep({ content: long }, undefined, 50) as Record<string, unknown>;
    expect((out.content as string).length).toBeLessThan(100);
    expect(out.content).toContain("[+9950 chars]");
  });

  it("redacts inside arrays", () => {
    const out = redactDeep([{ apiKey: "sk-zzz" }, "plain"], undefined, max) as unknown[];
    expect(out[0]).toEqual({ apiKey: REDACTED });
    expect(out[1]).toBe("plain");
  });

  it("does not mutate the input", () => {
    const input = { apiKey: "sk-abc", nested: { ok: 1 } };
    redactDeep(input, undefined, max);
    expect(input.apiKey).toBe("sk-abc");
    expect(input.nested.ok).toBe(1);
  });
});

describe("isSensitiveName", () => {
  it("recognizes sensitive names", () => {
    for (const n of ["authorization", "x-api-key", "apiKey", "api_key", "cookie", "token", "secret", "password", "session_id", "client_secret"]) {
      expect(isSensitiveName(n), n).toBe(true);
    }
  });
  it("rejects benign names", () => {
    for (const n of ["content-type", "model", "tokens", "totalTokens", "temperature", "messageCount", "status", "toolName"]) {
      expect(isSensitiveName(n), n).toBe(false);
    }
  });
});

describe("looksLikeSecret", () => {
  it("detects common credential shapes", () => {
    for (const s of [
      "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
      "pk-live-abcdefghijklmnopqrstuvwxyz0123456789",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "ghp_abcdefghijklmnopqrstuvwxyz123456",
      "glpat-abcdefghijklmnopqrstuvwxyz123456",
      "AIzaSyD0123456789abcdefghijklmnopqrstuvw",
    ]) {
      expect(looksLikeSecret(s), s).toBe(true);
    }
  });
  it("does not false-positive on ordinary strings", () => {
    for (const s of ["hello world", "sk-notes.md", "Bearer-ish wording", "model=gpt-4", "a b c d"]) {
      expect(looksLikeSecret(s), s).toBe(false);
    }
  });
});

describe("truncateString", () => {
  it("passes through short strings", () => {
    expect(truncateString("short", 50)).toBe("short");
  });
  it("truncates long strings with a marker", () => {
    const out = truncateString("abcdefghij", 5);
    expect(out).toBe("abcde…[+5 chars]");
  });
});
