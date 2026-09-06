# IronHorse architecture review: companion documents

Supporting material for [ARCHITECTURE-REVIEW.md](ARCHITECTURE-REVIEW.md),
the architecture review of the IronHorse engine (`rust/engine`) published
2026-09-06.

**Reviewed commit:
[`97d8de25`](https://github.com/endojs/endo-but-for-bots/commit/97d8de25)**
(`design+feat(test262): fixture consolidation and parameterized expectation
lists (rollout step 1) (#946)`).
Every line number and quotation in this directory refers to that commit.
Read a citation against `git show 97d8de25:<path>` rather than against the
current tree, which has moved on.

**Revised 2026-09-06 against
[`f109e8f4`](https://github.com/endojs/endo-but-for-bots/commit/f109e8f4).**
All 191 findings were re-verified against that commit: 10 are fixed, 11 are
partially fixed, and 170 still stand; 117 had their line numbers move.
The summary's [Revision history](ARCHITECTURE-REVIEW.md#revision-history)
records the outcome, each affected finding carries a Status line, and
Appendix A carries both the original and the refreshed location for every
finding.
The lens reports and region maps in this directory were **not** revised: they
are the reviewers' original artifacts and describe `97d8de25` only, so treat a
claim in them as current only if the summary's entry for that finding still
stands.

The review ran in three stages.
Region readers each mapped one part of the engine (the 44,942-line
`interp.rs` was split into sixteen regions) and recorded candidate findings.
Lens reviewers then read the whole engine along one architectural concern
each, verifying leads in code.
Every lens finding was then checked by two independent verifiers (a code-truth
refuter and a significance judge) with a tiebreaker on disagreement; only the
survivors appear in the summary.

These companion files are the readers' and reviewers' own reports, kept
verbatim as evidence.
Line numbers refer to the reviewed commit.

## Lens reports

- [api-boundaries-crate-layering](lenses/api-boundaries-crate-layering.md)
- [compiler-pipeline](lenses/compiler-pipeline.md)
- [design-drift-docs](lenses/design-drift-docs.md)
- [determinism-consensus](lenses/determinism-consensus.md)
- [error-model-exceptions](lenses/error-model-exceptions.md)
- [gc-roots-heap-integrity](lenses/gc-roots-heap-integrity.md)
- [metering-architecture](lenses/metering-architecture.md)
- [modularity-maintainability](lenses/modularity-maintainability.md)
- [performance-architecture](lenses/performance-architecture.md)
- [reentrancy-control-flow](lenses/reentrancy-control-flow.md)
- [robustness-untrusted-input](lenses/robustness-untrusted-input.md)
- [security-sandbox](lenses/security-sandbox.md)
- [snapshot-persistence-seam](lenses/snapshot-persistence-seam.md)
- [verification-strategy](lenses/verification-strategy.md)

## Region maps

- [compile-coder-a](maps/compile-coder-a.md)
- [compile-coder-b](maps/compile-coder-b.md)
- [compile-lexer](maps/compile-lexer.md)
- [compile-parser](maps/compile-parser.md)
- [compile-scoper](maps/compile-scoper.md)
- [docs-ci-process](maps/docs-ci-process.md)
- [fuzz](maps/fuzz.md)
- [integration-endo](maps/integration-endo.md)
- [interp-01-constants-natives-halt](maps/interp-01-constants-natives-halt.md)
- [interp-02-interp-struct-side-tables](maps/interp-02-interp-struct-side-tables.md)
- [interp-03-boot-intrinsics](maps/interp-03-boot-intrinsics.md)
- [interp-04-eval-relink-persistence-seam](maps/interp-04-eval-relink-persistence-seam.md)
- [interp-05-meter-run-render](maps/interp-05-meter-run-render.md)
- [interp-06-dispatch-loop](maps/interp-06-dispatch-loop.md)
- [interp-07-functions-generators-async](maps/interp-07-functions-generators-async.md)
- [interp-08-intl-date-promise-alloc](maps/interp-08-intl-date-promise-alloc.md)
- [interp-09-regexp-surface-promise-jobs-fromasync](maps/interp-09-regexp-surface-promise-jobs-fromasync.md)
- [interp-10-temporal](maps/interp-10-temporal.md)
- [interp-11-reflect-math-json-strings](maps/interp-11-reflect-math-json-strings.md)
- [interp-12-iterators-collections-typedarrays](maps/interp-12-iterators-collections-typedarrays.md)
- [interp-13-property-model-mop-proxy](maps/interp-13-property-model-mop-proxy.md)
- [interp-14-conversions-bigint](maps/interp-14-conversions-bigint.md)
- [interp-15-inline-tests-bigint-limbs](maps/interp-15-inline-tests-bigint-limbs.md)
- [interp-16-side-table-ref-pages](maps/interp-16-side-table-ref-pages.md)
- [regexp-engine](maps/regexp-engine.md)
- [snapshot-container-machine-ledger](maps/snapshot-container-machine-ledger.md)
- [snapshot-image-a](maps/snapshot-image-a.md)
- [snapshot-image-b](maps/snapshot-image-b.md)
- [snapshot-store-file-suite](maps/snapshot-store-file-suite.md)
- [snapshot-store](maps/snapshot-store.md)
- [snapshot-tests](maps/snapshot-tests.md)
- [store-seam-design-ledger](maps/store-seam-design-ledger.md)
- [t262-harness-core](maps/t262-harness-core.md)
- [t262-tooling-report](maps/t262-tooling-report.md)
- [vm-compartment-module-intl](maps/vm-compartment-module-intl.md)
- [vm-heap-gc](maps/vm-heap-gc.md)
- [vm-meter-opcode-tables](maps/vm-meter-opcode-tables.md)
- [vm-tests](maps/vm-tests.md)
- [xs-oracle-ffi](maps/xs-oracle-ffi.md)

