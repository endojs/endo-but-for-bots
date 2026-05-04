# Genie sub-agent — `provideGuest` with sub-slice introduction

Sub-task of
[`TADA/23_endo_posix_sandbox_phase3_5b_genie_subagent.md`](../TADA/23_endo_posix_sandbox_phase3_5b_genie_subagent.md)
§ "Deliverables" — _Sub-agent identity, with the sub-slice in
`introducedNames`_.

After the sub-slice is pinned (sub-task
[`51_endo_genie_subagent_fork_slice.md`](./51_endo_genie_subagent_fork_slice.md)),
call:

```js
await E(parentHost).provideGuest(agentName, {
  introducedNames: harden({
    [`${agentName}-sandbox`]: 'sandbox',
    // … operator-granted extras
  }),
  agentName: `profile-for-${agentName}`,
});
```

The dormant `spawnAgent` helper at
[`packages/genie/main.js:1130`](../packages/genie/main.js)
already provisions the guest; this sub-task swaps its
`introducedNames` content from `{ 'workspace-mount': 'workspace' }`
to `{ '<agentName>-sandbox': 'sandbox' }`, mirroring how 3.5a's
root genie resolves `main-genie-sandbox` from `powers`
(see TADA/34 / `packages/genie/main.js` `runRootAgent`).

The previous `workspace-mount` introduction is **dropped** — the
sub-slice's mount view is the authoritative `/workspace`, exactly
as it is for the root genie.

For **scoped within parent** mode, optionally re-introduce the
parent's workspace mount as `'workspace'` in `introducedNames` if
the operator wants the child to see the host-side workspace path
the way 3.5a exposes `workspace-mount` to the root genie (the
slice mount is still the authoritative view; the host-mount
introduction is purely defence-in-depth for tools that today read
`workspace-mount` directly).

- [ ] Drop the legacy `workspace-mount` introduction from
  `spawnAgent`'s `introducedNames` builder.
- [ ] Add the `<agentName>-sandbox` → `sandbox` introduction
  (parent-namespace key, child-namespace pet name).
- [ ] Thread operator-granted extras (additional `Mount` caps,
  agent-specific bindings) through the same map.
- [ ] Idempotency: keep the existing
  `await E(hostAgent).has(agentName) ? lookup : provideGuest`
  guard so a daemon restart re-attaches the existing guest
  instead of re-minting.
- [ ] Document the introduction in `packages/genie/CLAUDE.md`
  § "Sub-agent spawning" (covered by sub-task
  [`60_endo_genie_subagent_docs.md`](./60_endo_genie_subagent_docs.md);
  this sub-task only owns the code).

Depends on:
[`51_endo_genie_subagent_fork_slice.md`](./51_endo_genie_subagent_fork_slice.md).

Blocks:
[`53_endo_genie_subagent_worker_boot.md`](./53_endo_genie_subagent_worker_boot.md),
[`54_endo_genie_subagent_directory.md`](./54_endo_genie_subagent_directory.md).
