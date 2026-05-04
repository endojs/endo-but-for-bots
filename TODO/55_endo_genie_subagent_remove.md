# Genie sub-agent — `removeChildAgent` three-step teardown

Sub-task of
[`TADA/23_endo_posix_sandbox_phase3_5b_genie_subagent.md`](../TADA/23_endo_posix_sandbox_phase3_5b_genie_subagent.md)
§ "Deliverables" — _`removeChildAgent` — three-step teardown_.

The dormant helper at
[`packages/genie/main.js:1292-1304`](../packages/genie/main.js)
removes only the directory entry and the host-level guest
reference; 3.5b adds the sub-slice dispose **first** so a still-
running child cannot race the guest removal and resurrect itself
via its own pet store.

Tear down in this order:

1. `await E(sliceHandle).dispose()` — Phase 3's GC fires the
   cascade for any in-slice processes
   (`packages/sandbox/src/factory.js#disposeSlice`).
2. `await E(parentHost).remove(agentName)` — drops the host-level
   guest reference; daemon GC reaps the orphaned guest formula.
3. `await E(parentPowers).remove(agentDirName, agentName)` —
   clears the directory entry so future `listChildAgents` calls
   do not surface a tombstone.

The slice goes first so a still-running child cannot race the
guest removal and resurrect itself via its own pet store.

- [ ] Resolve the sub-slice handle (or its pet name
  `<agentName>-sandbox`) from the parent's sandbox-factory.
- [ ] Add the `dispose()` call as step 1 of the teardown.
- [ ] Keep the existing `remove(agentName)` and
  `remove(agentDirName, agentName)` calls as steps 2 and 3.
- [ ] Document the ordering in
  `packages/genie/CLAUDE.md` § "Sub-agent spawning"
  (handled by
  [`60_endo_genie_subagent_docs.md`](./60_endo_genie_subagent_docs.md)).
- [ ] Surface partial-failure modes (e.g. dispose throws but the
  guest still exists) with structured errors so
  `/remove-agent` can report them — defence-in-depth against
  half-failed teardowns.

Depends on:
[`51_endo_genie_subagent_fork_slice.md`](./51_endo_genie_subagent_fork_slice.md),
[`54_endo_genie_subagent_directory.md`](./54_endo_genie_subagent_directory.md).

Blocks:
[`57_endo_genie_subagent_specials.md`](./57_endo_genie_subagent_specials.md),
[`59_endo_genie_subagent_tests.md`](./59_endo_genie_subagent_tests.md).
