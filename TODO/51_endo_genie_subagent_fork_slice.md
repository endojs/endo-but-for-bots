# Genie sub-agent — sub-slice mint via `fork()`

Sub-task of
[`TADA/23_endo_posix_sandbox_phase3_5b_genie_subagent.md`](../TADA/23_endo_posix_sandbox_phase3_5b_genie_subagent.md)
§ "Deliverables" — _Sub-slice mint via `fork()`, pinned at
`<agentName>-sandbox`_.

The revived `spawnAgent` body in
[`packages/genie/main.js`](../packages/genie/main.js) (~lines
1130–1280) calls `await E(parentSlice).fork(childSpec)` first to
mint a sub-slice from the root genie's `main-genie-sandbox`, then
pins it as `<agentName>-sandbox` via the same
`SandboxFactory.makePersistent(name, …)` formula sub-task
[`TADA/33_endo_genie_sandbox_persist_slice.md`](../TADA/33_endo_genie_sandbox_persist_slice.md)
settles on.

`childSpec` carries the operator-supplied attenuation:
- mount drops / `rw → ro` downgrades / sub-path scopes for **scoped
  within parent** mode — Phase 3's `validateAndResolveChildMounts`
  (`packages/sandbox/src/factory.js`) accepts these as-is;
- newly-granted standalone `Mount` caps for **wholly separate**
  mode — supplied as extra `mounts[]` entries.

The Phase 3 plumbing rejects unsupported attenuations (a `Mount`
cap the parent does not have; `ro → rw` upgrade; network
broadening) with structured `makeError(X\`fork: …\`)` throws.
Sub-task
[`57_endo_genie_subagent_specials.md`](./57_endo_genie_subagent_specials.md)
must surface those as friendly operator-facing responses, not raw
CapTP rejections.

- [ ] Wire `await E(parentSlice).fork(childSpec)` into the revived
  `spawnAgent` body.
- [ ] Persist via
  `await E(sandboxFactory).makePersistent(\`${agentName}-sandbox\`,
  childSpec)` so daemon restart re-mints the sub-slice from the
  same spec.
- [ ] Surface Phase 3 attenuation errors with the offending
  `mount` / `network` / `ro→rw` reason intact for the dispatcher
  layer to format.
- [ ] Centralise the slice pet-name pattern as
  `subAgentSliceName(agentName)` in `pet-names.js` so the helper
  and the `removeChildAgent` teardown share one source of truth
  (TADA/23 Decision 2 — flat `<agentName>-sandbox` keyspace).

Depends on:
- TADA/22 deliverables landing (specifically TADA/33 — slice
  formula — and TADA/34 — root slice handle resolvable from the
  parent's `powers`).
- Phase 3 nesting plumbing
  ([`TADA/21_endo_posix_sandbox_phase3_nesting.md`](../TADA/21_endo_posix_sandbox_phase3_nesting.md))
  is fully landed (`forkSlice` exists in
  `packages/sandbox/src/factory.js`).

Blocks:
[`52_endo_genie_subagent_provide_guest.md`](./52_endo_genie_subagent_provide_guest.md),
[`58_endo_genie_subagent_dispose_cascade.md`](./58_endo_genie_subagent_dispose_cascade.md).
