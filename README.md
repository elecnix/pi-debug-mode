# pi-debug-mode

**pi extension** — a bounded ring-buffer trace of lifecycle and provider events,
flushed to disk when a session is disrupted, so a timeout, an abort, or a crash
leaves a post-mortem trace instead of nothing.

## The problem it solves

pi has no built-in debug/trace mode. When a request fails, the session
transcript records the finalized error message — but nothing about the provider
request that led to it, and in particular not whether a response ever arrived.

The motivating case: an agent routed through an HTTP proxy timed out after five
minutes with no response, and the session transcript could not say whether the
request ever reached the server.

This extension records a bounded window of lifecycle and provider events as
they happen. When a session is disrupted it writes a snapshot in which any
`before_provider_request` without a matching `after_provider_response` is
explicitly marked `provider_request_unanswered` — the single most valuable
diagnostic signal it can surface. pi fires `after_provider_response` only when
an HTTP response is actually received; a timeout, a dropped connection, or an
abort leaves a request with no response, and the snapshot says so instead of
leaving you to notice a missing line.

## What it captures

Each event becomes one bounded, redacted, summarized record:

- **Provider boundary** — `before_provider_headers` (redacted header map),
  `before_provider_request` (model, message count, per-role char counts, safe
  scalar params), `after_provider_response` (status, elapsed since the
  request, redacted response headers).
- **Message lifecycle** — `message_start` / `message_end` summaries: role,
  model, provider, stop reason, error message, token usage, and content
  *counts* (text chars, thinking chars, tool calls) — never verbatim text.
- **Agent/turn/tool lifecycle** — agent start/end/settled, turn start/end,
  tool execution start (redacted args) and end (name, id, isError, and a
  truncated error preview on failure).
- **Session lifecycle** — session start (reason), session shutdown (reason).

The records land in two places:

- `trace-*.jsonl` — a rolling append-only log of the session, written on a
  rolling interval so a SIGKILL loses at most a bounded tail.
- `snapshot-<timestamp>-<reason>.jsonl` — a standalone post-mortem artifact
  (ring window + explicit `provider_request_unanswered` markers) written on
  disruption (`error` / `aborted` stop reasons), on shutdown, and on demand
  via `/debug`.

## What it explicitly cannot capture

The extension API stops at the HTTP payload/response boundary. pi-debug-mode
**cannot** see:

- DNS resolution, TCP connect, TLS handshake, time-to-first-byte
- raw stream chunks or transport-level errors
- per-HTTP-attempt retry details (hooks fire once per logical provider call)

For true wire-level capture, run pi through an HTTP tracing proxy (e.g.
mitmproxy) via the `HTTPS_PROXY` / `HTTP_PROXY` environment variables that pi
already respects, and correlate with the trace.

## Install

```bash
pi install git:github.com/elecnix/pi-debug-mode@main
```

The extension auto-loads on your next pi session. To install manually (e.g. to hack on it):

```bash
# Global (all projects) — the package is multi-file, so copy the whole src/
mkdir -p ~/.pi/agent/extensions/pi-debug-mode
cp -r src ~/.pi/agent/extensions/pi-debug-mode/src
```

## Usage

| Command | Effect |
|---|---|
| `/debug` or `/debug dump` | Write a snapshot of the current ring window to disk |
| `/debug on` / `/debug off` | Enable / disable capture (on by default) |
| `/debug status` | Show capture state, ring usage, pending requests, output location |
| `/debug clear` | Drop the in-memory ring and pending state |

## Configuration

All options are environment variables (defaults in parentheses). Invalid
values fall back to the default and log a warning — a misconfigured debug tool
must never take pi down.

| Variable | Default | Meaning |
|---|---|---|
| `PI_DEBUG_DIR` | `~/.pi/agent/debug` | Root output directory; one subdirectory per session |
| `PI_DEBUG_RING_SIZE` | `1000` | In-memory ring capacity, in events |
| `PI_DEBUG_FLUSH_EVERY` | `500` | Append new events to the trace file every N events (bounds SIGKILL loss) |
| `PI_DEBUG_MAX_FILES` | `10` | Max `.jsonl` files kept per session directory (trace + snapshots) |
| `PI_DEBUG_MAX_FILE_BYTES` | `1048576` | Max bytes per trace file before rotating (1 MiB) |
| `PI_DEBUG_MAX_STRING` | `500` | Max chars kept for any single captured string value |
| `PI_DEBUG_FULL_CAPTURE` | `0` | Set to `1` to capture full (redacted, truncated) provider payloads |

## Where files land and how disk use is bounded

Output goes to `$PI_DEBUG_DIR/<session-id>/` (session id sanitized for
filesystem safety), e.g.:

```
~/.pi/agent/debug/--Users-you-my-project-main--/trace-000001.jsonl
~/.pi/agent/debug/--Users-you-my-project-main--/snapshot-2026-01-01T00-00-00-000Z-error.jsonl
```

Nothing grows without limit:

- the in-memory ring holds at most `PI_DEBUG_RING_SIZE` events;
- the trace file rotates at `PI_DEBUG_MAX_FILE_BYTES` and the directory keeps
  at most `PI_DEBUG_MAX_FILES` files total, deleting the oldest first;
- every captured string is truncated to `PI_DEBUG_MAX_STRING` chars.

## Redaction and sensitivity

**Redaction is on by default, at capture time** — the buffer never holds a
credential-shaped value, so a crash cannot leak what a flush would have
stripped. `Authorization`, `x-api-key`, cookies, and any `apiKey`-ish field
are replaced with `[redacted]`; strings matching common credential shapes
(provider keys, JWTs, bearer tokens, GitHub/GitLab/Slack/AWS tokens) are
redacted even under benign-looking keys. Token counts and benign headers
survive. Value-level detection is heuristic and biased toward redaction:
false positives are possible, and credentials embedded in free text are still
best protected by keeping full text out of the trace.

Prompt and completion **text is never stored verbatim by default** — messages
become counts and sizes. The one exception is `PI_DEBUG_FULL_CAPTURE=1`, which
writes the provider payload body (deeply redacted and truncated to
`PI_DEBUG_MAX_STRING` chars per string). **Read that output before you read
anything else:** full capture writes more of the conversation to disk than the
default mode does, and redaction is a heuristic, not a guarantee.

**The captured data is sensitive by nature** — it describes your prompts,
tool calls, timing, and error messages. Scrub it (and re-check it by hand)
before pasting it into any issue, chat, or support thread.

## Development

```bash
npm install
npm test            # unit tests (vitest)
npm run typecheck   # tsc --noEmit
```

The tests are real: they exercise the ring buffer's eviction, the redaction
paths by planting a fake credential and asserting it is absent from the
flushed artifact on disk, and the unanswered-request marker by replaying a
`before_provider_request` with no `after_provider_response` and asserting the
snapshot contains `provider_request_unanswered`. They run in CI on every push.

## License

MIT
