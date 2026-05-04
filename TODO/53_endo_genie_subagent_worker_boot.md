# Genie sub-agent — worker boot via daemon `makeUnconfined`

Sub-task of
[`TADA/23_endo_posix_sandbox_phase3_5b_genie_subagent.md`](../TADA/23_endo_posix_sandbox_phase3_5b_genie_subagent.md)
§ "Deliverables" — _Sub-agent worker boot via daemon
`makeUnconfined`_.

After `provideGuest` (sub-task
[`52_endo_genie_subagent_provide_guest.md`](./52_endo_genie_subagent_provide_guest.md)),
materialise the child's worker the same way TADA/22's root genie
does:

```js
await E(agentGuest).makeUnconfined('@main', genieSpecifier, {
  powersName: '@agent',
  resultName: 'main-genie',
  env: childEnv,
});
```

Per TADA/23 Decision 3 the child's Node worker stays on the host
(parity with TADA/22 Decision 2); the sub-slice confines the
child's tool spawns only.
The "worker inside sub-slice" variant is filed as a follow-up
parallel to
[`TADA/24_endo_posix_sandbox_phase3_5a_worker_inside_slice.md`](../TADA/24_endo_posix_sandbox_phase3_5a_worker_inside_slice.md)
and lands once 24's transport-across-namespace question resolves
for the root genie.

The child's `env` mirrors `setup.js`'s `GENIE_*` forwarding table
with two child-specific tweaks:
- `GENIE_NAME` defaults to the child's `agentName` rather than
  `main-genie`;
- `GENIE_WORKSPACE` is the **slice-internal** path (`/workspace`)
  — the child resolves the `sandbox` introduction from `powers`
  and routes its tool spawns through it, so the host-path /
  slice-path duality TADA/22 documents in
  `packages/genie/CLAUDE.md` § "Boot shape — Host vs slice
  GENIE_WORKSPACE" applies recursively.

`resultName: 'main-genie'` is preserved so the child's exo pin is
locally resolvable from the agent's own pet store, even though
the parent reaches the child via its locator (sub-task
[`54_endo_genie_subagent_directory.md`](./54_endo_genie_subagent_directory.md)).

- [ ] Replace the dormant `spawnAgent`'s in-process
  `makeGenieAgents` + `runAgentLoop` body with a
  `E(agentGuest).makeUnconfined('@main', genieSpecifier, …)` call
  matching the root-genie launch shape.
- [ ] Forward `GENIE_MODEL` / `GENIE_HEARTBEAT_PERIOD` /
  `GENIE_HEARTBEAT_TIMEOUT` / `GENIE_OBSERVER_MODEL` /
  `GENIE_REFLECTOR_MODEL` / `GENIE_AGENT_DIRECTORY` from the
  parent's `config` to the child's `env`.
- [ ] Default the child's `GENIE_NAME` to `agentName` and
  `GENIE_WORKSPACE` to `'/workspace'`.
- [ ] Keep the dormant `spawnAgent`'s in-process bookkeeping
  (workspace-init, heartbeat ticker, side-channel maps) **out**
  of the parent's process — those concerns now run inside the
  child's worker via its own `runRootAgent`.

Depends on:
[`52_endo_genie_subagent_provide_guest.md`](./52_endo_genie_subagent_provide_guest.md).

Blocks:
[`57_endo_genie_subagent_specials.md`](./57_endo_genie_subagent_specials.md),
[`59_endo_genie_subagent_tests.md`](./59_endo_genie_subagent_tests.md).
