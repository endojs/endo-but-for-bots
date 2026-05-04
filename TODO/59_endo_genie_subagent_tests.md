# Genie sub-agent — acceptance tests

Sub-task of
[`TADA/23_endo_posix_sandbox_phase3_5b_genie_subagent.md`](../TADA/23_endo_posix_sandbox_phase3_5b_genie_subagent.md)
§ "Deliverables" — _Tests_.

Test home: **`packages/genie/test/sub-agent.test.js`** (new file;
reuse the daemon-fork helpers from
`packages/genie/test/boot/self-boot.test.js` and the per-backend
skip pattern from `packages/sandbox/test/fork.test.js`).

Each case forks a real daemon, runs the genie launcher's full
boot shape (workspace mount + sandbox-factory + main-genie),
exercises `/spawn` end-to-end, and inspects either the live
sub-slice through the host pet-store-pinned `sandbox-factory`
or — for the negative cases — asserts no guest is provisioned
when the spawn rejects.

Cases:

- [ ] **Scoped attenuation**: spawn a sub-agent with a
  `/workspace/proj-a/` sub-path attenuation against the root
  genie's `main-genie-sandbox`; the child runs a `bash` tool
  invocation that `ls /workspace` and assert it sees only
  `proj-a`'s contents (the child's tool channel routes through
  `<agentName>-sandbox`, not `main-genie-sandbox`).
- [ ] **Separate attenuation**: spawn a sub-agent with a
  freshly-granted standalone `Mount`; assert the child's
  `/workspace` (via a `bash` tool call) is the new mount and
  that the parent's workspace is unreachable from the child.
- [ ] **Mount-grant rejection**: `/spawn` with a `Mount` cap
  the parent does not have; assert the spawn fails before any
  guest is provisioned (Phase 3's `fork()` rejects with
  `not within any parent mount`, the `/spawn` builtin surfaces
  a clean operator-readable message, and `parentHost.has(name)`
  remains `false` afterwards).
- [ ] **Network-attenuation rejection**: `/spawn` a child
  requesting `host-net` when the parent is `private`; assert
  rejection with the structured error shape (`child network
  'host-net' is broader than parent's 'private'`) and no guest
  provisioned.
- [ ] **Removal**: `/remove-agent` tears down the sub-slice,
  removes the guest, and clears the directory entry; assert all
  three via post-conditions on `/agents` output (name absent),
  `parentHost.has(name)` (`false`), and the slice's reported
  state (the sandbox-plugin's pet store no longer lists
  `<agentName>-sandbox`).
- [ ] **Teardown ordering**: a child whose `bash` tool is
  mid-spawn is reaped cleanly when `/remove-agent` fires — the
  in-slice process exits via the Phase 3 dispose cascade before
  the guest removal happens.
- [ ] **Cascade**: dispose the parent (kill the root-genie
  worker) while a child has a long-running `bash` tool; assert
  the child's process tree is reaped before parent teardown
  returns (Phase 3 GC ordering, observed via `/proc` from the
  test).
- [ ] **Both backends** (`bwrap`, `podman`), gated on the
  per-backend availability check `packages/sandbox/test/fork.test.js`
  already uses.

Skip policy: probe for `bwrap` (and `podman` for the second pass)
once via `test.serial.before` and degrade to `t.pass()` when the
backend is unavailable on the CI host (mirrors the pattern used
across `packages/sandbox/test/`).

Depends on:
[`51_endo_genie_subagent_fork_slice.md`](./51_endo_genie_subagent_fork_slice.md),
[`52_endo_genie_subagent_provide_guest.md`](./52_endo_genie_subagent_provide_guest.md),
[`53_endo_genie_subagent_worker_boot.md`](./53_endo_genie_subagent_worker_boot.md),
[`55_endo_genie_subagent_remove.md`](./55_endo_genie_subagent_remove.md),
[`57_endo_genie_subagent_specials.md`](./57_endo_genie_subagent_specials.md),
[`58_endo_genie_subagent_dispose_cascade.md`](./58_endo_genie_subagent_dispose_cascade.md).

Blocks: nothing inside 3.5b — the suite is the closing-evidence
artefact.
