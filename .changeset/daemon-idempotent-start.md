---
'@endo/daemon': minor
'@endo/cli': minor
---

`endo start` is now idempotent. When a daemon is already serving the
socket, `start` reports `endo daemon already running (pid N)` and
succeeds without touching anything. When a daemon has claimed its state
but is still booting, `start` waits for it instead of replacing it.
`clean` now leaves the socket, its lock markers, and `endo.pid` in place
while their owner is alive. `endo start --force` and `endo clean --force`
skip the probe as before, but never remove the files of a live daemon that
holds the state lock.

The daemon now claims a single-instance lock on its ephemeral state
directory (`<ephemeral>/endo.lock`) before it opens its database or kills
the workers recorded there, and writes `endo.pid` right after that claim.
A second daemon against the same state exits with status 69
(`EX_UNAVAILABLE`) and the message
`another Endo daemon (pid N) owns <state>`, and `endo run-daemon` passes
that status on. The daemon no longer kills the pid it finds in
`endo.pid` when it starts.
