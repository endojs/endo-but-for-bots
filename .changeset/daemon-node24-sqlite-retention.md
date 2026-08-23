---
'@endo/daemon': patch
---

Retain every better-sqlite3 Database and Statement wrapper for the life of
the process. Node.js 24.19.0 compiles environment cleanup hooks into
`node::ObjectWrap`, and a wrapper finalized by garbage collection while no
JS context is entered aborts the process with
`RemoveEnvironmentCleanupHook ... Assertion failed: (env) != nullptr`.
