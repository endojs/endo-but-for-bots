---
'@endo/sandbox': patch
---

Fix the `bwrap` driver to clean up its detached host process group after an
ordinary sandbox-process exit. The driver now launches `bwrap` behind a
signal-resistant process-group anchor and sweeps the group with `SIGKILL` from
the leader's `exit` handler, so a normal exit no longer leaves a leaked,
owned host process group behind. `ESRCH` from the sweep (an already-empty
group) is tolerated; any other signalling error rejects the process's
`wait()`.
