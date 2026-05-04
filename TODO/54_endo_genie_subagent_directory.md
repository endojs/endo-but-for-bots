# Genie sub-agent — `agentDirectory` tracking

Sub-task of
[`TADA/23_endo_posix_sandbox_phase3_5b_genie_subagent.md`](../TADA/23_endo_posix_sandbox_phase3_5b_genie_subagent.md)
§ "Deliverables" — _`agentDirectory` tracking_.

Preserve the dormant helper's behaviour
([`packages/genie/main.js:1158-1173`](../packages/genie/main.js))
of recording the child's locator at
`<agentDirectory>/<agentName>` in the parent's pet namespace via:

```js
const agentDirName = config.agentDirectory ?? DEFAULT_AGENT_DIRECTORY;
if (!(await E(parentPowers).has(agentDirName))) {
  await E(parentPowers).makeDirectory(agentDirName);
}
const childLocator = await E(agentGuest).locate('@self');
await E(parentPowers).storeLocator(
  [agentDirName, agentName],
  childLocator,
);
```

Operators / sibling agents discover children via that path — no
bespoke registry.

Note the parallel to the slice-handle pin: locator lives in the
parent guest's pet store under `<agentDirectory>/<agentName>`;
slice handle lives in the sandbox plugin's daemon-state under
`<agentName>-sandbox` (TADA/23 Decision 2).
The two records coexist in their natural keyspaces;
`removeChildAgent` (sub-task
[`55_endo_genie_subagent_remove.md`](./55_endo_genie_subagent_remove.md))
clears both.

- [ ] Keep the existing `makeDirectory` / `storeLocator` calls
  intact in the revived `spawnAgent`.
- [ ] Resolve `parentPowers` from the dispatch context — for
  `/spawn` invoked from the root genie, `parentPowers` is the
  same `rootPowers` (`EndoHost`) the root resolved sandbox caps
  from; for nested sub-agents (a child spawning a grandchild),
  `parentPowers` is the child's `agentGuest`.
- [ ] Document the keyspace split in
  `packages/genie/CLAUDE.md` § "Sub-agent spawning"
  (handled by
  [`60_endo_genie_subagent_docs.md`](./60_endo_genie_subagent_docs.md)).

Depends on:
[`52_endo_genie_subagent_provide_guest.md`](./52_endo_genie_subagent_provide_guest.md).

Blocks:
[`55_endo_genie_subagent_remove.md`](./55_endo_genie_subagent_remove.md),
[`56_endo_genie_subagent_list.md`](./56_endo_genie_subagent_list.md).
