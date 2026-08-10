/**
 * TraceRecorder — the core of pi-debug-mode.
 *
 * Holds a bounded in-memory ring of lifecycle + provider events, appends them
 * to a bounded rotating trace file on a rolling interval (so a SIGKILL loses
 * at most a bounded tail), and writes a standalone snapshot with synthesized
 * `provider_request_unanswered` markers when a session is disrupted.
 *
 * The synthesized marker is the feature: pi fires `before_provider_request`
 * for every provider call but `after_provider_response` only when an HTTP
 * response is actually received. A timeout, a dropped connection, or an abort
 * leaves a `before_provider_request` with no matching response; the snapshot
 * makes that absence explicit instead of leaving the reader to notice a
 * missing line.
 */
import { join } from "node:path";
import type { DebugConfig } from "./config.ts";
import { redactDeep } from "./redact.ts";
import { RingBuffer } from "./ring-buffer.ts";
import { RotatingWriter } from "./rotating-writer.ts";

export interface TraceRecord {
  /** Epoch milliseconds. */
  t: number;
  /** Monotonic sequence number within the session. */
  seq: number;
  /** Hook / event type. */
  hook: string;
  data?: Record<string, unknown>;
}

export interface PendingRequest {
  reqId: number;
  startedAt: number;
}

export type DisruptionReason = "error" | "aborted" | "shutdown";

export class TraceRecorder {
  private readonly cfg: DebugConfig;
  private readonly ring: RingBuffer<TraceRecord>;
  /** Events recorded but not yet appended to the trace file. */
  private pendingAppend: TraceRecord[] = [];
  private seq = 0;
  private reqCounter = 0;
  private pendingRequests: PendingRequest[] = [];
  private enabled = true;
  private trace?: RotatingWriter;
  private sessionDir?: string;

  constructor(cfg: DebugConfig) {
    this.cfg = cfg;
    this.ring = new RingBuffer<TraceRecord>(cfg.ringSize);
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
  }

  ringSize(): number {
    return this.ring.size;
  }

  pendingRequestCount(): number {
    return this.pendingRequests.length;
  }

  traceFile(): string | undefined {
    return this.trace?.currentFile();
  }

  sessionDirectory(): string | undefined {
    return this.sessionDir;
  }

  ringContents(): TraceRecord[] {
    return this.ring.toArray();
  }

  /** Start capturing for a new session. */
  resetForSession(sessionId: string): void {
    this.ring.clear();
    this.pendingAppend = [];
    this.pendingRequests = [];
    this.seq = 0;
    this.reqCounter = 0;
    this.sessionDir = join(this.cfg.dir, sanitizePathSegment(sessionId) || "unknown");
    this.trace = new RotatingWriter(this.sessionDir, {
      maxFiles: this.cfg.maxFiles,
      maxFileBytes: this.cfg.maxFileBytes,
    });
    this.trace.appendLine(
      JSON.stringify({
        t: Date.now(),
        seq: 0,
        hook: "trace_start",
        data: {
          dir: this.sessionDir,
          ringSize: this.cfg.ringSize,
          flushEvery: this.cfg.flushEvery,
          fullCapture: this.cfg.fullCapture,
          maxString: this.cfg.maxString,
        },
      }),
    );
  }

  /**
   * Record a summarized event. Data passes through capture-time redaction
   * here, so the buffer can never hold a credential-shaped value.
   */
  record(hook: string, data?: Record<string, unknown>): void {
    if (!this.enabled) return;
    const rec: TraceRecord = {
      t: Date.now(),
      seq: ++this.seq,
      hook,
      data: data === undefined ? undefined : (redactDeep(data, undefined, this.cfg.maxString) as Record<string, unknown>),
    };
    this.ring.push(rec);
    this.pendingAppend.push(rec);
    if (this.pendingAppend.length >= this.cfg.flushEvery) this.flushTrace();
  }

  /** Pair a provider request with a fresh request id and record it. */
  onProviderRequest(data: Record<string, unknown>): void {
    const reqId = ++this.reqCounter;
    this.pendingRequests.push({ reqId, startedAt: Date.now() });
    this.record("before_provider_request", { reqId, ...data });
  }

  /** Record a provider response and pair it with the most recent pending request. */
  onProviderResponse(data: Record<string, unknown>): void {
    const pending = this.pendingRequests.pop();
    this.record("after_provider_response", {
      reqId: pending?.reqId,
      elapsedMs: pending === undefined ? undefined : Date.now() - pending.startedAt,
      ...data,
    });
  }

  /** Called when a message ends with stopReason "error" or "aborted". */
  onDisruption(stopReason: "error" | "aborted", detail?: string): void {
    this.snapshotAndFlush(stopReason, { stopReason, errorMessage: detail });
  }

  /** Called on session shutdown. */
  onShutdown(reason: string): void {
    this.snapshotAndFlush("shutdown", { reason });
    this.trace?.fsyncCurrent();
  }

  /** Write a snapshot of the current ring window on demand. */
  manualDump(): string | undefined {
    if (!this.trace || !this.sessionDir) return undefined;
    return this.writeSnapshot("manual", {}, this.synthesizeMarkers());
  }

  /** Drop all in-memory state (ring, pending appends, unanswered requests). */
  clear(): void {
    this.ring.clear();
    this.pendingAppend = [];
    this.pendingRequests = [];
  }

  // ----- internals -----

  private synthesizeMarkers(): TraceRecord[] {
    const now = Date.now();
    return this.pendingRequests.map((p) => ({
      t: now,
      seq: ++this.seq,
      hook: "provider_request_unanswered",
      data: {
        reqId: p.reqId,
        elapsedMs: now - p.startedAt,
        note: "no after_provider_response before this flush — the request never produced an HTTP response",
      },
    }));
  }

  private snapshotAndFlush(reason: DisruptionReason, extra: Record<string, unknown>): void {
    if (!this.enabled || !this.trace || !this.sessionDir) return;
    const markers = this.synthesizeMarkers();
    const pendingCount = this.pendingRequests.length;
    this.pendingRequests = [];
    // Trace: append markers (monotonic order), then the remaining tail.
    for (const m of markers) this.pendingAppend.push(m);
    this.flushTrace();
    this.trace.fsyncCurrent();
    this.writeSnapshot(reason, { ...extra, pendingRequests: pendingCount }, markers);
  }

  private flushTrace(): void {
    if (!this.trace) return;
    for (const rec of this.pendingAppend) {
      this.trace.appendLine(JSON.stringify(rec));
    }
    this.pendingAppend = [];
  }

  private writeSnapshot(
    reason: string,
    extra: Record<string, unknown>,
    markers: TraceRecord[],
  ): string {
    const events = this.ring.toArray();
    const markerByReq = new Map<number, TraceRecord>();
    for (const m of markers) {
      const reqId = m.data?.reqId;
      if (typeof reqId === "number") markerByReq.set(reqId, m);
    }

    const lines: string[] = [];
    lines.push(
      JSON.stringify({
        t: Date.now(),
        seq: this.seq,
        hook: "snapshot",
        data: {
          reason,
          ...extra,
          sessionDir: this.sessionDir,
          ringEvents: events.length,
          ringCapacity: this.cfg.ringSize,
        },
      }),
    );

    const seen = new Set<number>();
    for (const e of events) {
      lines.push(JSON.stringify(e));
      // Insert the unanswered marker directly after its request, so the
      // post-mortem reads: request sent → (nothing) → marker.
      if (e.hook === "before_provider_request" && typeof e.data?.reqId === "number") {
        const marker = markerByReq.get(e.data.reqId);
        if (marker !== undefined && !seen.has(e.data.reqId)) {
          seen.add(e.data.reqId);
          lines.push(JSON.stringify(marker));
        }
      }
    }
    // Requests whose ring entry was already evicted still get reported.
    for (const m of markers) {
      const reqId = m.data?.reqId;
      if (typeof reqId === "number" && !seen.has(reqId)) {
        lines.push(
          JSON.stringify({
            ...m,
            data: { ...m.data, note: "request entry evicted from the ring before snapshot" },
          }),
        );
      }
    }

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const name = `snapshot-${ts}-${reason}.jsonl`;
    return this.trace!.writeSnapshot(name, lines);
  }
}

function sanitizePathSegment(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.length > 0 ? cleaned : "unknown";
}
