# Verification ledger

This is the single place that states what the Ironhorse engine has *proved*,
over which inputs, and on what it relies.
The rationale and the planned catalogue are in
[designs/ironhorse-formal-verification.md](../../designs/ironhorse-formal-verification.md).
The table at the end is generated from
[`verification/proofs.toml`](verification/proofs.toml); the runner keeps the two in step.

## What "verified" means here

A guarantee marked proved is a Kani bounded-model-checking result, and nothing more:

- **Source level.** Kani checks the Rust source as its own compiler front end
  lowers it, not the machine code rustc emits for a shipped build.
  Code generation and the platform are outside the claim.
- **Kani's model of Rust.** Integers are bit-precise.
  Rust's overflow, shift and division panics are checked (they are MIR
  assertions), as are `debug_assert!`s: Kani builds with debug assertions on.
  Floats follow CBMC's IEEE 754 encoding, which is known to be wrong for some
  operations (rule R1 below).
- **64-bit `usize`.** Kani targets `x86_64-unknown-linux-gnu`; a claim about
  `usize` arithmetic says nothing about `wasm32`.
- **Stated bounds.** Each harness states its exact input domain, its unwind
  bound, its `kani::assume`s and its flags.
  "Proved" never appears without them: read the Domain column, not just the
  Claim.
  Every meter harness is unbounded over its stated domain (no loops, no unwind).

## Trusted base

A proof shows "the code satisfies the harness's assertions for every input in
its domain".
That is the guarantee only if all of these are right:

1. **Kani 0.68.0 and CBMC 6.11 with CaDiCaL** are sound for the constructs
   used.
   They are known not to be for float `%`, `rem_euclid`, `powi` and `powf`
   (measured; see the KANI-1 canaries).
   An upgrade is a deliberate PR: bump `kani_version` in the manifest (the
   runner refuses a mismatch), re-run every tier, the canaries and the mutants.
2. **The `ironhorse-spec` models** match the ECMA-262 text they quote.
   They are integer-only, short, cite their clause, depend on no engine crate,
   and carry known-answer and platform-differential tests.
   No Phase 0 guarantee uses them yet; they are the reference for the
   numeric guarantees that follow.
3. **The harnesses** state the intended property.
   Three rules check them mechanically: every harness has a satisfied
   `kani::cover!`, harness code has no unreachable check, and each guarantee
   has mutants that a harness must kill.
4. **`scripts/verify.py`** reads Kani's output correctly.
   Its parser and rules are unit-tested on captured Kani output
   (`scripts/test-verify.py`), and `verify.py selftest` runs deliberately bad
   harnesses that it must reject.

## Soundness rules

The runner enforces these; a violation fails `verify.py run` like a counterexample.

- **R1. No proof may depend on float `%`, `rem_euclid`, `powi` or `powf`.**
  Kani 0.68 lowers float `%` to CBMC's `floatbv_mod`, which evaluates to 0, and
  it gives no warning: Kani proves `3.0 % 2.0 == 0.0`.
  `rem_euclid` is built on `%`; `powi` and `powf` are wrong too.
  There is no static reachability check: the rule is enforced by review, by
  writing kernels and models in integer arithmetic, and by the KANI-1 canaries
  in `ironhorse-spec/src/kani_canaries.rs` (the one proof module where these
  operations may appear).
  Each canary asserts the wrong value Kani computes today and so passes; when a
  Kani upgrade fixes the encoding, the canary fails and the rule is revisited
  by a human.
  Integer `%` and `rem_euclid` are unaffected.
- **R2. `--no-overflow-checks` only with a reason.**
  The flag removes CBMC's NaN and float-overflow instrumentation, not Rust's
  own overflow panics.
  Only a float harness may use it, and its manifest entry must say why
  (`flags_reason`). No Phase 0 harness uses any flag.
- **R3. Vacuity is a failure.**
  Kani exits 0 and says SUCCESSFUL for an unsatisfiable cover and for a
  contradictory `assume`, and reports an out-of-memory or timed-out solver as
  a failed harness with no failed check.
  So the runner reads `--export-json` (the only format with a status per check
  and the function each check lives in; SARIF lists failures only) and fails:
  - a harness without a `kani::cover!`, or with any cover not SATISFIED;
  - any UNREACHABLE check in harness code (the harness's own module);
  - a library UNREACHABLE count different from the manifest's `unreachable`
    (pinned with a reason; measured: every Phase 0 harness has 0);
  - any UNDETERMINED check, a harness with no checks, a missing result, an
    `exit_status` other than `properties_failed` (timeout, CBMC exit code 6
    for out of memory), or a `cargo kani` exit other than 0 or 1;
  - a result that differs from the manifest's `expect` (KANI-2 expects its
    false assertion to fail);
  - a disagreement between the JSON and the regular text verdict.
- **R4. Every guarantee survives a seeded mutant.**
  Each guarantee lists one-line semantic mutants in
  `verification/mutants/<ID>-<x>.patch`.
  `verify.py mutants` applies each to a scratch copy of the workspace sources
  (`target/verify-mutants/tree`, removed afterwards), builds it into its own
  target directory (`target/verify-mutants/target`: Cargo keys a workspace
  member by its workspace-relative path, so sharing the main target directory
  would let mutated artifacts pass as fresh in a later real run), and requires at least one
  referencing harness to fail with a counterexample.
  A surviving mutant, a resource failure instead of a counterexample, or a
  patch that no longer applies is an error.
- **R5. Bounds are part of the claim.** See "What verified means" above.
- **Manifest and tree agree.** `verify.py check` compares `cargo kani list`
  with the manifest per crate; an unlisted or stale harness fails.
- **Budgets.** Each harness has a time and memory budget, measured here.
  A harness over 1.5x its time warns; over 2x fails.
  Memory is the peak RSS of the largest process in each `cargo kani` batch,
  checked against the batch's largest budget.
  Every `cargo kani` process tree runs under an address-space cap
  (`--memory-cap-gb`, default 8).

## Running

Kani is not a Cargo dependency.
Install it once (the version must match `kani_version` in the manifest):

```sh
cargo install --locked kani-verifier@0.68.0
cargo kani setup
```

Then, from the repository root:

```sh
python3 rust/engine/scripts/verify.py check          # fast: manifest, tree, mutants apply, ledger
python3 rust/engine/scripts/verify.py run --tier pr   # the pull-request tier
python3 rust/engine/scripts/verify.py run --tier all --id MTR-3
python3 rust/engine/scripts/verify.py mutants         # every mutant must be killed
python3 rust/engine/scripts/verify.py selftest        # the runner rejects bad harnesses
python3 rust/engine/scripts/verify.py ledger          # regenerate the table below
python3 rust/engine/scripts/test-verify.py           # runner unit tests, no Kani needed
```

Kani builds into `rust/engine/target/kani`; logs and `--export-json` files land
in `rust/engine/target/kani/verify-logs`.
CI runs `check` and `run --tier pr` on pull requests; the scheduled
`ironhorse-kani-nightly.yml` workflow runs `run --tier all`, `mutants` and
`selftest`.

## Adding a proof

1. Put the harness in a `#[cfg(kani)] mod proofs` next to the code, named for
   its guarantee (`mtr3_...`).
   Give it at least one `kani::cover!` naming a non-trivial case, and state
   every `kani::assume` as a precondition the code really has.
2. Add a `[[harness]]` entry to `verification/proofs.toml` (and a
   `[[guarantee]]` if the ID is new) with its statement, exact domain, unwind,
   flags, budgets and mutants.
3. Write at least one mutant per guarantee: a one-line semantic change, as a
   unified diff relative to `rust/engine`, with a one-line description first.
   Check that `verify.py mutants --id <ID>` kills it.
4. Run `verify.py run --tier all --id <ID>`, set the budgets from the measured
   times, and regenerate the ledger.

## Guarantees

<!-- BEGIN GENERATED: scripts/verify.py ledger -->

Generated from `verification/proofs.toml` by `scripts/verify.py ledger`; do not edit by hand. Pinned Kani: 0.68.0.

| ID | Guarantee | Claim | Spec | Trusted base | Harnesses | Mutants |
|---|---|---|---|---|---|---|
| MTR-1 | No panic from any restored meter state | For every MeterState a snapshot can carry and every argument, no meter operation panics (with overflow-checks on, as in release); refunds are proved under their pairing precondition index >= n. | ironhorse-fuzz snapshot_decoder.rs: from_snapshot_bytes "must NEVER panic, hang, or allocate unboundedly"; Cargo.toml: "Guest-influenced arithmetic must not silently wrap in shipped builds." | Kani 0.68 / CBMC 6.11, the harnesses | 13 (pr) | `MTR-1-a`, `MTR-1-b` |
| MTR-2 | Charging fails closed | Ticks saturate exactly at u64::MAX; an unrepresentable admission is refused with index unchanged; index = u64::MAX is absorbing: no guest-driven operation leaves it and every check or admission from it refuses, armed or not. | ironhorse-vm/src/meter.rs Meter::charge_and_check: "An unrepresentable total fails closed, even when checks are disabled; wrapping it would let guest work erase its accrued cost." | Kani 0.68 / CBMC 6.11, the harnesses | 4 (pr) | `MTR-1-a`, `MTR-1-b`, `MTR-2-a`, `MTR-2-b`, `MTR-2-c` |
| MTR-3 | Limit enforcement cannot be bypassed | Armed, not exhausted and index > count: the host is consulted exactly once with computrons(); false gives Abort; Continue leaves count > index; an approved check whose next deadline is unrepresentable aborts (execution) or saturates the deadline (compilation). Un-armed meters never consult the host. | ironhorse-vm/src/meter.rs Meter::check: "if metering is armed and the index passed the threshold, consult host"; Meter::is_armed / interval: "Zero disables checks". | Kani 0.68 / CBMC 6.11, the harnesses | 2 (pr) | `MTR-3-a`, `MTR-3-b`, `MTR-6-a` |
| MTR-4 | Unit relations | computrons() = index >> 16; scale_interval(i) = min(i * 2^16, u64::MAX) and is nonzero iff i is; chunk_cost and string_chunk_cost equal their fxAdjustChunkSize formulas where representable and saturate otherwise. | ironhorse-vm/src/meter.rs scale_interval: "Saturating keeps a non-zero interval non-zero, so the armed/un-armed distinction is never flipped by arithmetic."; Meter::tick_chunk_new: round_up_8(size) + 16; ironhorse-meter chunk_cost / string_chunk_cost. | Kani 0.68 / CBMC 6.11, the harnesses | 3 (pr) | `MTR-4-a`, `MTR-4-b`, `MTR-4-c` |
| MTR-5 | State and restore round trip | restore(s); state() == s for every s, and last_reported feeds no computation, so leaving it out of MeterState is sound. | ironhorse-vm/src/meter.rs Meter::restore: "last_reported is re-seeded from index for diagnostics; it feeds no computation." | Kani 0.68 / CBMC 6.11, the harnesses | 2 (pr) | `MTR-5-a`, `MTR-5-b` |
| MTR-6 | Monotone index, with its exact exceptions | No guest-driven operation decreases index (checks never move it); a paired refund returns it to its value before the paired tick, or leaves it at u64::MAX if the tick exhausted the meter. begin and restore are the only other writers. | ironhorse-vm/src/meter.rs Meter::charge_and_check: "would let guest work erase its accrued cost"; Meter::check_compilation: "Compilation receipts require a monotone accumulated index". | Kani 0.68 / CBMC 6.11, the harnesses | 1 (pr) | `MTR-6-a`, `MTR-6-b` |
| KANI-1 | Canary: Kani's float %, rem_euclid, powi and powf are wrong | Each canary asserts the wrong value Kani 0.68 computes and so passes; a fix makes it fail, which forces review of rule R1 (no proof may depend on these operations). | IEEE 754-2019 remainder/pow semantics as computed by rustc (true values in the harness comments). | Kani 0.68 / CBMC 6.11 | 4 (pr) | none (canary) |
| KANI-2 | Canary: the runner detects a failed check | A deliberately false assertion is reported as a failure; the manifest expects failure, so a runner that misses failures goes red. | scripts/verify.py rule: a harness whose result differs from expect fails the run. | Kani 0.68 / CBMC 6.11, scripts/verify.py | 1 (pr) | none (canary) |

| ID | Harness | Tier | Statement | Domain | Unwind | Flags | Budget | Lib. unreachable | Expect |
|---|---|---|---|---|---|---|---|---|---|
| MTR-1 | `ironhorse-vm` `meter::proofs::mtr1_tick_code` | pr | tick_code does not panic. | every MeterState (index, interval, count: all u64 triples) | 0 | default | 5 s / 1 GB | 0 | pass |
| MTR-1 | `ironhorse-vm` `meter::proofs::mtr1_tick_code_n` | pr | tick_code_n(n) does not panic. | every MeterState (index, interval, count: all u64 triples); every n: u64 | 0 | default | 5 s / 1 GB | 0 | pass |
| MTR-1 | `ironhorse-vm` `meter::proofs::mtr1_tick_builtin` | pr | tick_builtin does not panic. | every MeterState (index, interval, count: all u64 triples) | 0 | default | 5 s / 1 GB | 0 | pass |
| MTR-1 | `ironhorse-vm` `meter::proofs::mtr1_tick_builtin_some` | pr | tick_builtin_some(k) does not panic. | every MeterState (index, interval, count: all u64 triples); every k: u64 | 0 | default | 5 s / 1 GB | 0 | pass |
| MTR-1 | `ironhorse-vm` `meter::proofs::mtr1_tick_slot_alloc` | pr | tick_slot_alloc does not panic. | every MeterState (index, interval, count: all u64 triples) | 0 | default | 5 s / 1 GB | 0 | pass |
| MTR-1 | `ironhorse-vm` `meter::proofs::mtr1_tick_chunk_alloc` | pr | tick_chunk_alloc(size) does not panic. | every MeterState (index, interval, count: all u64 triples); every size: u64 | 0 | default | 5 s / 1 GB | 0 | pass |
| MTR-1 | `ironhorse-vm` `meter::proofs::mtr1_tick_chunk_new_and_string` | pr | tick_chunk_new(size) and tick_string(units) do not panic. | every MeterState (index, interval, count: all u64 triples); every argument: u64 | 0 | default | 5 s / 1 GB | 0 | pass |
| MTR-1 | `ironhorse-vm` `meter::proofs::mtr1_tick_raw` | pr | tick_raw(n) does not panic. | every MeterState (index, interval, count: all u64 triples); every n: u64 | 0 | default | 5 s / 1 GB | 0 | pass |
| MTR-1 | `ironhorse-vm` `meter::proofs::mtr1_untick_code` | pr | untick_code does not panic when it refunds a prior tick. | every MeterState (index, interval, count: all u64 triples) with index >= CODE_METERING (the pairing precondition) | 0 | default | 5 s / 1 GB | 0 | pass |
| MTR-1 | `ironhorse-vm` `meter::proofs::mtr1_untick_raw` | pr | untick_raw(n) does not panic when it refunds a prior tick. | every MeterState (index, interval, count: all u64 triples); every n: u64 with index >= n (the pairing precondition) | 0 | default | 5 s / 1 GB | 0 | pass |
| MTR-1 | `ironhorse-vm` `meter::proofs::mtr1_checks_and_charges` | pr | check, check_compilation, charge_and_check(n) and charge_compilation(n, Some/None) do not panic. | every MeterState (index, interval, count: all u64 triples); every n: u64; host answer: any bool | 0 | default | 5 s / 1 GB | 3 | pass |
| MTR-1 | `ironhorse-vm` `meter::proofs::mtr1_configuration` | pr | begin(i) and rearm(i), then state, computrons, is_armed and interval_raw, do not panic. | every MeterState (index, interval, count: all u64 triples); every i: u64 | 0 | default | 5 s / 1 GB | 0 | pass |
| MTR-1 | `ironhorse-vm` `meter::proofs::mtr1_sequence_of_four` | pr | Any sequence of four guest-driven operations (ticks, paired refunds, checks, charges, computrons) does not panic. | every MeterState (index, interval, count: all u64 triples); four ops, each with any u64 argument; host answer: any bool, fixed per run | 5 | default | 9 s / 1 GB | 1 | pass |
| MTR-2 | `ironhorse-vm` `meter::proofs::mtr2_ticks_saturate_exactly` | pr | Every tick_* leaves index = min(index + exact cost, u64::MAX), the exact cost computed in u128. | every MeterState (index, interval, count: all u64 triples); every tick op and u64 argument | 0 | default | 5 s / 1 GB | 3 | pass |
| MTR-2 | `ironhorse-vm` `meter::proofs::mtr2_charge_and_check_fails_closed` | pr | charge_and_check(n): an unrepresentable total aborts with index unchanged and no host call; a total of exactly u64::MAX aborts at u64::MAX; otherwise index = index + n. | every MeterState (index, interval, count: all u64 triples); every n: u64; host answer: any bool | 0 | default | 5 s / 1 GB | 0 | pass |
| MTR-2 | `ironhorse-vm` `meter::proofs::mtr2_charge_compilation_fails_closed` | pr | charge_compilation(n, host): an unrepresentable total is refused with index unchanged; a total of exactly u64::MAX is refused at u64::MAX; otherwise index = index + n. | every MeterState (index, interval, count: all u64 triples); every n: u64; host Some(any bool) or None | 0 | default | 5 s / 1 GB | 0 | pass |
| MTR-2 | `ironhorse-vm` `meter::proofs::mtr2_exhausted_is_absorbing` | pr | From index = u64::MAX, every guest-driven operation leaves index = u64::MAX, consults no host, and every check or admission refuses, armed or not. | every MeterState (index, interval, count: all u64 triples) with index = u64::MAX; every op and u64 argument | 0 | default | 5 s / 1 GB | 2 | pass |
| MTR-3 | `ironhorse-vm` `meter::proofs::mtr3_check_consults_the_host_when_due` | pr | check and check_compilation: exhausted aborts without the host; else if armed and index > count the host is consulted exactly once with index >> 16, false gives Abort, Continue implies count > index, and Abort after approval only on the execution path with index + interval unrepresentable; else no host call, Continue, state unchanged; index never changes. | every MeterState (index, interval, count: all u64 triples); host answer: any bool | 0 | default | 5 s / 1 GB | 0 | pass |
| MTR-3 | `ironhorse-vm` `meter::proofs::mtr3_unarmed_never_consults` | pr | An un-armed meter (interval = 0) never consults the host in check, check_compilation, charge_and_check or charge_compilation. | every MeterState (index, interval, count: all u64 triples) with interval = 0; every u64 argument | 0 | default | 5 s / 1 GB | 5 | pass |
| MTR-4 | `ironhorse-vm` `meter::proofs::mtr4_computrons_and_interval_scaling` | pr | computrons() = index >> 16; scale_interval(i) = min(i * 2^16, u64::MAX), nonzero iff i is; begin(i) arms iff i != 0. | every MeterState (index, interval, count: all u64 triples); every i: u64 | 0 | default | 5 s / 1 GB | 0 | pass |
| MTR-5 | `ironhorse-vm` `meter::proofs::mtr5_restore_state_round_trip` | pr | restore(s) then state() returns s exactly, whatever the meter held before. | every MeterState s; any prior tick_raw | 0 | default | 5 s / 1 GB | 0 | pass |
| MTR-5 | `ironhorse-vm` `meter::proofs::mtr5_last_reported_feeds_nothing` | pr | Two meters differing only in last_reported give equal outcomes, states and host consultations for every guest-driven operation. | every MeterState (index, interval, count: all u64 triples); any last_reported; every op and u64 argument; host answer: any bool | 0 | default | 18 s / 1 GB | 0 | pass |
| MTR-6 | `ironhorse-vm` `meter::proofs::mtr6_index_is_monotone` | pr | No guest-driven operation decreases index; a paired tick then refund returns it exactly when the tick did not reach u64::MAX (and to u64::MAX otherwise); a check never moves it. | every MeterState (index, interval, count: all u64 triples); every op and u64 argument; host answer: any bool | 0 | default | 5 s / 1 GB | 0 | pass |
| MTR-4 | `ironhorse-meter` `proofs::mtr4_chunk_cost_formula` | pr | chunk_cost(b) = min((round_up_8(b) + 16) * CHUNK_ALLOCATION_METERING, u64::MAX), computed in u128. | every b: u64 | 0 | default | 5 s / 1 GB | 0 | pass |
| MTR-4 | `ironhorse-meter` `proofs::mtr4_string_chunk_cost_formula` | pr | string_chunk_cost(u) = min((round_up_8(u + 1) + 16) * CHUNK_ALLOCATION_METERING, u64::MAX), computed in u128. | every u: u64 | 0 | default | 5 s / 1 GB | 0 | pass |
| KANI-1 | `ironhorse-spec` `kani_canaries::float_rem_is_miscomputed` | pr | Kani evaluates 3.0 % 2.0 to 0.0 (true value 1.0). | the single pinned input | 0 | default | 5 s / 1 GB | 0 | pass (canary) |
| KANI-1 | `ironhorse-spec` `kani_canaries::float_rem_euclid_is_miscomputed` | pr | Kani evaluates (-3.0).rem_euclid(2.0) to 0.0 (true value 1.0). | the single pinned input | 0 | default | 5 s / 1 GB | 0 | pass (canary) |
| KANI-1 | `ironhorse-spec` `kani_canaries::float_powi_is_miscomputed` | pr | Kani evaluates 3.0.powi(2) to something other than 9.0 (true value 9.0). | the single pinned input | 0 | default | 5 s / 1 GB | 0 | pass (canary) |
| KANI-1 | `ironhorse-spec` `kani_canaries::float_powf_is_miscomputed` | pr | Kani evaluates 3.0.powf(2.0) to something other than 9.0 (true value 9.0). | the single pinned input | 0 | default | 5 s / 1 GB | 0 | pass (canary) |
| KANI-2 | `ironhorse-spec` `kani_canaries::false_assertion_is_reported` | pr | A deliberately false assertion (x != 7 for any u8 x) is reported as a failure. | every x: u8 | 0 | default | 5 s / 1 GB | 0 | fail (canary) |

<!-- END GENERATED: scripts/verify.py ledger -->
