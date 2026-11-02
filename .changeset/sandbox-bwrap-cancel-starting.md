---
'@endo/sandbox': minor
---

- Fixed: cancelling a bwrap slice while it is starting no longer leaves sandbox processes running.
- Behavior change: on bwrap, every termination signal now ends the workload at once, with no grace period.
