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
   A cancellation the backend could not confirm arrives after that close, and is
   recorded on the status rather than swallowed as a clean stop.

`whenFinished()` settles when the turn has emitted its last event.
It deliberately does not wait out a backend still unwinding a cancellation: the
session's own `turnChain` already serializes that against the next turn, which
is where the barrier matters.

## Prompt

Build the correct Floot API without backwards compatibility: daemon-owned
turns, UI view not driver, revert the exo-stream abandoned-chain workaround.
