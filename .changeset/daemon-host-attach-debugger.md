---
'@endo/daemon': minor
---

`EndoHost` gains `attachDebugger(workerNameOrPath)` and `detachDebugger(workerNameOrPath)`, which hot-attach the XS debugger to a running worker and return it to dormant, under the Rust supervisor.
Workers on Node.js and names that do not designate a worker are refused.
