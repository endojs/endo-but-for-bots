---
'@endo/floot': major
'@endo/chat': patch
---

Make a Floot turn belong to the daemon. `FlootSession.converse(input)`, which
returned the reply reader itself, is replaced by
`FlootSession.startTurn(input) -> FlootTurn`: the daemon drains the reply
channel locally and the turn exposes `getStatus()`, a disposable `watch()` view
stream, `cancel()`, and `whenFinished()`.

Handing the reply channel to the browser made CapTP connection lifetime mean
turn lifetime. `makeBufferedReader`'s close watcher reads an abandoned
synchronize chain as a consumer hang-up and fires `onClose`, and the session
facet wired `onClose` to `controller.abort()` — so a closed tab or a dropped
gateway aborted the turn as if the user had pressed Stop. A turn commits to the
conversation tree only once it completes, so that discarded work a hosted
backend had already done in its sandbox workspace; and a hosted cancellation
the backend could not confirm quarantines the session, which a disconnect
should never be able to trigger. The inbox path already had the right
authority — a mail turn runs against a daemon-side buffering writer that no
disconnect can end — and the UI path now matches it.

`watch()` opens with a `snapshot` event carrying the turn's state so far, then
carries the reply events that follow it, so nothing is lost to the round trip
that opening a view costs and a reattaching client can repaint a turn already
in progress. Views are independent: closing one detaches that viewer and
neither ends the turn nor disturbs another viewer.

Migration: replace `const reader = E(session).converse(input)` with
`const turn = E(session).startTurn(input)`, read events from
`E(turn).watch()`, and stop work with `E(turn).cancel()` — closing the stream
no longer aborts anything. `makeReplyChannel()` now also returns `close`, which
finishes the channel from the producer's side.
