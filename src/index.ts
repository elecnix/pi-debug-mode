/**
 * pi-debug-mode — bounded ring-buffer trace of lifecycle + provider events,
 * flushed to disk when a session is disrupted.
 *
 * Why it exists: pi has no built-in debug/trace mode. When an agent request
 * times out, aborts, or crashes, the session transcript records the finalized
 * error message but nothing about the provider request that led to it — in
 * particular, whether a response ever arrived. This extension keeps a bounded
 * in-memory ring of lifecycle and provider events, and when a session is
 * disrupted it writes a snapshot in which any `before_provider_request`
 * without a matching `after_provider_response` is marked explicitly as
 * `provider_request_unanswered`.
 *
 * The motivating case: an agent routed through an HTTP proxy timed out after
 * five minutes with no response, and the session transcript could not say
 * whether the request ever reached the server.
 *
 * Limits (documented honestly): the extension API stops at the HTTP
 * payload/response boundary. It cannot see DNS resolution, TCP connect, TLS
 * handshake, or time-to-first-byte. For true wire-level capture, run pi
 * through an HTTP tracing proxy via `HTTPS_PROXY` (see README).
 */
import type {
  BeforeProviderHeadersEvent,
  BeforeProviderRequestEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  MessageEndEvent,
  SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { redactDeep, redactHeaders, truncateString } from "./redact.ts";
import { stringPreview, summarizeMessage, summarizeProviderPayload } from "./summarize.ts";
import { TraceRecorder } from "./trace-recorder.ts";

// Not exported from the package root; defined structurally here.
interface AfterProviderResponseEvent {
  type: "after_provider_response";
  status: number;
  headers: Record<string, string | null>;
}

export default function (pi: ExtensionAPI): void {
  const config = loadConfig();
  const recorder = new TraceRecorder(config);

  // ----- session lifecycle -----

  pi.on("session_start", (_event, ctx) => {
    recorder.resetForSession(ctx.sessionManager.getSessionId());
  });

  pi.on("session_shutdown", (event: SessionShutdownEvent) => {
    recorder.onShutdown(event.reason);
  });

  // ----- provider boundary (the part the session transcript cannot see) -----

  pi.on("before_provider_headers", (event: BeforeProviderHeadersEvent) => {
    recorder.record("before_provider_headers", { headers: redactHeaders(event.headers) });
  });

  pi.on("before_provider_request", (event: BeforeProviderRequestEvent) => {
    recorder.onProviderRequest(summarizeProviderPayload(event.payload, config));
  });

  pi.on("after_provider_response", (event: AfterProviderResponseEvent) => {
    recorder.onProviderResponse({ status: event.status, headers: redactHeaders(event.headers) });
  });

  // ----- message lifecycle -----

  pi.on("message_start", (event) => {
    const data = summarizeMessage(event.message, config.maxString);
    if (data) recorder.record("message_start", data);
  });

  pi.on("message_end", (event: MessageEndEvent) => {
    const data = summarizeMessage(event.message, config.maxString);
    if (data) recorder.record("message_end", data);

    const msg = event.message as { role?: string; stopReason?: string; errorMessage?: string };
    if (msg.role === "assistant" && (msg.stopReason === "error" || msg.stopReason === "aborted")) {
      // Immediate flush: this is the disruption the trace exists to capture.
      recorder.onDisruption(msg.stopReason, msg.errorMessage);
    }
  });

  // ----- agent / turn / tool lifecycle -----

  pi.on("agent_start", () => {
    recorder.record("agent_start");
  });

  pi.on("agent_end", (event) => {
    recorder.record("agent_end", { messageCount: event.messages.length });
  });

  pi.on("agent_settled", () => {
    recorder.record("agent_settled");
  });

  pi.on("turn_start", (event) => {
    recorder.record("turn_start", { turnIndex: event.turnIndex });
  });

  pi.on("turn_end", (event) => {
    const msg = summarizeMessage(event.message, config.maxString);
    recorder.record("turn_end", { turnIndex: event.turnIndex, ...(msg ?? {}) });
  });

  pi.on("tool_execution_start", (event) => {
    recorder.record("tool_execution_start", {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: redactDeep(event.args, undefined, config.maxString),
    });
  });

  pi.on("tool_execution_end", (event) => {
    const data: Record<string, unknown> = {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      isError: event.isError,
    };
    if (event.isError) {
      data.errorPreview = truncateString(stringPreview(event.result, config.maxString), config.maxString);
    }
    recorder.record("tool_execution_end", data);
  });

  // ----- commands -----

  pi.registerCommand("debug", {
    description:
      "pi-debug-mode: dump the trace ring buffer to disk, toggle capture, or show status. Usage: /debug [dump|on|off|status|clear]",
    handler: async (args, ctx: ExtensionCommandContext) => {
      const arg = args.trim().toLowerCase();
      if (arg === "on") {
        recorder.setEnabled(true);
        ctx.ui.notify("pi-debug-mode: capture enabled", "info");
      } else if (arg === "off") {
        recorder.setEnabled(false);
        ctx.ui.notify("pi-debug-mode: capture disabled", "info");
      } else if (arg === "clear") {
        recorder.clear();
        ctx.ui.notify("pi-debug-mode: ring cleared", "info");
      } else if (arg === "status" || arg === "") {
        const file = recorder.traceFile();
        ctx.ui.notify(
          [
            `pi-debug-mode: ${recorder.isEnabled ? "on" : "off"}`,
            `ring ${recorder.ringSize()}/${config.ringSize}`,
            `unanswered requests: ${recorder.pendingRequestCount()}`,
            `session dir: ${recorder.sessionDirectory() ?? "not started"}`,
            `trace file: ${file ?? "not started"}`,
          ].join(" | "),
          "info",
        );
      } else {
        const path = recorder.manualDump();
        if (path) {
          ctx.ui.notify(`pi-debug-mode: dumped ${recorder.ringSize()} events to ${path}`, "info");
        } else {
          ctx.ui.notify("pi-debug-mode: no active session to dump", "warning");
        }
      }
    },
  });
}
