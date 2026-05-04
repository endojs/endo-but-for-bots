# Genie sub-agent — `/spawn`, `/agents`, `/remove-agent` specials

Sub-task of
[`TADA/23_endo_posix_sandbox_phase3_5b_genie_subagent.md`](../TADA/23_endo_posix_sandbox_phase3_5b_genie_subagent.md)
§ "Deliverables" — _`/spawn`, `/agents`, `/remove-agent` specials_.

Per TADA/23 Decision 1, the spawn surface lives in the specials
dispatcher, not as a CapTP method on the genie exo.  Add three
handlers to `makeBuiltinSpecials`
([`packages/genie/src/loop/builtin-specials.js`](../packages/genie/src/loop/builtin-specials.js))
and mount them in `makeSpecialsDispatcher`'s `handlers` map at
[`packages/genie/main.js:733`](../packages/genie/main.js).

Builtins:

- `/spawn <name> [--mode=scoped|separate]
  [--mount=<petname>:<innerPath>:<mode>]…
  [--network=<profile>] [--model=<spec>]` —
  invokes the shared `spawnSubAgent(hostAgent,
  parentSliceHandle, parentPowers, name, opts)` helper extracted
  from the dormant `spawnAgent`, surfacing `fork()`'s structured
  errors as friendly text.
- `/agents` (or `/list-agents`) — invokes the shared
  `listSubAgents(parentPowers, config)` helper, prints one line
  per child (name, slice state, guest pet name).
- `/remove-agent <name>` — invokes
  `removeSubAgent(parentHost, parentPowers, sliceHandle, name)`,
  prints a confirmation or the structured error.

- [ ] Update `makeBuiltinSpecials`'s factory signature to take
  `hostAgent` and `parentSliceHandle` (both already in scope at
  the dispatcher construction site, lines 720-726 of `main.js`).
- [ ] Propagate the new builtins through `formatHelpLines` so
  `/help` lists `/spawn`, `/agents`, `/remove-agent` alongside
  `/model`, `/observe`, `/reflect`.
- [ ] Argument parsing: a small shared parser for
  `--mode` / `--mount` / `--network` / `--model` is preferable
  to ad-hoc string splitting; it must reject unknown flags with
  a clean error rather than passing them through.
- [ ] Friendly error formatting: catch Phase 3's structured
  `makeError(X\`fork: …\`)` rejections (sub-task
  [`51_endo_genie_subagent_fork_slice.md`](./51_endo_genie_subagent_fork_slice.md))
  and print the `mount` / `network` / `ro→rw` reason rather
  than raw CapTP rejections.
- [ ] Surface partial-failure tombstones from
  `/remove-agent` (see sub-task
  [`55_endo_genie_subagent_remove.md`](./55_endo_genie_subagent_remove.md)).
- [ ] **CapTP method as follow-up**: TADA/23 Decision 1 records
  that a `genie.spawnSubAgent` method on `GenieInterface` may be
  added later as a thin wrapper over the shared helper if a
  programmatic caller materialises.  Not required for v1; keep
  the helper's signature stable so the wrapper is mechanical.

Depends on:
[`53_endo_genie_subagent_worker_boot.md`](./53_endo_genie_subagent_worker_boot.md),
[`55_endo_genie_subagent_remove.md`](./55_endo_genie_subagent_remove.md),
[`56_endo_genie_subagent_list.md`](./56_endo_genie_subagent_list.md).

Blocks:
[`59_endo_genie_subagent_tests.md`](./59_endo_genie_subagent_tests.md).
