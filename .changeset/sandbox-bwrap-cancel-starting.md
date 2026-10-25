---
'@endo/sandbox': patch
---

Cancelled bwrap slices no longer leave sandbox processes running when cancellation arrives while the slice is starting.
A bwrap `SIGTERM` or `SIGKILL` now also kills the slice's pid-namespace init, so `SIGTERM` gives the workload no grace period; it never did once bwrap's `--die-with-parent` took effect.
`DriverProcess.kill` accepts any Node signal name or number, and drivers must preserve its meaning: signal `0` probes liveness and catchable signals reach the workload.
