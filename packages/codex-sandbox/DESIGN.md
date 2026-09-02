# Design

## Why app-server

The exploratory implementation ran `codex exec` once per turn and resumed a
persisted thread afterward. Cancellation or slice recreation could therefore
re-run a prompt whose shell or file side effects had already happened. Codex's
app-server is the product integration surface for thread lifecycle, streamed
items, model discovery, approvals, and `turn/interrupt`, so this extraction uses
one long-lived app-server process per session.

## Layers

1. `app-server-transport.js` adapts a sandbox `ProcessHandle` to newline-delimited
   JSON messages. It drains stderr concurrently and owns process teardown.
2. `codex-client.js` owns JSON-RPC request correlation, initialization, thread
   start/resume, durable thread-id handoff, strict turn routing, interruption,
   and bounded event production.
3. `codex-protocol.js` frames JSONL and normalizes version-specific tool items.
4. Floot's `hosted-turn.js` consumes only the normalized event vocabulary.

The client rejects concurrent turns instead of hiding a queue. Callers that
want queuing must make that policy visible above the capability boundary.

## Failure rules

- A saved thread is resumed or the call fails; it never silently starts a new
  history.
- A new thread ID must be durably accepted by `saveThreadId` before the first
  turn starts.
- Unrecognized server requests fail closed.
- Late events are routed by both thread ID and turn ID, preventing an
  interrupted turn from completing its successor.
- EOF, malformed/oversized JSONL, failed turns, and exceeded output bounds end
  in `abort`, never a partial successful assistant message.
- Cancellation issues `turn/interrupt`; it does not kill and replay the turn.
- JSON-RPC error codes are included in bounded rejection messages so they
  survive Endo's pass-by-copy Error boundary. The core deliberately fails fast
  on the app-server's retryable overload error instead of replaying a possibly
  mutating request with an unknown outcome; callers may retry by creating a
  fresh session.

The normalized stream remains an observation surface, not an authoritative
audit log. A durable append-only audit capability is a merge blocker for hosted
multi-tenant operation.
