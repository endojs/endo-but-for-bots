---
'@endo/sandbox': minor
---

- Fixed: cancelling a bwrap slice while it is starting no longer leaves sandbox processes running.
- Behavior change: on bwrap, `SIGTERM` now ends the workload at once, with no grace period.
- Migration for out-of-tree drivers: `DriverProcess.kill` now accepts any Node signal name or number, and a driver must preserve the signal's meaning, so signal `0` probes liveness and catchable signals reach the workload.
