---
'@endo/daemon': minor
---

`EndoHost` gains `debugWorker(petNamePath)`, which restarts an XS worker
from its snapshot paused under the debugger and returns a connected
`Debugger`, so breakpoints can be set before any of the worker's code runs.
