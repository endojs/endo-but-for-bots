---
'@endo/sandbox': patch
---

Cancelled bwrap slices no longer leave sandbox processes running when cancellation arrives while the slice is starting.
A bwrap `SIGTERM` or `SIGKILL` kills the slice's pid-namespace init, so `SIGTERM` gives the workload no grace period.
`DriverProcess.kill` accepts any Node signal name or number, and drivers must preserve its meaning: signal `0` probes liveness and catchable signals reach the workload.
