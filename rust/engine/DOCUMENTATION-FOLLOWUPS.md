# 1F documentation restructure: remaining work and ownership

This records deliberately uncompleted portions of 1F; it does not amend the
independently reverified architecture review.
The implementation audit is against `96db92e23`.
The current architecture and acceptance surfaces are linked from [README](README.md).

## Frozen interpreter comments — 1A

`ironhorse-vm/src/interp.rs` is unchanged by 1F.
Locate these constructs by name, not historical review line numbers:

- **F177, `Interp::stored_unpersistable_row`:** replace the rationale saying
  proxies/accessors do not travel and resumed guest functions are uncallable.
  `FUNC`, proxy and accessor representations already carry; the rationale must
  describe the actual unsupported-native and live-state admission rules.
  Preserve the optimized dirty-page scan and its validation invariants.
  `functions_carry.rs`, `proxy_carry.rs`, `accessor_carry.rs` and `persist_gates.rs`
  in the snapshot tests are the relevant behavior evidence.
- **F173, async implementation comments:** the old invocation-specific handoff
  is replaced by a small link redirect for historical references.
  Its current XS mechanism/GC map lives in
  [Architecture: async and generator roots](ARCHITECTURE.md#async-and-generator-roots).
  1A can place that map beside `step_async` and `await_schedule`, linking the
  executable `gc_visitation_registry.rs` and `gc_frame_state.rs` tests.
- **Determinism:** preserve `call_math`'s release-binary/platform qualification.
  Any future provider change must update it together with the public engine
  design, meter crate docs and W6 decision; digest identity alone is insufficient.

## Remaining implementation work outside documentation

- **F121:** `SlotArena::byte_size` still exposes legacy XS accounting, not real
  resident memory. Its comments and the design now say so. Renaming/removing the
  public API or adding a resident-memory instrument is not implemented here.
  A meaningful footprint instrument needs arena bookkeeping and side tables as
  well as `size_of::<Slot>()`; a 24-byte struct observation is not total heap usage.
- **F111:** C1 histogram/model tests now run with `cost-calibration` in CI.
  The disassembly firewall proof, feature-on/off corpus/snapshot equivalence,
  timing driver, normalization and calibration loop remain unimplemented.
  The instrumentation design labels those bars explicitly.
- **F104 safety scope:** the metadata check covers all eight non-oracle library
  roots. Some harness binary roots lack `forbid(unsafe_code)`; this documentation
  change neither asserts nor adds a workspace-wide binary/dependency unsafe ban.
- **Compatibility:** `versions.rs` documents all five identifiers and their
  consequences. It does not implement an Intl dependency identity gate or a
  cross-meter persisted-heap migration; those are explicit remaining obligations.

## Determinism coordination

1D was notified of the public wording and confirmed by its ongoing coverage work:
execution remains scoped per release binary per platform.
Its unmerged cross-platform measurements are not claimed as tests at 1F's audit tip.
No active 2E task was available during this pass; the handoff for that provider
work is W6 §4 and the required synchronized surfaces listed above.
Provider changes must not broaden the guarantee until their required coverage lands.

## Validation limitations

Local oracle-free documentation/carry tests, cost-calibration library tests,
Cargo formatting, generated-graph checks and Rust documentation build pass.
Rustdoc still emits existing warnings outside the corrected summaries.
After installing Yarn dependencies and cleaning generated declarations,
`yarn build:types` passes; `yarn docs` reports 102 errors in unchanged JavaScript
packages, including `claude-sandbox` and `endo-fs-asset-server`.
Root lint also reports errors in unchanged JavaScript packages, including
`claude-sandbox`, `familiar` and `hardened262`.
Those JavaScript failures are recorded here rather than repaired as part of 1F.
No XS oracle run is claimed by this documentation work.
