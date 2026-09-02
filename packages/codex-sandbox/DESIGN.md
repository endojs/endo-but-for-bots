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
5. `backend-factory.js` owns provisioned resources, verifies the exact outer
   sandbox attestation, and splits run authority from factory-only teardown.
6. `audit-journal.js` provides an append-only, hash-chained writer, an
   independently protected durable head checkpoint that detects entry-store
   rollback or suffix deletion, and a separately held reader over operator-owned
   Endo persistence.

The client rejects concurrent turns instead of hiding a queue. Callers that
want queuing must make that policy visible above the capability boundary.

## Failure rules

- A saved thread is resumed or the call fails; it never silently starts a new
  history.
- A new thread ID must be durably accepted by `saveThreadId` before the first
  turn starts.
- Endowed dynamic Endo tools are handled directly through app-server and every
  intent/result is durably audited.
- Audit payloads are stored completely up to the documented bound; oversized
  dynamic results become an audited boundary failure and are not exposed to
  the model. The journal never substitutes a lossy prefix for an operation it
  reports as successful. Dynamic tool intent/result payloads have a separate
  4 MiB bound inside the 16 MiB complete-entry bound.
- Shell-command and file-change operation requests correlated to the active
  turn are automatically approved because the attested outer Endo sandbox is
  the enforcement boundary.
- Requests to expand or replace the permission profile are denied, as are
  account, login, refresh, other-session, remote-control, uncorrelated, and
  unrecognized server requests.
- Late events are routed by both thread ID and turn ID, preventing an
  interrupted turn from completing its successor.
- EOF, malformed/oversized JSONL, failed turns, and exceeded output bounds end
  in `abort`, never a partial successful assistant message.
- Cancellation issues `turn/interrupt`; it is never replayed.
- Before every prompt, the prior app-server turn ID is durably recorded.
  The new turn ID is then written as soon as it is known.
  A successful terminal is cleared only after Floot durably commits and
  acknowledges that exact checkpoint; every other recovered marker is compared
  with `thread/turns/list`, rolled back once when necessary, and verified before
  it is cleared.
  Side effects are not rolled back and remain in the audit journal.
- JSON-RPC error codes are included in bounded rejection messages so they
  survive Endo's pass-by-copy Error boundary. The core deliberately fails fast
  on the app-server's retryable overload error instead of replaying a possibly
  mutating request with an unknown outcome; callers may retry by creating a
  fresh session.

The normalized stream remains an observation surface, not an authoritative
audit log.
The operator-owned journal is authoritative for events observed by this
integration, but built-in shell/file events remain forensic because app-server
may notify only after execution starts.

See [SANDBOX-CONTRACT.md](./SANDBOX-CONTRACT.md),
[SUBSCRIPTION-AUTH.md](./SUBSCRIPTION-AUTH.md), and Floot's
[backend design](../floot/BACKEND-DESIGN.md).
