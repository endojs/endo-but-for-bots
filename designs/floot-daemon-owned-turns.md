# Floot daemon-owned turns

| | |
|---|---|
| **Created** | 2026-08-10 |
| **Updated** | 2026-09-07 |
| **Author** | kumavis (prompted) |
| **Status** | **Complete** |

## Status

Implemented on the session facet:

- **`startTurn(input) -> FlootTurn`** replaces **`converse(input) -> replyReader`**.
- **`FlootTurn`**: `getStatus()`, `watch()` (disposable view stream), `cancel()`,
  `whenFinished()`.
- **`getCurrentTurn() -> { input, turn, history } | null`** recovers the outstanding UI turn.
- Drain loop lives in `packages/floot/src/session-turn.js` on the daemon.
- Chat observes via `watch()`; **Stop** calls **`Turn.cancel()`** only.

See [ui-view-not-driver](ui-view-not-driver.md) for the general principle.

## Problem

After exo-stream phase 3, the browser became the CapTP initiator on the reply
syn chain.
`makeBufferedReader`'s close watcher reads an abandoned synchronize chain as a
consumer hang-up and fires `onClose`, and the session facet wired `onClose` to
`controller.abort()` — so tab close looked like Stop and aborted CLI turns.
Moving the background loop to module scope in chat fixed **component unmount**,
not **tab death**.

The asymmetry was already visible inside Floot: a mail turn runs against a
daemon-side buffering writer and serializes on `turnChain`, so no disconnect
can end it.
Only the UI turn had a weaker guarantee than the mail turn, which is backwards.

Hosted backends raised the stakes.
A turn commits to the conversation tree only once it completes, so a spurious
abort discards a turn that may already have mutated a sandbox workspace.
Worse, `runHostedTurn`'s cancellation barrier can fail, and Floot treats that
failure as a reason to quarantine the session — so a closed tab could take a
hosted session's mail addressability with it until the daemon restarted.

## Design

Turn authority stays on the daemon:

1. `makeReplyChannel()` without wiring **`onClose → abort`**: the channel is the
   daemon's, and its `close` is how the daemon ends it.
2. Local **`iterateReader(reader)`** on the session worker folds reply events
   into a `TurnStatus`.
3. **`watch()`** opens a fresh buffered reader per viewer, pushes a `snapshot`
   of the folded status, then tees subsequent events to it.
   Emitting before folding is what makes the two line up: a view applies exactly
   the events its snapshot does not already account for.
   A viewer's close removes that viewer and nothing else.
4. **`cancel()`** aborts the signal and calls the producer's **`close()`** —
   `runTurn` returns without settling its writer once its signal aborts, so
   nothing else would release the local drain.
   The public view stays open in phase `cancelling` until the run promise settles.
   A failed backend cancellation produces an `abort` terminal event for every
   remaining viewer, rather than changing status after a clean `end`.

`whenFinished()` settles only after both the reply drain and execution settle.
Its final status is immutable in time: backend teardown cannot revise it later.
`cancel()` acknowledges the request promptly; callers use `whenFinished()` or
continue observing `watch()` to learn the outcome.

## Session ownership and reconnect

A session holds one outstanding UI turn in `session-turn-slot.js`.
`getCurrentTurn()` returns its input and handle, including during cancellation,
so a fresh browser can recover observation and cancellation authority.
The input is a string or `null` for a streamed prompt; discovery never reveals the
original caller's input capability.
A competing `startTurn` is rejected while that slot is occupied.
UI submissions queue locally, and mail still serializes on the agent's turn chain.
The slot releases its reference at completion; holders may retain completed handles.
There is no completed-turn archive or new durable turn identity.
Daemon restart recovery continues to use committed conversation history.

Chat scopes its observation cache by factory capability identity and session ID.
It recovers the daemon handle on opening a session and waits for recovery before
submitting new input.
A view attachment owns its subscription and releases it exactly once, independently
of session selection or history reads.
Deleting an active session detaches immediately while the factory performs teardown;
late events cannot change the next session's state.
Queued input for a deleted session is discarded rather than sent to a different one.

## Backend catalog

Hosted provisioning receives the session's fully assembled tool snapshot, including
subagent and account tools when their capabilities were endowed.
The provider loop uses the same registry; hosted sessions intentionally pin their
snapshot at provisioning for continuity and authority checks.

Recovery history is the baseline captured inside the serialized execution chain,
before the turn starts (including earlier mail).
It excludes the current turn even while its durable commit awaits acknowledgement;
observers combine this baseline with the prompt and turn snapshot.
Discovery returns the turn handle immediately, with a separate history promise.
A queued turn can be observed or cancelled while earlier mail is still running.
The view reconciles cached observations by daemon turn identity and retires obsolete
streams without cancelling execution.

## Validation

Tests cover snapshot continuity, independent viewers, delayed cancellation failure,
execution completion after stream termination, slot retention, and factory-level
recovery and history persistence after a view disconnect.
Chat component tests exercise active and non-active deletion, last-session deletion,
late events, cancellation reporting, and recovery of a turn absent from browser memory.
Real CapTP tests disconnect and reconnect serialized transports, recover turn identity
and snapshots, and cancel before a queued history promise resolves.
Shared-view regressions cover retiring stale handles and waiting for replacement turns.

## Prompt

Build the correct Floot API without backwards compatibility: daemon-owned
turns, UI view not driver, revert the exo-stream abandoned-chain workaround.
