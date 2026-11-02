---
'@endo/sandbox': minor
---

- Cancelled bwrap slices no longer leave sandbox processes running when cancellation arrives while the slice is starting. On bwrap, `SIGTERM` now ends the workload at once, without a grace period.
- Out-of-tree drivers: `DriverProcess.kill` now accepts any Node signal name or number, and a driver must preserve its meaning, so signal `0` probes liveness and catchable signals reach the workload.
