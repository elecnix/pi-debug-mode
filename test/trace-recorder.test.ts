import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig, type DebugConfig } from "../src/config.ts";
import { TraceRecorder, type TraceRecord } from "../src/trace-recorder.ts";

function makeConfig(overrides: Partial<DebugConfig> = {}): DebugConfig {
  const cfg = defaultConfig();
  cfg.dir = mkdtempSync(join(tmpdir(), "pi-debug-mode-test-"));
  return { ...cfg, ...overrides };
}

function parseLines(path: string): TraceRecord[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as TraceRecord);
}

function latestSnapshot(sessionDir: string): string {
  const files = readdirSync(sessionDir).filter((f) => f.startsWith("snapshot-") && f.endsWith(".jsonl"));
  expect(files.length).toBeGreaterThan(0);
  return join(sessionDir, files.sort().at(-1)!);
}

describe("TraceRecorder", () => {
  let cfg: DebugConfig;
  let dir: string;

  beforeEach(() => {
    cfg = makeConfig();
    dir = cfg.dir;
  });

  afterEach(() => {
    // leave temp dirs to the OS
  });

  it("keeps only the configured ring window in memory", () => {
    const recorder = new TraceRecorder({ ...cfg, ringSize: 3 });
    recorder.resetForSession("s1");
    for (let i = 1; i <= 5; i++) recorder.record("event", { i });
    expect(recorder.ringSize()).toBe(3);
    expect(recorder.ringContents().map((r) => r.data?.i)).toEqual([3, 4, 5]);
  });

  it("appends to the trace file on the rolling interval", () => {
    const recorder = new TraceRecorder({ ...cfg, flushEvery: 3 });
    recorder.resetForSession("s2");
    recorder.record("a");
    recorder.record("b");
    recorder.record("c"); // triggers first rolling flush
    recorder.record("d"); // not yet flushed

    const trace = recorder.traceFile()!;
    const lines = parseLines(trace);
    expect(lines.map((l) => l.hook)).toEqual(["trace_start", "a", "b", "c"]);
  });

  it("writes everything up to the disruption to the trace file", () => {
    const recorder = new TraceRecorder({ ...cfg, flushEvery: 100 });
    recorder.resetForSession("s3");
    recorder.record("a");
    recorder.record("b");
    recorder.onProviderRequest({ model: "gpt-4" });
    recorder.onDisruption("error", "Request timed out.");

    const lines = parseLines(recorder.traceFile()!);
    const hooks = lines.map((l) => l.hook);
    expect(hooks).toContain("a");
    expect(hooks).toContain("b");
    expect(hooks).toContain("before_provider_request");
    expect(hooks).toContain("provider_request_unanswered");
  });

  it("marks a before_provider_request with no response as provider_request_unanswered in the snapshot", () => {
    const recorder = new TraceRecorder(cfg);
    recorder.resetForSession("timeout-session");
    recorder.onProviderRequest({ model: "gpt-4", messageCount: 3 });
    // ...no after_provider_response — the request never got an HTTP response.
    recorder.onDisruption("error", "Request timed out.");

    const snapshotPath = latestSnapshot(recorder.sessionDirectory()!);
    const records = parseLines(snapshotPath);

    const requestIdx = records.findIndex(
      (r) => r.hook === "before_provider_request" && r.data?.reqId === 1,
    );
    expect(requestIdx).toBeGreaterThan(-1);

    const marker = records[requestIdx + 1];
    expect(marker.hook).toBe("provider_request_unanswered");
    expect(marker.data?.reqId).toBe(1);
    expect(typeof marker.data?.elapsedMs).toBe("number");
    expect(marker.data?.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("pairs a before_provider_request with its after_provider_response when one arrives", () => {
    const recorder = new TraceRecorder(cfg);
    recorder.resetForSession("paired-session");
    recorder.onProviderRequest({ model: "gpt-4" });
    recorder.onProviderResponse({ status: 200 });
    recorder.onDisruption("error", "boom");

    const snapshotPath = latestSnapshot(recorder.sessionDirectory()!);
    const records = parseLines(snapshotPath);
    const request = records.find((r) => r.hook === "before_provider_request")!;
    const response = records.find((r) => r.hook === "after_provider_response")!;
    expect(response.data?.reqId).toBe(request.data?.reqId);
    expect(response.data?.status).toBe(200);
    expect(response.data?.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(records.some((r) => r.hook === "provider_request_unanswered")).toBe(false);
  });

  it("writes a shutdown snapshot with markers for a still-pending request", () => {
    const recorder = new TraceRecorder(cfg);
    recorder.resetForSession("shutdown-session");
    recorder.onProviderRequest({ model: "gpt-4" });
    recorder.onShutdown("quit");

    const records = parseLines(latestSnapshot(recorder.sessionDirectory()!));
    expect(records.some((r) => r.hook === "provider_request_unanswered")).toBe(true);
  });

  it("never writes a credential-shaped value to the flushed artifact (capture-time redaction)", () => {
    const secret = "sk-fake-9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    const recorder = new TraceRecorder(cfg);
    recorder.resetForSession("redact-session");
    // Planted through real capture paths: a request summary, headers, and tool args.
    recorder.onProviderRequest({ model: "gpt-4", apiKey: secret });
    recorder.record("before_provider_headers", {
      headers: { authorization: `Bearer ${secret}`, "x-api-key": secret, "content-type": "application/json" },
    });
    recorder.record("tool_execution_start", {
      toolCallId: "call_1",
      toolName: "bash",
      args: { command: `echo ${secret}`, env: { API_KEY: secret } },
    });
    recorder.record("message_end", { role: "assistant", usage: { input: 10, output: 5, totalTokens: 42 } });
    recorder.onDisruption("aborted", "Operation aborted");

    const snapshotPath = latestSnapshot(recorder.sessionDirectory()!);
    const raw = readFileSync(snapshotPath, "utf8");
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain(`Bearer ${secret}`);

    // The trace file must also be clean.
    const traceRaw = readFileSync(recorder.traceFile()!, "utf8");
    expect(traceRaw).not.toContain(secret);

    // Benign values survive, token counts are not redacted.
    expect(raw).toContain("application/json");
    expect(raw).toContain("totalTokens");
    expect(raw).toContain("42");
  });

  it("bounded: never keeps more than maxFiles jsonl files in the session directory", () => {
    const recorder = new TraceRecorder({ ...cfg, maxFiles: 2 });
    recorder.resetForSession("rotate-session");
    for (let i = 0; i < 8; i++) {
      recorder.manualDump();
    }
    const sessionDir = recorder.sessionDirectory()!;
    const files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
    expect(files.length).toBeLessThanOrEqual(2);
  });

  it("rotates the trace file past maxFileBytes", () => {
    const recorder = new TraceRecorder({ ...cfg, maxFileBytes: 300, maxFiles: 5, flushEvery: 2 });
    recorder.resetForSession("size-session");
    for (let i = 0; i < 40; i++) {
      recorder.record("event", { padding: "x".repeat(100) });
    }
    const sessionDir = recorder.sessionDirectory()!;
    const traceFiles = readdirSync(sessionDir).filter((f) => f.startsWith("trace-"));
    expect(traceFiles.length).toBeGreaterThan(1);
    expect(traceFiles.length).toBeLessThanOrEqual(5);
  });

  it("can be disabled and re-enabled", () => {
    const recorder = new TraceRecorder(cfg);
    recorder.resetForSession("toggle-session");
    recorder.setEnabled(false);
    recorder.record("hidden");
    expect(recorder.ringSize()).toBe(0);
    recorder.setEnabled(true);
    recorder.record("visible");
    expect(recorder.ringSize()).toBe(1);
    expect(recorder.ringContents()[0].hook).toBe("visible");
  });

  it("manual dump writes a snapshot with a manual reason", () => {
    const recorder = new TraceRecorder(cfg);
    recorder.resetForSession("manual-session");
    recorder.record("a");
    const path = recorder.manualDump();
    expect(path).toBeDefined();
    const records = parseLines(path!);
    expect(records[0].hook).toBe("snapshot");
    expect(records[0].data?.reason).toBe("manual");
    expect(records.map((r) => r.hook)).toContain("a");
  });

  it("sanitizes the session id for use as a directory name", () => {
    const recorder = new TraceRecorder(cfg);
    recorder.resetForSession("../../etc/evil&name");
    expect(recorder.sessionDirectory()).toBe(join(dir, ".._.._etc_evil_name"));
  });
});
