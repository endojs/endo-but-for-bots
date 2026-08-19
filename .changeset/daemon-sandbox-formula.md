---
'@endo/daemon': minor
'@endo/sandbox': minor
---

Add a `sandbox` formula and `EndoHost.provideSandbox(petName, profile)`, promoting
`@endo/sandbox` from an unconsumed `make-unconfined` plugin to a first-class
daemon capability.

The profile a caller supplies — rootfs, mount grants, network posture, backend
selector, seccomp mode, resource limits — is normalized and persisted as a
formula, with each granted mount capability resolved to its formula identifier,
so the slice reconstitutes against the same mounts across a daemon restart.
Reconstruction re-mints the slice: no process, stream, or kernel mount survives
a restart, and no interrupted work is replayed.

The sandbox backend and the 9P mount projector enter through the
`DaemonicPowers` host-tool seam beside `makeNodeHostToolPowers`, so the daemon
core stays free of `node:` builtins and a supervisor that supplies no host tools
refuses to mint a slice with a diagnosis rather than a missing import. The
factory's privileged `provideHostPath` surface is narrowed to exactly the mounts
the profile named plus the slice's own scratch, so a `sandbox` formula cannot
recover the host path of any other daemon-minted mount. A writable grant over a
read-only mount is refused at `provideSandbox` and again at reincarnation.

Every mint records an explicit escalation — `OS_EFFECT`, `RESOURCE_LIMIT`, or
`NATIVE_IMPLEMENTATION` — plus the capability that asked, on stderr and in the
new `EndoDiagnostics.listSandboxEscalations()`. The `getFormula` record for a
`sandbox` formula surfaces the same fields.

`@endo/sandbox` drops its `@endo/daemon` dependency, which nothing in the package
imports — its daemon smoke test only names the daemon in a comment — so the
daemon can depend on the sandbox package without a workspace cycle.
