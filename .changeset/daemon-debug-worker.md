---
'@endo/daemon': minor
---

`EndoHost` gains `debugWorker(workerNameOrPath)`, which restarts a shared (in-process) XS worker from its snapshot paused under the debugger and returns a connected `Debugger`, so breakpoints can be set before any of the worker's code runs; for any other worker it rejects without suspending the worker.
