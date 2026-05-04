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

- [x] Wire `await E(parentSlice).fork(childSpec)` into the revived
  `spawnAgent` body.
- [x] Persist via
  `await E(sandboxFactory).makePersistent(\`${agentName}-sandbox\`,
  childSpec)` so daemon restart re-mints the sub-slice from the
  same spec.
- [x] Surface Phase 3 attenuation errors with the offending
  `mount` / `network` / `ro→rw` reason intact for the dispatcher
  layer to format.
- [x] Centralise the slice pet-name pattern as
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

## Status

- 2026-05-04: Wiring landed in
  [`packages/genie/main.js`](../packages/genie/main.js)
  `spawnAgent` and
  [`packages/genie/src/pet-names.js`](../packages/genie/src/pet-names.js).

  **Pet-name helper.**
  `subAgentSliceName(agentName) → \`${agentName}-sandbox\`` is
  exported from `pet-names.js` alongside the existing
  `SANDBOX_SLICE_NAME` (root genie's slice).  Both the
  `spawnAgent` mint path and the `removeChildAgent` teardown
  reference the helper so a future rename only edits one site.
  `removeChildAgent`'s sub-task 55 dispose call lands in the
  follow-up; 51 only seeds the `void subAgentSliceName(childName)`
  reference so the helper has a reachable call site at both
  ends of the lifecycle.

  **`spawnAgent` signature change.**
  The dormant helper grew three parameters threaded through ahead
  of `parentPowers`: `parentSliceHandle`, `sandboxFactory`, and
  `childSpec`.  The new shape mirrors what TADA/23 Decision 1's
  `/spawn` builtin will pass — `hostAgent`, `parentSliceHandle`,
  `sandboxFactory`, `agentName`, `config`, `childSpec`,
  `parentPowers` — so sub-task 57's dispatcher wiring can hand
  them through unchanged.  The helper has no live callers yet
  (still gated on sub-tasks 52–58); `harden(spawnAgent)` keeps the
  module-level binding alive for lint.

  **Mint sequence.**
  At the top of `spawnAgent`, before any guest provisioning:

  1. `subAgentSlice = await E(parentSliceHandle).fork(childSpec)`
     — Phase 3's `validateAndResolveChildMounts` runs here; mount
     drops / `rw → ro` downgrades / sub-path scopes (scoped-within-
     parent mode) and freshly-granted standalone `Mount` caps
     (wholly-separate mode) are accepted, while attempts to grant
     a `Mount` the parent does not have, upgrade `ro → rw`, or
     broaden the network beyond the parent's profile reject with
     structured `makeError(X\`fork: …\`)` throws that propagate
     verbatim.
  2. `await E(sandboxFactory).makePersistent(sliceName, childSpec)`
     — TADA/33's on-disk record of the resolved spec, keyed by
     `<agentName>-sandbox`.  Errors are caught and the
     fork-derived `subAgentSlice` is `dispose()`'d before
     re-throwing so a half-failed mint does not leak a live
     sub-slice.

  The fork-derived handle (`subAgentSlice`) is the live slice we
  will keep using in sub-tasks 52–54 (introducedNames + worker
  boot + directory tracking); the makePersistent-returned handle
  is a parallel mint with no parent linkage in the current
  plumbing and is discarded.  The `void subAgentSlice;` keeps lint
  / ts-check quiet until sub-task 52 wires the binding into the
  child's `introducedNames`.

  **Error-surface contract.**
  `fork()` and `makePersistent()` rejections both propagate to the
  caller without re-wrapping — TADA/23 Decision 1's `/spawn`
  builtin (sub-task 57) is the chokepoint that converts a
  structured `makeError(X\`fork: …\`)` into operator-friendly
  text.  Wrapping here would smear the `mount` / `network` /
  `ro → rw` reason the Phase 3 plumbing carefully attaches.

  **Residual / follow-up known limitations.**
  - The `forkSlice` body in
    `packages/sandbox/src/factory.js` is still the
    `throw makeError(X\`fork not implemented before Phase 3\`)`
    stub.  This sub-task ships the consumer-side wiring; the
    structured rejection will be exercised once the Phase 3
    `forkSlice` body lands.  Tests that exercise the spawn path
    (sub-task 59) will assert against a stable error shape — the
    structured `fork: …` text is the contract.
  - `makePersistent` does not currently accept a parent slice
    handle, so the on-disk record is parent-blind.  On daemon
    restart the sub-slice would re-mint as a top-level slice,
    losing the parent linkage.  A parent-aware `makePersistent`
    extension is filed as a follow-up under TADA/23 § "Follow-ups
    filed"; until then, the parent slice (`main-genie-sandbox`)
    reincarnates first via its own `makePersistent`, and the
    parent's restart path is responsible for re-establishing
    linkage with each child's `<agentName>-sandbox`.

  **Validation.**
  - `node --check packages/genie/main.js` and
    `node --check packages/genie/src/pet-names.js` both pass.
  - `npx corepack yarn workspace @endo/genie lint` reports zero
    new errors / warnings on `main.js` or `pet-names.js`
    (pre-existing errors in unrelated files unchanged).
  - `npx tsc -p packages/genie/tsconfig.json --noEmit` reports no
    new errors on `main.js` (the pre-existing `factory
    .makePersistent` and async-return-type warnings in
    `runRootAgent` and the primordial activate kit are
    unchanged).
  - `npx ava test/loop/builtin-specials.test.js
    test/primordial/persistence.test.js` — 34/34 passing.
