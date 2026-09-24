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
5. `src/codex-backend-factory.js` (the root `backend-factory.js` is a
   re-export) is the hosted backend Floot discovers; `src/codex-native-controller.js`
   composes the shared session supervisor, verifies the exact outer sandbox
   attestation against the shared `hosted-agent-v1` profile, and restores a
   new thread from the stack's transcript records through
   `thread/inject_items`.
6. `audit-journal.js` provides required, serialized host-private diagnostic
   writes. `codex-session-store.js` provides the existing atomic file store;
   there is no audit-reader facet, hash chain, or independent anchor store.

### Journal and checkpoint responsibilities

Floot's journal is authoritative for conversation history and mediated Endo tool
effects. Its tool executor records intent before execution and outcome before
returning the result. Codex's audit is a second observation of those calls, not
a second executor or a source from which to replay them.

The Codex audit additionally records native thread/turn/item identifiers,
provider-native tool observations, runtime verification, approval/denial events,
and late tool-result/projection diagnostics. These retain transport evidence
that is not equivalent to Floot's normalized conversation records. Current
production code does not interpret these event kinds during recovery.
Diagnostics are required: an append is acknowledged only after content values and
its complete entry have been durably written.
Any rejected operation permanently fences that writer incarnation; this includes
an uncertain write whose bytes are visible but whose directory flush failed.
Existing client failure handling still fails the session rather than exposing an
unaudited successful result.

The separate `thread/checkpoint.json` record is operational recovery state.
`readThread` supplies the saved thread/tool-catalog identity and recovery marker;
`makeTurnLedger` uses that marker for reconciliation and acknowledgement, and
`writeThread` persists it. Removing this checkpoint is not journal deduplication.

The V2 diagnostic format uses one immutable entry per sequence.
Reconstruction validates contiguous entry filenames and the final entry's version,
session/journal binding, sequence and shape, then resumes after it.
Only the final payload is read; the filename inventory still grows with history.
The existing session owner must provide a single writer; the existence check plus
atomic rename is not concurrent-writer exclusion.
Content-addressed large values remain complete and deduplicated.

This deliberately removes chain-based historical mutation and suffix-deletion
detection, and prepared-anchor replay.
It trusts the host filesystem; it does not defend against a writer controlling
that filesystem or certify the integrity of unread historical payloads.
Visible malformed diagnostic-prefix names refuse, but the file store's normal
inventory filtering is not a complete forensic scan of arbitrary filesystem names.
An absent final entry may no longer be detected, and is not repaired.
A crash before entry publication may leave an unreferenced content value.
Diagnostics do not authorize effect replay, native quiescence, or exactly-once
execution; Floot evidence and native reconciliation remain separate.
Old anchored layouts and V1 tails require deliberate session reset, not migration.
The runtime's policy anchor is unrelated and unchanged.

The client rejects concurrent turns instead of hiding a queue. Callers that
want queuing must make that policy visible above the capability boundary.

## Failure rules

- A saved thread is resumed or the call fails; it never silently starts a new
  history.
- A new thread ID must be durably accepted by `saveThreadState` before the first
  turn starts.
- Endowed dynamic Endo tools are handled directly through app-server and every
  intent/result is durably audited.
- Audit payloads are stored completely. A payload text field over 64 KiB is
  stored as its own content value, named by its hash, and the entry carries
  the reference, the byte count and a 4 KiB preview. A result the journal cannot
  store as one value (16 MiB) becomes an audited boundary failure and is not
  exposed to the model. The journal never substitutes a lossy prefix for an
  operation it reports as successful.
- Shell-command and file-change operation requests correlated to the active
  turn are automatically approved because the attested outer Endo sandbox is
  the enforcement boundary.
- Requests to expand or replace the permission profile are denied, as are
  account, login, refresh, other-session, remote-control, uncorrelated, and
  unrecognized server requests.
- Late events are routed by both thread ID and turn ID, preventing an
  interrupted turn from completing its successor.
- EOF, malformed/oversized JSONL, failed turns, and a turn that retains more
  item identities than its bound end in `abort`, never a partial successful
  assistant message. A turn is not bounded in events or bytes: delivery is
  bounded by credit at the reader, and what the host keeps of a turn is
  bounded where it is kept.
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
The host-private diagnostic log records events observed by this
integration, but built-in shell/file events remain forensic because app-server
may notify only after execution starts.

See [SANDBOX-CONTRACT.md](./SANDBOX-CONTRACT.md),
[SUBSCRIPTION-AUTH.md](./SUBSCRIPTION-AUTH.md), and Floot's
[backend design](../floot/BACKEND-DESIGN.md).
