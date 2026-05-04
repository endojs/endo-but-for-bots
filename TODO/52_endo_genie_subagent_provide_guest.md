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

- [x] Drop the legacy `workspace-mount` introduction from
  `spawnAgent`'s `introducedNames` builder.
  Replaced the conditional `if (has(WORKSPACE_MOUNT_NAME)) {
  introducedNames[WORKSPACE_MOUNT_NAME] = 'workspace' }` builder
  with a hardened literal that no longer references
  `WORKSPACE_MOUNT_NAME` at all (the import remains for
  `runRootAgent`'s 3.5a slice-mint path).
- [x] Add the `<agentName>-sandbox` → `sandbox` introduction
  (parent-namespace key, child-namespace pet name).
  Implemented via `harden({ [sliceName]: 'sandbox', … })` in
  `packages/genie/main.js` `spawnAgent`, with `sliceName` sourced
  from the existing `subAgentSliceName(agentName)` helper.
- [x] Thread operator-granted extras (additional `Mount` caps,
  agent-specific bindings) through the same map.
  Added an optional 8th `introducedExtras` parameter to
  `spawnAgent` (`Record<string, string>`, undefined-safe) spread
  alongside the mandatory sub-slice introduction.  The `/spawn`
  builtin (sub-task 57) is the intended composer of this map —
  the dormant signature deliberately keeps it separate from
  `childSpec` so the operator-side surface can shape mount caps
  and pet-name introductions independently.
- [x] Idempotency: keep the existing
  `await E(hostAgent).has(agentName) ? lookup : provideGuest`
  guard so a daemon restart re-attaches the existing guest
  instead of re-minting.
  Preserved verbatim and annotated with a pointer to
  `packages/daemon/CLAUDE.md` § "provideGuest idempotency"
  explaining why re-passing `introducedNames` to a reincarnated
  guest fails.
- [ ] Document the introduction in `packages/genie/CLAUDE.md`
  § "Sub-agent spawning" (covered by sub-task
  [`60_endo_genie_subagent_docs.md`](./60_endo_genie_subagent_docs.md);
  this sub-task only owns the code).

## Implementation notes (2026-05-04)

- **Sub-slice pet-store pin bridge.**  `makePersistent` pins the
  live slice in the sandbox factory's internal `persistentSlices`
  keyspace and writes the resolved spec to disk, but the daemon's
  `introduceNamesToAgent` (`packages/daemon/src/host.js` ~line
  786) only resolves names out of the parent host's *pet store* —
  it has no awareness of the sandbox plugin's keyspace.  Without
  an explicit bridge, `introducedNames[`<agentName>-sandbox`] =
  'sandbox'` would silently no-op (the daemon's resolver returns
  early when `petStore.identifyLocal(parentName) === undefined`).
  This sub-task therefore adds an `await
  E(hostAgent).storeValue(subAgentSlice, sliceName)` call between
  the slice mint (sub-task 51) and the `provideGuest` call so the
  parent's pet store has the slice under the same flat
  `<agentName>-sandbox` name `makePersistent` recorded.
  Guarded with a `has(sliceName)` short-circuit so the
  marshal-value formula is not re-minted on restart.
  If `storeValue` rejects on a slice exo that lacks a backing
  formula (the failure mode shown by
  `packages/daemon/test/endo.test.js` 'fail to store non-formula
  exos'), it surfaces here verbatim — TADA/23 § "Follow-ups
  filed" should pick this up if it bites in practice (a candidate
  fix is to teach `SandboxFactory.makePersistent` to pin the
  resulting handle in the host pet store directly, eliminating
  the bridge in `spawnAgent`).
- **Restart shape.**  `makePersistent` re-mints the slice from
  the on-disk record on each daemon boot, producing a fresh live
  handle.  The marshal-value formula `storeValue` writes captures
  a CapTP-slot snapshot of the original handle; whether that
  snapshot survives the worker recycle is the same open question
  3.5a's persisted-slice path raises (see TODO/33's discussion of
  `makePersistent` parent-blindness on restart).  Sub-task 59's
  test plan should exercise the daemon-restart path explicitly so
  any latent breakage surfaces with a concrete reproducer.

Depends on:
[`51_endo_genie_subagent_fork_slice.md`](./51_endo_genie_subagent_fork_slice.md).

Blocks:
[`53_endo_genie_subagent_worker_boot.md`](./53_endo_genie_subagent_worker_boot.md),
[`54_endo_genie_subagent_directory.md`](./54_endo_genie_subagent_directory.md).
