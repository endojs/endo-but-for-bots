# Phase 1 determinism coverage and build hygiene

Branch: `codex/ironhorse-1d-determinism`, from `bots/llm` at `96db92e23`.
This implementation record does not revise the architecture review.
The governing coverage requirements are in
[W6 §4](../../designs/ironhorse-w6-decisions.md#4-determinism-scope--decided-vendor-libm-behind-a-feature).

## C5 measurement first

The first commit, `b1a116f33`, measures the current guest Math implementation without XS,
features, or a provider change.
[CI run 34300102648](https://github.com/endojs/endo-but-for-bots/actions/runs/34300102648)
retains the `math-test-ironhorse`, `math-test-ironhorse-release`, and
`math-test-ironhorse-macos` artifacts.
Each record contains the function, argument IEEE-754 words, and output word.
DataView transports bits in an explicit byte order, avoiding decimal result rendering.

The Linux debug/release and macOS debug artifacts differ in 31 cases across 11 functions:
`atan`, `atanh`, `cbrt`, `cosh`, `expm1`, `log1p`, `log10`, `sinh`, `tan`, `tanh`, and `hypot`.
Every measured difference is one ULP.
The four exact controls (`abs`, `ceil`, `floor`, `sqrt`) agree.
Local macOS debug and release vectors also agree exactly.
The Linux debug/release vectors agree exactly; the same-profile Linux/macOS comparison
reproduces all 31 differences.

The user approved pinning these measured differences while rejecting new drift.
The [baseline](ironhorse-vm/tests/fixtures/math-platform-differences.tsv) pins both output
words for every differing input; an unchanged ULP distance with shifted output words fails.
New, removed, or changed differences fail and require an explicit baseline review.
The comparator retains the full measured difference report even on failure.
Exact controls cannot be excepted, and debug/release comparisons permit no differences.
This is evidence of current platform scope, not cross-platform execution determinism.

## Coverage inventory and remaining Phase 2 work

- **C1:** 22 nontrivial bit-exact known answers, selected from results verified on both
  C5 platforms, plus the four exact controls in the same oracle-free test file.
- **C2:** expected answers must be pairwise distinct.
  At each function's chosen input, the test executes all other 21 functions and rejects
  any result equal to the chosen answer, including binary/n-ary neighbours.
  This checks the same-input rule, not only distinct answers at unrelated inputs.
- **C3:** 522 bit-exact boundary observations, including all seven required boundary
  inputs for every function, binary special-value cross-products, and domain edges.
  Explicit assertions independently cover canonical NaN, signed zero, and the named
  domain rules.
  These observations expose two correctness gaps: `acosh(MAX)` and `asinh(MAX)` overflow
  to infinity in the current provider, while their results should be finite.
  `large_inverse_hyperbolics_have_finite_known_answers` is explicitly ignored pending
  Phase 2 and can be run with `--ignored` to reproduce the failure.
  The boundary fixture labels these as current defects, not correct answers.
  **C3 correctness is not complete.**
- **C4:** not executed: there is no selectable guest provider yet.
  Adding that dispatch belongs to Phase 2 because `interp.rs` is frozen.
  The same input/bit transport and ULP reporting are reusable for that comparison.
  The observed one-ULP *platform* bound is not asserted to be a provider bound.
  Phase 2 must measure and check in its provider bound and artifact, and enforce exact
  agreement for spec-mandated values before selecting a new default.
  MAX/subnormal arguments do not make every transcendental output spec-mandated exact;
  the boundary fixture distinguishes observations from mathematical guarantees.
- **C6:** `transcendental-branch` is the 52nd runtime computron vector.
  `sin(0.7)` controls whether a loop executes, coupling result bits to raw and whole costs.
  Re-pin deliberately if a provider changes that result.
- **C7:** no default is flipped here.
  Before Phase 2 flips it, the 30 XS transcendental corpus cases need an explicit decision:
  rebuild XS against the same provider or maintain an expected-divergence list.
  This work does not silently exempt those oracle cases.

The new tests are in `ironhorse-vm/tests/` and run on Linux debug/release and macOS.
The architecture review and `interp.rs` are unchanged.

## Findings and build graph

**F079:** decimal long division replaces unbounded `u128` accumulation and multiplication.
Only a bounded remainder uses machine arithmetic; magnitude stays in decimal digits.
The original fractional remainder participates in rounding, avoiding double rounding.
Tests exercise all nine rounding modes, both signs, odd/even increments, large integers,
and carry/borrow at `f64::MAX`, in debug and release.
This implements correct formatting rather than replacing the panic with a wrong value.

**F062:** still open under the Phase 1 freeze.
Compact notation is admitted in the NumberFormat constructor in `interp.rs`.
Its construction-time named refusal cannot be implemented in `intl_number.rs`, whose
formatting interface returns values and does not own the interpreter halt boundary.
No late panic or wrong formatted value is substituted for that refusal.

**F050:** XS cost differences are advisory in both legacy fuzz comparators.
The symbol-linked families share the existing armed/unarmed consistency check.
A pure comparison module is tested without XS and retains semantic failures while
reporting cost gaps as data.
Two additional real-execution XS equality gates in the error tests were removed;
exception-rendering metering is checked against VM work variation instead.
Engine-versioned corpus pins and frozen computron vectors remain acceptance gates.
Full XS-dependent compilation and execution are validated by the oracle CI lane.

**F161:** `test-ironhorse-calibration` tests the feature-enabled library and frozen
computron vectors, and separately tests the `consensus` configuration.
The two features together produce a compile error that CI checks explicitly.
The Endo and Thixotrope worker manifests select `consensus`.
This enforces the feature-unification boundary; it is not an object-code performance proof.

**F070/F083 recount:** there are still 50 shared crate names, including six local
IronHorse crates (44 shared external names).
The five differing version sets are `cc`, `shlex`, `foldhash`, `hashbrown`, and `hashlink`.
None differs in the shared IronHorse dependency closure; the existing lockfile graph
checker and its tests pass.
Unrelated root-workspace major versions are retained rather than forcing dependency
upgrades outside this work unit.
The root worker builds with its lockfile and the consensus feature.
The wider F070 residue (engine-owned tests under the root workspace resolution) and
F083's hand-stamped Intl data version are not claimed closed.
Cargo refuses to test these excluded path dependencies with their dev dependencies as
non-members of the root workspace; changing workspace structure is separate work.

## Validation

Local macOS debug/release Math, Intl rounding, host-rendering meter, and golden tests pass.
The calibration-enabled library has 191 passing tests.
The same golden costs pass with calibration and with consensus enabled separately.
The conflicting feature pair fails with the expected compile error.
The root Thixotrope worker builds with `--locked`.
Rust 1.88 formatting and focused Clippy checks pass; Rust 1.91 Clippy additionally flags
an existing `manual_is_multiple_of` warning in frozen `interp.rs`.
Each implementation commit receives an adversarial subagent review and a recheck of fixes.
