# Genie sub-agent — parent-disposal cascade verification

Sub-task of
[`TADA/23_endo_posix_sandbox_phase3_5b_genie_subagent.md`](../TADA/23_endo_posix_sandbox_phase3_5b_genie_subagent.md)
§ "Deliverables" — _Parent-disposal cascade_.

Phase 3 promises that `parent.dispose()` disposes every live child
first
(`packages/sandbox/src/factory.js#FactorySliceContext.children`
bookkeeping; verified by `packages/sandbox/test/fork.test.js`
"GC ordering" suite).  This sub-task verifies the genie root's
worker shutdown path and the daemon restart path do not leak
orphaned sub-slice scratch dirs.

- [ ] Audit the genie root's worker shutdown path
  ([`packages/genie/main.js`](../packages/genie/main.js)
  `runRootAgent` cancellation kit; sub-agent loop teardown via
  `cancelledP`) — ensure `dispose()` on `main-genie-sandbox`
  fires before the parent worker exits, so Phase 3's child
  cascade reaps each `<agentName>-sandbox` reliably.
- [ ] Audit the daemon restart path: a kill-and-restart cycle
  must reincarnate `main-genie-sandbox` (sub-task
  [`TADA/39_endo_genie_sandbox_gc_order.md`](../TADA/39_endo_genie_sandbox_gc_order.md))
  **and** every live `<agentName>-sandbox` in the same
  slice-before-worker order.
- [ ] Add a regression test that kills the root genie's worker
  process (or restarts the daemon) and asserts every sub-slice
  scratch directory is reaped (`fs.readdir(stateDir/sandbox)`
  should not list any `<agentName>-sandbox` whose parent is
  gone).
- [ ] If the cascade order needs a code change in the genie root
  (e.g. an explicit `dispose()` call before worker exit), file
  the smallest possible patch and link it from this TODO; the
  Phase 3 cascade itself is already proven by
  `packages/sandbox/test/fork.test.js`.

Depends on:
[`51_endo_genie_subagent_fork_slice.md`](./51_endo_genie_subagent_fork_slice.md).

Blocks:
[`59_endo_genie_subagent_tests.md`](./59_endo_genie_subagent_tests.md)
(the cascade regression assertion is part of that suite).
