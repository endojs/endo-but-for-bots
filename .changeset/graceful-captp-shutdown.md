---
"@endo/captp": minor
"@endo/daemon": patch
---

Add `shutdown(reason)` to CapTP connections for deliberate disconnects that
reject pending operations without reporting the reason through `onReject`.
Daemon clients now use graceful CapTP shutdown for caller-initiated
cancellation, avoiding exception diagnostics during clean teardown.
