# Ironhorse: formal verification of named guarantees

| | |
|---|---|
| **Created** | 2026-11-19 |
| **Author** | kumavis (prompted) |
| **Status** | In Progress |

## Status

At Created, none of this has been implemented.
Phase 0 starts as soon as this document lands.
No Kani harness, `ironhorse-spec` crate, manifest, runner or ledger exists in the tree yet.
The measurements cited below come from a feasibility spike.
It ran Kani 0.68 with CBMC 6.11 in a throwaway worktree at `a4155de9`, and that worktree has
since been removed.
None of its harnesses were committed.
Each phase updates this section and the ledger (`rust/engine/VERIFICATION.md`) as it lands.

## What is the Problem Being Solved?

Ironhorse is a safe-Rust JavaScript engine.
`forbid(unsafe_code)` removes memory-safety bugs, but logic bugs remain.
In the engine design's words, they "surface as deterministic panics, which the supervisor
already treats as worker death"
([ironhorse-engine § Memory-safety
confidence](ironhorse-engine.md#memory-safety-confidence-requirement-3)).
Silent wrong answers also remain, and those are worse.
Today the evidence of correct behaviour is sampled:

- test262 cases;
- the result-differential oracle against XS;
- cargo-fuzz targets;
- unit and golden tests.

Each of these checks the inputs someone or something thought to try.
None of them can say "for every input".
A wrong rounding at one binary16 boundary, a ToInt32 that mis-reduces only above 2^63, or a meter
that panics only from a crafted snapshot can each pass all four layers indefinitely.

The user's framing sets the scope:

- ECMA-262 is the specification, not XS.
- The whole language is too large a target for verification.
- So verification should establish a set of guarantees of correct behaviour, and be ambitious
  about it.

This design covers where verification applies (a catalogue of small kernels), what is claimed
(named guarantees with exact bounds), and how the claims are kept meaningful (soundness and
anti-vacuity rules that a runner enforces).

The groundwork has already found two confirmed defects (by spike harness), one
contract-contradicting behaviour and one probable defect (by survey reading), listed in
[§ Defects already found](#defects-already-found).

## Evidence base and how to read the numbers

This document draws on two reports and marks every factual claim with its source:

- **The survey** read the code to find verification targets, citing path and line.
  It ran nothing.
  Its feasibility ratings and costs are **estimated**.
- **The spike** ran Kani 0.68 / CBMC 6.11 against this codebase on a 4-core, 15 GB machine.
  The machine was heavily loaded the whole time: load average 7 to 11, with two other agents
  sharing the RAM.
  Its times are **measured**, and the spike itself calls them pessimistic.
  Times are solver times unless the text says wall or compile.

The three labels are used strictly:

- **measured** means the spike ran it;
- **estimated** means the survey or this design projects it;
- **decided** means the project manager or this design chose it.

A guarantee is never called "verified" until its harness is in the tree, listed in the manifest,
and green under the runner's rules.

## What "the spec" means here

Every guarantee is checked against one of two kinds of specification.
Each catalogue entry says which kind it uses.

1. **ECMA-262** is the spec for language-visible behaviour.
   The engine is a transliteration of XS, but XS is not the spec.
   Using XS as the reference would make the proof compare the port to its own source, and a
   shared mistake would cancel out.
   Whole-language conformance stays where it is: test262 and differential fuzzing.
   Formal verification adds something neither of those can provide.
   It takes small kernels with crisp mathematical specifications and covers all inputs, or all
   inputs up to a stated bound.
2. **The engine's own written contract** is the spec where ECMA-262 says nothing:
   - metering;
   - snapshot framing and canonical encodings;
   - arena invariants;
   - bytecode framing.

   These contracts already exist as sentences in the code and in design documents.
   This design quotes each one in the catalogue instead of paraphrasing it.
   A proof against a contract establishes that the code does what it says it does.
   It does not establish that the contract is the right one.
   A contract that turns out wrong is a design defect, handled like any other design defect.

ECMA-262 clause numbers below follow the survey, which uses ECMA-262 2025 (16th edition)
numbering.
Phase 0 pins one edition, the one that matches the vendored test262 tree, in `ironhorse-spec`'s
crate documentation, and re-checks every clause number against it.
Some existing code comments do not match that numbering.
For example, `value.rs` `to_int32` says "7.1.5", but in that edition ToInt32 is §7.1.6.

## Relationship to existing assurance layers

| Layer | What it can show | What it cannot show |
|---|---|---|
| `forbid(unsafe_code)` | No spatial or temporal memory errors in engine crates (compiler-checked) | Absence of panics, wrong results or overflow |
| Result-differential oracle (XS) | Ironhorse agrees with XS on the programs run | Agreement with ECMA-262 where XS is wrong; inputs not generated |
| test262 | Conformance on the cases written by the committee | Any input not in a case; engine-internal contracts |
| cargo-fuzz targets | No panic, hang or divergence on the inputs explored | Absence of a failing input; exhaustiveness at any size |
| Golden computron vectors | Frozen meter charges for the covered programs | Meter behaviour from states the corpus does not reach |
| ASAN/UBSAN (C oracle only) | Memory errors in XS and the shim C | Anything about the Rust engine |
| **This design: Kani proofs** | A named property for **all** inputs in a stated domain, under Kani's model of Rust | Properties outside the kernel; compiled artefact behaviour; tool soundness beyond the trusted base |
| **This design: Bolero / exhaustive** | The same named property against the same model, sampled (Bolero) or complete (exhaustive, domain ≤ 2^21) | Completeness for sampled properties |

Verification complements these layers and replaces none of them.
The guarantees cover the kernels where a wrong answer is silent and guest-reachable, which is
exactly where sampled testing is weakest.

## Tool choice

**Decided: Kani 0.68.0 with CBMC 6.11, pinned.**

Proofs live in the crate they verify, as `#[cfg(kani)] mod proofs` beside the code.
The spike found this works without a separate proofs crate:

`ironhorse-vm`, ICU data included, compiles under kani-compiler with no ICEs and no feature gates
(measured): 43 s cold (30 s with `--only-codegen`) and 19 s warm after touching the crate.
`ironhorse-snapshot` takes 21 s once the VM is built; the leaf crates take 1 to 3 s.

Each `cargo kani` invocation on the VM spends about 15 s on codegen and linking, even when the
solver needs 0.05 s.
That cost is not shared across invocations with different `--harness` filters.
Batching amortises it: all 11 meter harnesses in one invocation took 20 s, against 17 s for one
harness alone (measured).
The runner therefore groups harnesses per crate behind a module-path substring filter.

In-crate placement matters because almost every numeric kernel is `pub(super)` or private.
A separate crate would have to widen those visibilities, which changes the API to suit the tool.
The cost of in-crate placement is proof code in production source files.
It is compiled only under `cfg(kani)`, and the workspace adds
`unexpected_cfgs = { level = "warn", check-cfg = ['cfg(kani)'] }` to `[workspace.lints.rust]` so
that ordinary builds accept the cfg.

**Unbounded proofs** use Kani function contracts (`-Z function-contracts`) and loop contracts
(`-Z loop-contracts`).
The spike measured both:

- A `requires`/`ensures` contract on a bounded multi-limb add verified in 13.8 s.
  It needed `#[kani::modifies(a)]`.
- A caller using the contract through `#[kani::stub_verified]` verified in 0.33 s.
- A loop invariant over a `kani::vec::any_vec::<u32, 1024>` of any length up to 1024 verified in
  91 s, using 2.25 GB.
  It needed `#[kani::loop_modifies(&i, &carry, &*a)]` and the crate-root
  `#![cfg_attr(kani, feature(stmt_expr_attributes, proc_macro_hygiene))]`.
  The empty slice failed spuriously and needed `assume(!a.is_empty())`.

The loop-contract result is inductive in the loop, but the generator still bounds the input
length.
The ledger records it as "≤ 1024 limbs, by loop invariant", never as "unbounded".

**Companion: Bolero 0.13.x** (the spike tested 0.13.7, which pulls in `bolero-kani` 0.13.2 under
`cfg(kani)`).
It covers properties Kani cannot decide here ([§ What Kani cannot do](#what-kani-cannot-do-here)).
A harness written as `#[test] #[cfg_attr(kani, kani::proof)]` around `bolero::check!()` runs as a
`cargo test` property test.
Where it is cheap enough, the same harness runs as a Kani proof.
The spike confirmed this mechanically: a `[u16; 3]` property passed about 1 s of fuzzing under
`cargo test`, and compiled and ran under `cargo kani --tests`.
That same property ran out of solver memory under Kani, just as the native harness did.
Bolero buys one harness for two engines; it does not make proofs cheaper.
Bolero is a dev-dependency only, so it goes through the existing `cargo-deny` policy and adds
nothing to the shipped graph.

**Toolchain note.**
Kani builds with its own nightly toolchain, not the engine's pinned 1.91.1.
Proof code may use nightly features under `cfg(kani)`; production code may not.
Proofs reason about the MIR of that nightly front end, not about the 1.91.1 LLVM output that
ships (see [§ Non-goals](#non-goals)).

**Miri stays out.**
The engine design replaced the earlier unimplemented Miri gate (W0 amendment F034).
Miri is required only if `unsafe` is ever introduced into an engine crate.
Miri detects undefined behaviour in `unsafe` code, and there is none here.

## Reference models: `ironhorse-spec`

**Decided:** a new workspace member, `rust/engine/ironhorse-spec`.
It has zero dependencies, carries `#![forbid(unsafe_code)]`, and opts in with
`[lints] workspace = true` (`scripts/test-crate-graph.py` asserts both).
Each public function transliterates one ECMA-262 abstract operation, or one quoted engine
contract, using mathematical-integer arithmetic.
Every model follows these rules:

- **No floats.** A Number enters as its IEEE-754 bit pattern (`u64`).
  The model decomposes it into sign, biased exponent and significand, and computes in `u128` or
  `i128`.
  Where the spec needs an exact real result, the model represents it as a scaled integer or an
  exact rational.
  This removes Kani's float encoding, and its measured float bugs, from the trusted base.
- **Spec text in the doc comment.** Each function's doc comment names the clause and quotes the
  algorithm steps it implements, so a reviewer can check the code against the spec line by line.
- **Small enough to review.** Most models are 10 to 40 lines.
  A model too long to check by eye against its clause is split into smaller models.
- **Known-answer tests in ordinary `cargo test`.** The vectors are:
  - the spec's own worked values (e.g., the NaN/±0/±∞ steps);
  - boundary values from the test262 files that exercise the operation, each cited by path;
  - hand-derived boundaries (2^31, 2^32, 2^53, 2^63, subnormal edges, round-half-even ties).
- **Independent of the implementation.** `ironhorse-spec` never depends on engine code, and no
  model is copied from the kernel it judges.
  Review of each model compares it to the spec text, not to the implementation.

The engine crates take `ironhorse-spec` as a `[target.'cfg(kani)'.dependencies]` entry, the same
mechanism Bolero uses for `bolero-kani`, and as a dev-dependency for the Bolero and exhaustive
tests.
It never enters the shipped dependency graph.
Phase 0 confirms that `cfg(kani)` target dependencies resolve under `cargo kani`.

The spike's `ref_to_int32` and `ref_f64_to_f16` are the template.
Here is the ToInt32 model in this style:

```rust
/// ECMA-262 §7.1.6 ToInt32 ( argument ), steps 1-5, for a Number given by its bits.
/// 1. Let number be ? ToNumber(argument). (The caller supplies a Number.)
/// 2. If number is not finite or number is either +0𝔽 or -0𝔽, return +0𝔽.
/// 3. Let int be truncate(ℝ(number)).
/// 4. Let int32bit be int modulo 2^32.
/// 5. If int32bit ≥ 2^31, return 𝔽(int32bit - 2^32); otherwise return 𝔽(int32bit).
pub fn to_int32(bits: u64) -> i32 {
    let negative = bits >> 63 == 1;
    let exponent = ((bits >> 52) & 0x7FF) as i32;
    if exponent == 0x7FF || exponent == 0 {
        return 0; // NaN, ±∞ (step 2); ±0 and subnormals truncate to 0 (step 3).
    }
    let significand = ((bits & ((1 << 52) - 1)) | (1 << 52)) as u128;
    let shift = exponent - 1075; // value = significand · 2^shift
    let magnitude = if shift >= 32 {
        0 // a multiple of 2^32 (step 4)
    } else if shift >= 0 {
        (significand << shift) as u32
    } else if shift <= -64 {
        0
    } else {
        (significand >> -shift) as u32 // truncation toward zero (step 3)
    };
    (if negative { magnitude.wrapping_neg() } else { magnitude }) as i32 // steps 4-5
}
```

### Who verifies the verifier

A proof shows `kernel == model` over the stated domain.
For the guarantee to hold, the following must also be right.
Together they are the **trusted base**, and the ledger lists them for every guarantee:

1. **The model matches the spec.**
   This is checked by review against the quoted clause, by known-answer vectors, and by keeping
   the model independent of the kernel.
   The residual risk is a common-mode misreading: the model's author and the kernel's author
   misread the spec the same way.
   Independence reduces this risk but does not remove it.
   The known-answer vectors from test262 are the external check, because the committee wrote
   them, not us.
2. **The harness states the right property.**
   Its `assume`s, bounds and assertions are code too.
   Three rules check them: covers must be satisfied, a seeded mutant must be rejected, and the
   bounds are recorded with the claim
   ([§ Soundness and anti-vacuity rules](#soundness-and-anti-vacuity-rules)).
3. **Kani and CBMC are sound for the constructs used.**
   They are known not to be for some float operations (measured).
   The canaries and the integer-only rule bound this risk.
   Bugs not yet known remain a residual risk.
   Writing the models in integer arithmetic keeps the model side clear of the float encoding.
4. **The runner reads Kani's output correctly.**
   Kani reports vacuity and solver failure misleadingly (measured), so the runner has self-test
   fixtures that must be rejected.

## Soundness and anti-vacuity rules

These rules separate a meaningful proof from a green checkmark.
The runner enforces every one of them mechanically, and a rule violation fails the job just as
a counterexample would.

### R1. No proof depends on miscomputed float operations

**Measured:** Kani 0.68 lowers f64/f32 `%` to CBMC's `floatbv_mod`, and that evaluates to 0.
Kani "proves" `3.0 % 2.0 == 0` and `2.0 % 8.0 != 2.0`, with no warning.
`rem_euclid` is built on `%`, so it is wrong too.
`powi` and `powf` are also wrong: Kani proves `3.0.powi(2) != 9.0`.
Plain rustc computes all of these correctly.
The effect on this codebase is direct.
Run as written, `to_int32` "failed" in 0.56 s on input bits `0x4000000000000000` (2.0), a
spurious counterexample caused by `rem_euclid`.
The Mod arm of `apply_arith` likewise "failed" in 0.6 s.

The rule:

- No harness may reach f64/f32 `%`, `rem_euclid`, `powi` or `powf`.
  Integer `%` and `rem_euclid` are unaffected and allowed: `date_from_components_exact`'s
  `i128::rem_euclid` is fine.
- A kernel that uses these operations is rewritten to integer-only bit arithmetic before it is
  verified.
  The rewrite must be behaviour-identical on all inputs, and the proof against the model is what
  establishes that.
  It is benchmarked under
  [§ Performance and metering discipline](#performance-and-metering-discipline).
- Stubbing is not an acceptable substitute in a ledger claim.
  The spike verified `to_int32` for all 2^64 inputs by stubbing `rem_euclid` with an exact
  bit-level version: cadical 12 s, kissat 14.3 s, minisat 15.5 s.
  But that result was conditional on the stub being right.
  A stub may appear in an exploratory harness, never in a guarantee.

The rewrite also consolidates code.
The survey found five separate ToIntN implementations:

- `value.rs` `to_int32`, via `rem_euclid(2^32)`;
- `interp/numeric.rs` `number_to_u64_wrapping`, which branches on 2^63;
- the `to_wrapped` closure in `interp.rs` `encode_element_le`, via `2f64.powi(bits).rem_euclid`;
- the ToUint32 inlined into `natives/regexp.rs` `string_split_limit`;
- the ToUint16 in `natives/string.rs` `call_string_static` (`String.fromCharCode`).

All five are replaced by one integer-only kernel, `number_to_u64_wrapping(bits)`, which computes
the integer part modulo 2^64, plus narrowing wrappers.
The survey found about eight copies of relative-index clamping, and those become one helper the
same way.

**Canaries.**
A harness group in `ironhorse-spec` (`#[cfg(kani)] mod canaries`) asserts the currently observed
wrong results: `3.0 % 2.0 == 0.0`, `(2.0f64).rem_euclid(8.0) == 0.0`, and
`3.0f64.powi(2) != 9.0`.
Each is marked `canary = true` in the manifest with its expected status, `SUCCESS`.
The runner fails if a canary's status changes in either direction.
A Kani upgrade that fixes the bug therefore cannot silently re-admit float `%` into proofs.
Lifting R1 then takes a deliberate PR that retires the canary and amends this rule.

### R2. `--no-overflow-checks` only where needed, and what it means

By default, Kani's CBMC instrumentation fails any float operation that can produce NaN
("NaN on addition").
In JavaScript, NaN is a legitimate result, so float harnesses need `--no-overflow-checks`.
**Measured:** that flag removes only CBMC's own NaN and arithmetic-overflow instrumentation.
Rust's overflow, shift and division-by-zero panics are MIR assertions, and they remain checked.
So a float harness still catches integer-overflow panics in the kernel.
It no longer reports NaN production, and it no longer reports CBMC-level float overflow to
infinity, which in JavaScript is also legitimate.
The manifest allows the flag only on a harness whose kernel performs float arithmetic, and the
entry must give the reason.
Integer-only harnesses, which after R1 cover most numeric guarantees, run with default checks.

### R3. Vacuity is a failure

**Measured:** Kani exits 0 and reports SUCCESSFUL in both of these cases:

- An unsatisfiable `kani::cover!`.
  Kani prints "0 of 1 cover properties satisfied", and the check's status is `UNSATISFIABLE`.
- A contradictory `kani::assume`.
  Kani prints "(1 unreachable)".

A harness whose assumptions exclude every input "proves" anything.
The rules:

- **Witnesses.** Every harness carries at least one `kani::cover!` naming an interesting case.
  Examples: "an input at or above 2^63", "a tie that rounds to even", "a record the decoder
  accepts", "a parse yielding two or more atoms".
  The runner fails on any unsatisfied cover.
- **Harness assertions reachable.** The runner fails if any assertion or cover written in the
  harness body is `UNREACHABLE`.
- **Library unreachable counts pinned.** Unreachable checks inside library code, such as dead
  panic branches on paths the harness legitimately excludes, are expected.
  Their count per harness is pinned in the manifest (`unreachable = N`), so a change in either
  direction fails and must be explained.
  This refines a stricter rule, "fail on any unreachable check".
  The spike did not measure how many such checks real harnesses produce, and Phase 0 measures
  it before the count rule is final.
- **Solver errors fail as errors.** **Measured:** a solver out-of-memory shows up as a FAILED
  run with "0 of N failed" and `Status: ERROR`, or as a kani-driver panic while parsing CBMC's
  output.
  It never shows up as a clear OOM message.
  The runner treats any of the following as failure, reported as a resource failure separately
  from a counterexample:
  - a non-`SUCCESS` harness status;
  - any driver exit code other than 0 or 1 (101 is a compile error);
  - a missing per-harness result.
- **Manifest and tree agree.** The runner runs `cargo kani list --format json` from each crate
  directory.
  It must pass every `-Z` flag the harnesses need, because `list` takes no `-p` and otherwise
  fails to compile (measured).
  The run fails if a harness exists in the tree but not in the manifest, or the reverse.
  A harness nobody runs is not evidence.

**Runner self-test.**
`rust/engine/verification/selftest/` is a small crate outside the workspace.
It holds deliberately bad harnesses: an unsatisfiable cover, a contradictory assume, a harness
missing from its own manifest, and a harness that exhausts a deliberately tiny memory cap.
The runner's test suite requires the runner to reject each one, for the reason expected.

### R4. Every guarantee survives a seeded mutant

Each guarantee records at least one **mutant**.
A mutant is a one-line semantic change to the kernel, stored as a patch under
`rust/engine/verification/mutants/<ID>-<n>.patch`.
Examples:

- round ties away from zero instead of to even;
- drop the -0 branch;
- clamp to `len - 1`;
- accept pad byte 9.

A scheduled job applies each mutant in a scratch worktree and runs that guarantee's harnesses.
It requires each one to **fail** with a counterexample, not with a resource error.
A proof that survives its own mutant is treated as a failed proof, and the guarantee is
withdrawn from the ledger until the harness is fixed.
This catches harnesses that do not exercise the kernel they claim to cover, for example because
a bound excludes the changed branch.

### R5. Bounds are part of the claim

Every guarantee states:

- its exact input domain, e.g. "all 2^64 `u64` bit patterns" or "`buf.len() ≤ 48`";
- its unwind bounds;
- every `assume`;
- the flags it runs with;
- the trusted-base items it depends on.

The word "verified" never appears without these, either in this document or in the ledger.
A guarantee proved only up to a bound says so in its name in the ledger, e.g. "SNAP-1a (len ≤
48)".

## What Kani cannot do here

The spike found these limits.
Each property below is covered instead by Bolero property tests against the same
`ironhorse-spec` models, or by exhaustive tests where the domain is at most 2^21 (or 2^16).
The catalogue lists each as **tested, not proved**.

| Limit | Measured evidence | Replacement |
|---|---|---|
| General f64 multiplication and division | `*` commutativity timed out at 400 s; `a/a == 1` and `/` on i32 operands timed out at 400 s; `apply_arith` Mul and Div timed out at 900 s on both cadical and kissat | Decomposition where possible (NUM-3); otherwise Bolero against the model |
| Float `%` | Miscomputed (R1); Mod cannot be stubbed because it is an operator | Integer path proved directly against the spec model; Number path Bolero-tested against the model (NUM-3) |
| `Vec`-heavy text round trips | `SymbolName` full round trip: `[u16; 1]` verified in 109 s at 4.3 GB; `[u16; 2]` died near a 9.5 GB cap; `[u16; 3]` and `from_cesu8` on 4 or 8 bytes failed with solver `ERROR` (OOM) | Exhaustive over single units and code points; Bolero over sequences (TXT-1) |
| Symbolic allocation sizes | Atom writer round trip with symbolic payload lengths used 11 GB at one atom | Concrete lengths, symbolic contents (SNAP-1) |
| Number↔string conversion | Uses `format!("{:e}")`, `String` and dtoa (survey); not attempted | Bolero round trip `ToNumber(ToString(x)) == x` (out of catalogue scope; see [§ Examined and rejected](#examined-and-rejected)) |
| Atom parse above 48 bytes | N=64 was inconclusive at a 7 GB cap | Bounded claim at N=48; cargo-fuzz beyond |

A "tested, not proved" entry stays meaningful under three rules:

- it checks the same model as a proof would;
- Bolero runs as part of ordinary `cargo test`;
- its seeded mutant must be caught, by the test this time.

## Guarantee catalogue

Each entry gives:

- **Kernel:** path, relative to `rust/engine/`, and function.
  Line numbers are omitted on purpose, because the tree is being reformatted.
- **Claim:** the precise statement.
- **Spec:** an ECMA-262 clause, or the engine contract it quotes.
- **Method:** one of:
  - *Kani all-inputs*: every value of the stated type;
  - *Kani bounded*: bounds stated;
  - *Kani contract*: loop or function contracts;
  - *Bolero*;
  - *exhaustive*.
- **Refactor:** the change required first, if any.
- **Cost:** measured or estimated, and the tier (`pr` gates pull requests, `nightly` is
  scheduled).
- **Mutant:** the seeded change the proof must reject.

### Numeric kernels

**NUM-1. ToIntN family.**
- Kernel: a new integer-only `number_to_u64_wrapping(bits)` in `ironhorse-vm/src/interp/numeric.rs`.
  `to_int32`/`to_uint32`/`to_int16`/`to_uint16`/`to_int8`/`to_uint8` narrow its result, and
  `to_uint8_clamp` is separate.
  These replace the five implementations listed under R1.
- Claim: for every `b: u64`, each function equals `ironhorse_spec::to_intN(b)`.
  `to_uint8_clamp` equals the ToUint8Clamp model, which clamps to [0, 255] and rounds half to
  even, for every `b`.
- Spec: §7.1.6 to §7.1.12.
- Method: Kani all-inputs, 2^64, integer-only, default checks.
- Refactor: the rewrite and consolidation (R1).
  ToUint8Clamp's `round_half_even` uses only `round`, `trunc`, `floor` and `ceil`.
  The spike measured `trunc`, `floor` and `round` as correct (2.7 to 3.5 s) and did not test
  `ceil`.
  If an integer-only clamp is not faster, ToUint8Clamp may keep its float form, but the harness
  then needs `--no-overflow-checks`.
- Cost: the spike verified the stubbed equivalent in 12 to 15.5 s (measured).
  The integer-only form is estimated to cost no more, because the integer-only f16 kernel (NUM-7)
  took 0.36 to 1.5 s.
  Tier `pr`.
- Mutant: reduce with a saturating `as u32` above 2^32.

**NUM-2. Int32 bitwise operators, `Math.imul`, `Math.clz32`.**
- Kernel: a pure `int32_bitop(op, a: i32, b: i32) -> Slot`, extracted from
  `ironhorse-vm/src/interp/coerce.rs` `Interp::binary_bit`, plus pure helpers for the `Clz32` and
  `Imul` arms in `interp/natives/number.rs`.
- Claim: for every `a, b: i32` and each of `& | ^ << >> >>>`:
  - the result's numeric value equals the spec operator applied to ℝ(a), ℝ(b);
  - the shift count is `ToUint32(b) mod 32`;
  - `>>>` yields `Integer(u)` exactly when `u ≤ i32::MAX`, and `Number(u)` otherwise.

  `imul` and `clz32` equal their models for all inputs.
- Spec: §6.1.6.1.9 to §6.1.6.1.19, §21.3.2.19 (imul), §21.3.2.11 (clz32).
- Method: Kani all-inputs, 2^64 per binary op.
- Refactor: the extraction.
  `binary_bit` today is a `&mut self` stack-machine method.
- Cost: estimated seconds, tier `pr`.
- Mutant: shift count `& 63`.

**NUM-3. The integer fast path agrees with the Number path.**
- Kernel: `ironhorse-vm/src/interp/numeric.rs` `apply_arith` (Integer arms) and `unary_minus`.
- Claim, for every `x, y: i32`, in four parts:
  - (a) **Add, Sub.** `apply_arith(op, Int x, Int y)` is bit-identical (`to_bits`, so -0 counts)
    to `apply_arith(op, Num x, Num y)`.
  - (b) **Mul.** Split along the code's own structure.
    The zero branches and the overflow branch are proved against the model.
    The remaining obligation is a lemma: if `x.checked_mul(y) == Some(v)`, then
    `(x as f64 * y as f64).to_bits() == (v as f64).to_bits()`.
    The overflow branch computes `x as f64 * y as f64` exactly as the Number path does.
  - (c) **Div.** Both paths compute the same expression, `x as f64 / y as f64`.
    The refactor makes both call one `number_divide(f64, f64)`.
    Equivalence then holds by construction, and the ledger records it as "by construction,
    reviewed", not as proved.
  - (d) **Mod.** The Integer arm is proved directly against the integer model of
    Number::remainder, including `neg % y == 0 → -0`, `i32::MIN % -1`, and `y == 0 → NaN`.
    It is not compared to the Number path, whose `%` Kani miscomputes.
    The Number path's `%` is Bolero-tested against the same model.

  Also for every `i: i32`, `unary_minus` matches Number::unaryMinus, including `0 → -0` and
  `i32::MIN` promotion.
  And no `Integer` result is ever -0, the representation invariant shared with NUM-4.
- Spec: §6.1.6.1.1 and §6.1.6.1.4 to §6.1.6.1.8.
- Method:
  - (a): Kani all-inputs, `--no-overflow-checks`.
  - (b): Kani all-inputs for the branch structure; the product lemma is attempted, with Bolero
    plus a written argument (|v| < 2^31 < 2^53, so the product is exact) if it times out like
    general `*`.
  - (c): construction.
  - (d): Kani all-inputs, integer-only, plus Bolero for the Number path.
- Refactor: the `number_divide` extraction.
- Cost: Add 258 s and Sub 308 s (measured), tier `nightly`.
  (d) is estimated seconds, tier `pr`.
  The (b) lemma is unknown: the spike's "sign rule on i32 operands" took 0.1 s, but exactness was
  not attempted separately.
- Mutant: drop the `x < 0 && r == 0 → -0` branch of Mod.

**NUM-4. Integer/Number canonical representation.**
- Kernel: `ironhorse-vm/src/interp/coerce.rs` `Interp::slot_from_number` (an associated fn with
  no `self`) and `interp/numeric.rs` `math_to_integer`.
- Claim: for every `b: u64`, `slot_from_number(f64::from_bits(b))` yields `Integer(i)` iff the
  value is an exact i32 and not -0.
  Also, `to_number` of the result has the same bits as the input (NaN payloads excepted).
  This is the invariant that "Integer and Number are two encodings of one Number".
- Spec: the engine contract in `slot_from_number`'s doc comment, "Preserve the integer fast
  representation without losing negative zero or a non-integral/non-finite Number", together
  with §6.1.6.1.
- Method: Kani all-inputs.
  The kernel only compares and casts, so default checks are expected to pass; R2's flag is added
  only if Phase 1 shows CBMC's NaN check firing, with the reason recorded.
- Cost: estimated seconds; the spike measured `i32 as f64` at 0.36 s and the saturating casts at
  1.7 s.
  Tier `pr`.
- Mutant: drop the sign test, so -0 becomes `Integer(0)`.

**NUM-5. SameValue, SameValueZero, IsStrictlyEqual on immediates.**
- Kernel:
  - `interp/numeric.rs` `strict_equals`;
  - a pure helper extracted from `interp/property/ordinary.rs` `Interp::same_value`;
  - a pure helper extracted from `interp/coerce.rs` `Interp::same_value_zero`.

  Only the immediate branches are extracted; neither touches the arena.
- Claim: for every pair of slots with immediate payloads (None, Boolean, Integer, Number,
  Reference), each helper equals its model over abstract Number values.
  So `Integer(1)` and `Number(1.0)` are equal under all three, and `Integer(0)` against
  `Number(-0.0)` is false under SameValue and true under `===`.
  Also, `Payload::eq` (`value.rs`) is representation equality: a cover witnesses a pair
  (`Integer(1)`, `Number(1.0)`) on which it and SameValue disagree, so no caller mistakes it for
  a language operation.
- Spec: §7.2.10, §7.2.11, §7.2.15.
- Method: Kani all-inputs over `kani::Arbitrary` slots (the derive works on `Slot`, `Payload` and
  `Kind`, measured).
- Refactor: the two extractions.
- Cost: estimated seconds, tier `pr`.
- Mutant: SameValue treats NaN ≠ NaN.

**NUM-6. Relative-index clamping.**
- Kernel: one new helper, `relative_index(n: f64, len: u64) -> u64`.
  It replaces the following, whose callers keep their own `u32` bound:
  - `interp/natives/buffer.rs` `Interp::typed_array_relative_index`;
  - the inline `(length as f64 + integer).max(0.0) as u64` sites in `natives/array.rs`
    (`array_generic_splice` and its siblings);
  - the `relative_index` closure;
  - `natives/string.rs`'s copy;
  - the relative step in `coerce.rs` `arg_to_index` and `arg_to_last_index`.
- Claim: for every `n` that is integral or ±∞ (the range of ToIntegerOrInfinity) and every
  `len ≤ 2^53 - 1`, the result equals the spec formula:
  - 0 if `n = -∞`;
  - `max(len + n, 0)` if `n < 0`;
  - `min(n, len)` otherwise.

  The model computes this in i128.
  The result is always within `0..=len`, so no slice downstream can go out of bounds.
- Spec: e.g. §23.1.3.28 Array.prototype.slice steps 4 and 5.
  The same steps recur in splice, at, fill, copyWithin, subarray and String.prototype.at.
- Method: Kani all-inputs under `assume(n is integral or infinite)`, `--no-overflow-checks`.
  A cover witnesses `n < -len`, `n = -∞` and `n > len`.
- Refactor: the consolidation, which also has to happen before any of the eight copies can be
  proved.
- Cost: estimated.
  The nearest measurement is float `+` exact on i32 operands, 141 s; this harness adds a branch
  structure but a narrower domain, so the real figure is unknown until Phase 1.
  Tier `pr` if under budget, else `nightly`.
- Mutant: clamp `n ≥ 0` to `len - 1`.

**NUM-7. binary64 → binary16 rounding and its round trip.**
- Kernel: `ironhorse-vm/src/interp.rs` `f64_to_f16_bits` and `f16_bits_to_f64`.
- Claim:
  - (a) for every `b: u64`, `f64_to_f16_bits(f64::from_bits(b))` equals the binary16
    round-to-nearest-even model, with NaN mapped to `0x7E00`;
  - (b) for every non-NaN `h: u16`, `f64_to_f16_bits(f16_bits_to_f64(h)) == h`;
  - (c) `f16_bits_to_f64` equals an independent exact decode.

  This also substantiates the kernel's own determinism claim: "Integer-only … so every host
  rounds alike and no value is rounded twice through binary32".
- Spec: §21.3.2.17 Math.f16round, and NumericToRawBytes for Float16.
- Method: Kani all-inputs. (b) uses `#[kani::unwind(12)]` for the normalisation loop.
  (b) is also exhaustive over 2^16 in `cargo test`.
- Refactor: none.
- Cost: **measured**: (a) verified in 0.36 to 1.5 s depending on solver, (b) in 0.27 s, (c) in
  0.26 s.
  No counterexample was found.
  Tier `pr`.
- Mutant: round ties away from zero.

**NUM-8. Typed-array NumericToRawBytes / RawBytesToNumeric.**
- Kernel: `ironhorse-vm/src/interp.rs` `encode_element_le` and `decode_element_le`.
- Claim, for integer element kinds and every `b: u64`:
  - `decode(encode(n))` equals the NUM-1 ToIntN model of `n`;
  - `decode` is a left inverse of `encode` on every byte pattern of the element width (all 2^32
    for 32-bit kinds);
  - Uint32 values above `i32::MAX` decode to `Number` (the NUM-4 invariant).

  Uint8Clamped equals ToUint8Clamp.
  Float64 encodes NaN canonically.
  Float16 reduces to NUM-7.
- Spec: §25.1.3.17, §25.1.3.15, §7.1.12.
- Method: Kani all-inputs. The `Vec` returned is at most 8 bytes.
- Refactor: `encode_element_le` uses the NUM-1 kernel in place of its `to_wrapped` closure.
- Cost: estimated seconds per kind, tier `pr`.
  Float32 (`n as f32`) is a float cast the spike did not measure.
  If it is expensive it moves to `nightly`.
- Mutant: Uint8Clamped truncates instead of rounding.

**NUM-9. Date day and civil arithmetic.**
- Kernel:
  - `interp/temporal.rs` `days_from_civil` and `civil_from_days` (pure i128);
  - `interp/date.rs` `civil_fields`, `time_clip` and `date_from_components_exact`.
- Claim:
  - (a) for every `y: i64`, `days_from_civil(y, 1, 1)` equals DayFromYear(y), which is
    `365(y-1970) + ⌊(y-1969)/4⌋ - ⌊(y-1901)/100⌋ + ⌊(y-1601)/400⌋`;
  - (b) `civil_from_days(days_from_civil(y, m, d)) == (y, m, d)` for valid dates with
    |days| ≤ 1e8, the TimeClip range;
  - (c) the field extraction in `civil_fields` equals YearFromTime, MonthFromTime, DateFromTime,
    WeekDay and the hour/minute/second/ms functions, for every integral `t` with
    |t| ≤ 8.64e15;
  - (d) `time_clip` equals TimeClip;
  - (e) the two civil algorithms, i64 in `civil_fields` and i128 in `civil_from_days`, agree on
    the TimeClip range.

  Part (e) is the divergence risk the duplication creates.
- Spec: §21.4.1 (DayFromYear, YearFromTime and the rest, MakeDay, MakeDate), TimeClip
  §21.4.1.31.
- Method: (a), (b), (d) and (e) are Kani all-inputs or bounded as stated.
  (c) first needs a refactor.
- Refactor: `civil_fields` divides in f64 (`(local / day_ms).floor()`), and f64 division timed
  out (measured).
  The refactor splits off an i64 kernel, `civil_fields_ms(t: i64, offset_minutes: i32)`, so the
  f64 → i64 conversion happens once at the boundary.
  That conversion is exact, since |t| plus the offset stays below 2^53.
  Behaviour identity then rests on a numeric fact: f64 floor-division and `i64::div_euclid` agree
  on that range.
  That fact is a proof obligation of its own.
  It goes to Kani if it stays inside budget, and otherwise to Bolero plus exhaustive tests at
  the range ends.
- Cost: estimated "moderate" by the survey (i128 division is slow in CBMC; no loops).
  Tier `nightly`.
- Mutant: `⌊(y-1901)/100⌋` with truncating division.

**NUM-10. Array-index string recognition.**
- Kernel: `interp/numeric.rs` `string_to_index` and `string_to_array_like_index`.
- Claim: `string_to_index(s) == Some(n)` iff `s == ToString(𝔽(n))` and `n < 2^32 - 1`.
  The u64 variant has the same claim with `n ≤ 2^53 - 1`.
- Spec: §6.1.7 "array index", and §7.1.21 CanonicalNumericIndexString restricted to integers.
- Method: Kani bounded over symbolic ASCII `[u8; N]` with `N ≤ 11` (`unwind(12)`), against a
  hand-written decimal model.
  The 10-digit boundary strings are covered exhaustively by unit tests.
  The u64 variant at `N ≤ 17` is `nightly`.
- Refactor: none expected.
  The survey names `str::parse::<u64>` as the costly part; if it dominates, it is replaced by a
  digit loop.
- Cost: estimated; not measured.
- Mutant: accept a leading `0` on multi-digit strings.

**NUM-11. BigInt limbs and NumberToBigInt.**
- Kernel: `interp/bigint.rs`, the limb operations:
  - `bi_add_mag`, `bi_sub_mag`, `bi_mul_mag`, `bi_div_rem_mag`;
  - `bi_shl_bits`, `bi_shr_mag`;
  - `bi_to_twos_complement`, `bi_from_twos_complement`, `bi_trim`, `bi_cmp_mag`.

  Also `number_to_bigint`.
- Claim:
  - (a) with inputs of at most two limbs, each operation equals u128 arithmetic: output trimmed,
    -0 normalised, two's complement at width ≤ 3 limbs against i128;
  - (b) for every integral finite `b: u64`, `number_to_bigint` yields the exact integer of the
    bit decomposition;
  - (c) **stretch:** the add/sub carry loops preserve the invariant "partial result plus carry
    times 2^(32·i) equals the partial sum" for any slice length the generator admits.
- Spec: §6.1.6.2 (BigInt::add and the other operations) and §21.2.1.1.1 NumberToBigInt.
- Method: (a) is Kani bounded at `unwind(4)`.
  `bi_div_rem_mag`'s bit loop is restricted to a one-limb divisor, or to `unwind(66)` on 64-bit
  dividends at `nightly`.
  (b) is Kani all-inputs after a refactor.
  (c) is Kani loop contracts, and the claim is "≤ 1024 limbs".
- Refactor: `number_to_bigint` multiplies floats by 2^32 in a loop.
  It is rewritten to shift the significand into limbs, which is exact by construction and
  integer-only.
  This is the same rule as NUM-1.
- Cost: (a) is estimated easy at ≤ 3 limbs.
  (c) is measured on an abstract loop of the same shape: 91 s, 2.25 GB.
  Tier `nightly`.
- Precondition recorded: `bi_cmp_mag` is correct only on trimmed inputs (survey).
  The harnesses assume trimmed inputs, and the ledger lists "snapshot-decoded BigInt chunks are
  trimmed" as an unproved obligation of the restore path.
- Mutant: drop the final carry limb in `bi_add_mag`.

### The meter

The meter is `ironhorse-vm/src/meter.rs` `Meter`: three `u64` fields (`index`, `interval`,
`count`) in 16.16 fixed point, plus `ironhorse-meter` `chunk_cost` and `string_chunk_cost`.
It is consensus-relevant and has no dependencies on the rest of the VM.
Its harnesses build `Meter::new()` and `restore` an arbitrary `MeterState`, because that is
exactly what a snapshot can feed in.
`MeterImage::decode` (`ironhorse-snapshot/src/image.rs`) checks only the cost-table name and
digest.
The host callback is modelled as a symbolic `bool`.
**Measured:** all 11 meter harnesses run in one invocation in about 20 s, with sub-second solver
time.
They are tier `pr`.

The claims below describe the meter after the fixes in
[§ Defects already found](#defects-already-found).
Before the fixes, MTR-1, MTR-2 and MTR-6 fail; MTR-1's failures are how the overflow defect was
found.

**MTR-1. No panic from any restored state.**
- Claim: for every `MeterState` and every single operation with arbitrary arguments, no
  operation panics.
  The operations are `tick_*`, `check`, `check_compilation`, `charge_and_check`,
  `charge_compilation`, `begin`, `rearm`, `state` and `computrons`.
- Spec, from the snapshot fuzz target's contract: `from_snapshot_bytes` "must NEVER panic, hang,
  or allocate unboundedly".
  And from the workspace `Cargo.toml`: "Guest-influenced arithmetic must not silently wrap in
  shipped builds."
  Together they mean the meter must not wrap and must not panic, so it must saturate.
- `untick_*` assumption: the harnesses assume the pairing precondition `index ≥ n` that
  `untick_raw`'s `debug_assert!` documents.
  Kani always builds with debug assertions on (measured).
  The release-mode saturating behaviour of an unpaired untick is a unit test.
- Method: Kani all-inputs (3 × u64 state).
  A second harness runs sequences of up to four operations, an estimate from the survey.
- Mutant: restore one plain `+=`.

**MTR-2. Charging fails closed.**
- Claim: if `index + n` is unrepresentable, `charge_and_check` returns `Abort` and leaves
  `index` unchanged.
  Every `tick_*` whose exact result exceeds `u64::MAX` leaves `index == u64::MAX`.
  From `index == u64::MAX`, every `check`, `check_compilation` and `charge_*` returns `Abort` or
  `false`, armed or not.
  `u64::MAX` is absorbing: `untick_*` does not leave it.
  Only `begin` or `restore` do.
- Spec (`meter.rs`, `charge_and_check`): "An unrepresentable total fails closed, even when checks
  are disabled; wrapping it would let guest work erase its accrued cost."
- Mutant: `untick_code` from the pegged state subtracts.

**MTR-3. Limit enforcement cannot be bypassed.**
- Claim: if `is_armed()` and `index > count`, `check` calls the host exactly once, with
  `computrons()`.
  If the host returns `false`, the result is `Abort`.
  If it returns `true`, the result is `Continue` and `count > index`, or the result is `Abort`
  when the next deadline is unrepresentable (the fix to the wrap branch).
  If the meter is not armed, the host is never called.
- Spec: `fxCheckMetering`'s contract as restated in `Meter::check`'s doc comment, "if metering is
  armed and the index passed the threshold, consult host"; and `is_armed`, "Zero disables
  checks".
- Mutant: the check's `index > count` replaced by `index > count.saturating_add(interval)`.

**MTR-4. Unit relations.**
- Claim: `computrons() == index >> 16`, and `scale_interval(i) != 0` iff `i != 0`.
  `chunk_cost(b)` equals `round_up_8(b) + 16` when that is representable, and saturates
  otherwise.
  `string_chunk_cost` equals its documented formula.
- Spec (`meter.rs`, `scale_interval`): "Saturating keeps a non-zero interval non-zero, so the
  armed/un-armed distinction is never flipped by arithmetic." And `tick_chunk_new`'s statement of
  `fxAdjustChunkSize`.
- Mutant: `interval << 16` in place of the saturating multiply.

**MTR-5. State and restore round trip.**
- Claim: `restore(s); state() == s` for every `s`.
  And `last_reported` affects no result of any operation, so dropping it from `MeterState` is
  sound.
- Spec (`Meter::restore`): "`last_reported` is re-seeded from `index` for diagnostics; it feeds
  no computation."
- Mutant: `restore` re-seeds `count` from `index`.

**MTR-6. Monotonicity, with its exact exceptions.**
- Claim: every operation leaves `index` unchanged or larger, with these exceptions:
  - `begin`, which resets `index` to 0 by contract (`fxBeginMetering`);
  - `restore`, which replaces it;
  - `untick_code` and `untick_raw`, which are paired refunds and never take `index` below the
    value it had before the paired tick.

  `check` is not an exception after the fix.
- Spec: `charge_and_check`'s "would let guest work erase its accrued cost" and
  `check_compilation`'s "Compilation receipts require a monotone accumulated index".
- Mutant: reinstate the wrap reset.

### Snapshot and bytecode framing

**SNAP-1. Atom container.**
- Kernel: `ironhorse-snapshot/src/atom.rs` `AtomReader::parse`, `parse_atoms`, `AtomWriter::atom`
  and `finish`, `atom_size`, `appended_atom_size`.
- Claim:
  - (a) **totality:** no panic on any `buf` with `buf.len() ≤ N`;
  - (b) **exact tiling:** every returned payload is a sub-slice, and the atoms tile the body
    exactly;
  - (c) **write → read round trip:** for one to three atoms with symbolic tags and contents and
    concrete payload lengths, `parse(finish(write(atoms)))` returns the same `(tag, payload)`
    list, including the duplicate-tag → `DuplicateAtom` branch;
  - (d) **read → write canonicality:** if `parse(b)` succeeds, `finish(write(parse(b))) == b`;
  - (e) the writer refuses sizes above `u32` for symbolic `usize` lengths, without allocating.
- Spec (`AtomError::TrailingBytes`): accepting a trailing tail "would give one logical machine
  unboundedly many container encodings, and so unboundedly many CAS keys".
  And for `DuplicateAtom`: "both non-canonical and a way to hide a payload behind one the reader
  prefers".
  (d) is the CAS-key injectivity those sentences claim.
- Method:
  - (a) and (b): Kani bounded.
    Unwind must be ≥ 5 everywhere, because a `FourCc` comparison becomes a `memcmp` whose loop
    needs 5 (measured).
  - (c): Kani bounded with concrete lengths.
  - (d): Kani bounded at small N.
  - (e): Kani all-inputs over `usize`.
- Cost (measured):
  - (a): N=16 at unwind 5 in 24 s, 1.2 GB (`pr`); N=32 in 81 s; N=48 at unwind 8 in 247 s, 5 GB
    (`nightly`).
    N=64 was inconclusive at a 7 GB cap.
  - (c): 22 s for one atom at 0.6 GB, 32 s for two at 0.75 GB, 54 s for three at 1 GB
    (`nightly`).
  - (d) and (e): estimated.
- Mutant: accept trailing bytes.

**SNAP-2. Slot record codec.**
- Kernel: `ironhorse-snapshot/src/slot_codec.rs` `encode_slot`/`put_slot`, `decode_slot`,
  `decode_payload`; `ironhorse-vm/src/value.rs` `Kind::from_u8`.
- Claim:
  - (a) `decode_slot` is total on every `[u8; 20]`;
  - (b) `decode_slot(encode_slot(s)) == s` for every `Slot`, modulo NaN canonicalisation, and
    `encode ∘ decode ∘ encode = encode`;
  - (c) **canonicality, after the fix:** if `decode_slot(r)` is accepted, re-encoding yields `r`,
    for every `r` whose Number payload (if any) is not a non-canonical NaN.
    The NaN carve-out exists because the codec deliberately preserves legacy NaN bits on decode.
    In its own words: "Decoding preserves legacy NaN bits; re-encoding normalizes them."
    Format-16 images catch a non-canonical NaN at the image gate (below).
- Spec (`slot_codec.rs` layout table): "9 | reserved (0)", "10..20 | payload data (tag-specific;
  unused bytes 0)".
  And "Encoding always zero-fills the record first, so a round-trip (write → read → write) is
  byte-identical".
- Method: Kani all-inputs over `[u8; 20]` and over `kani::Arbitrary` `Slot` (the derive is
  measured to work and to be visible from `ironhorse-snapshot`).
- Cost: **measured**: (a) in 1.3 s and (b) in 13.8 s, both verified.
  (c) **fails today**, with counterexample "all zeros except `rec[9] = 0xAA`".
  Tier `pr`.
- Mutant: re-admit a non-zero byte 9.

**SNAP-3. Fixed-format section decoders.**
- Kernel: `ironhorse-snapshot/src/image.rs` `Cursor` (`u32`, `u16`, `u8`, `bytes`),
  `decode_u32s`, `decode_heap` (at `slot_count ≤ 2`) and `MeterImage::decode`.
  Also `ironhorse-snapshot/src/format.rs` `Version::decode` and `Signature::decode`.
- Claim:
  - (a) totality on any input up to the stated length;
  - (b) **allocation bounded by input:** every pre-reservation is at most the input length
    divided by the element width;
  - (c) encode/decode round trip for up to three elements;
  - (d) `MeterImage::decode` consumes exactly its payload.
- Spec (snapshot fuzz target): "must NEVER panic, hang, or allocate unboundedly".
- Method: Kani bounded at `unwind(5)`.
  For (b), the `count.min(p.len() / 4)` pre-reservation clamps become one pure
  `reserve_hint(count, payload_len, width)`, and the harness proves the bound on that function.
  This is how a capacity bound becomes provable without instrumenting `Vec`.
- Scope limit: there are about 60 more `decode_*` functions in `image.rs` (survey).
  They stay with cargo-fuzz and Bolero; only the framing primitives are proved.
- Cost: estimated easy, tier `pr`.
- Mutant: reserve `count` unclamped.

**SNAP-4. Bytecode instruction framing.**
- Kernel: `ironhorse-vm/src/opcode.rs` `instruction_len`, `encoded_instruction_len`, `remap_ids`
  and `Opcode::from_u8`.
- Claim:
  - (a) `instruction_len` is total for every `code` with `len ≤ 6` and every `pc: usize`;
  - (b) `Some(l)` implies `l ≥ 1` and `pc + l ≤ code.len()`;
  - (c) for the size sentinels -1, -2 and -4, `l` equals the header width plus the declared
    payload length;
  - (d) the width arithmetic cannot overflow on a 32-bit `usize`;
  - (e) `remap_ids` preserves length and changes only ID operand bytes, for `len ≤ 8`.
- Spec, from `instruction_len`'s doc comment: "This function never panics on malformed input;
  the bytecode-decoder fuzz target relies on it".
  And from the fuzz target: "must degrade to a Halt::Decode, never panic".
- 32-bit hazard: `5 + (b0 | b1 << 8 | b2 << 16 | b3 << 24)` overflows a 32-bit `usize` when the
  declared length is near `u32::MAX`.
  Under `overflow-checks = true` that is a panic on wasm32 (see `rust/engine/WASM-BLOCKERS.md`).
  The spike ran only the 64-bit host model, and this design does not assume Kani offers a 32-bit
  one.
  The fix computes widths with `checked_add` in `usize`.
  The harness for (d) then proves that every addition is checked, by asserting that the kernel
  computes the same value in `u64` as in `u32` whenever the `u32` result exists.
  A `cross-target-ironhorse` unit test covers the boundary value on wasm32.
- Method: Kani bounded.
- Cost: estimated easy, tier `pr`.
- Not claimed: that the dispatcher always establishes `operand_*`'s precondition.
  The survey judged that infeasible on the 4,946-line loop without a `fetch` refactor.
- Mutant: `pc + l < code.len()` in place of `≤`.

### Text

**TXT-1. CESU-8, WTF-8 and UTF-16 transcoders.**
- Kernel:
  - `ironhorse-text/src/lib.rs` `SymbolName::from_units`, `from_cesu8`, `to_units`;
  - `ironhorse-vm/src/interp/text.rs` `cesu8_to_units`, `be16_to_units`, `units_to_be16`;
  - `interp/natives/json.rs` `wtf8_code_point`, `code_point_units`, `wtf8_to_units`;
  - `ironhorse-regexp/src/encoding.rs` `utf8_decode`, `cesu8_decode`.
- Claim:
  - (a) **losslessness:** `to_units(from_units(u)) == u`, and
    `from_cesu8(from_units(u).as_bytes()) == Some(from_units(u))`, lone surrogates included;
  - (b) **canonicality:** `from_cesu8(b) == Some(n)` implies `n.as_bytes() == b`;
  - (c) every decoder is total and never yields more units than bytes, and all decoders agree on
    canonical encodings;
  - (d) **order:** `cmp(units_to_be16(a), units_to_be16(b)) == cmp(a, b)`;
  - (e) `code_point_units` is UTF16EncodeCodePoint for every code point ≤ 0x10FFFF, and nothing
    above that is admitted (see the WTF-8 defect).
- Spec:
  - `ironhorse-text`: "Lossless JavaScript symbol spellings";
  - `interp/text.rs`: "Big-endian so a byte-lexicographic compare of two payloads equals their
    code-unit ordering (the ECMAScript string relation)", that is §7.2.13 IsLessThan on strings;
  - §11.1.1 UTF16EncodeCodePoint and §11.1.4 CodePointAt.
- Method, mostly tested, not proved (D5 above):
  - Kani for (a) at one unit: measured, 109 s, 4.3 GB, `nightly`.
  - Exhaustive in `cargo test` over all 2^16 single units for (a) and (b).
  - Exhaustive over all 2^21 values a four-byte lead can encode, for (c) and (e) on the WTF-8
    path.
  - Bolero over sequences for (a) through (d), with Kani on `[u8; ≤ 4]` for the non-allocating
    `wtf8_code_point` and `code_point_units` (estimated cheap).
- Mutant: `0xF0..=0xF7` kept after the fix.

### Structural invariants

**STR-1. Slot-arena free list.**
- Kernel: `ironhorse-vm/src/value.rs` `SlotArena::image_free_marks`, then an extracted
  `FreeList { free, free_marks, marks, live }` core used by `alloc`, `free`, `mark`,
  `sweep`/`sweep_each` and `try_from_image`.
- Claim:
  - (a) `image_free_marks` accepts iff the free entries are distinct and `< count`, and
    `free.len() + live == count`;
  - (b) the invariant I is preserved by `alloc`, `free`, `mark` and `sweep` on the extracted core,
    at capacity ≤ 4 and ≤ 4 operations;
  - (c) LIFO reuse order is preserved, because the snapshot serialises it.

  The invariant I is: `free_marks[i]` iff `i ∈ free`; `free` has no duplicates;
  `live + free.len() == capacity`; and no slot is both marked and free.
- Spec: `free_marks`'s field comment, "kept in exact sync by every free-list writer", and
  `marks`'s, "A slot is never both free and marked".
- Method: Kani bounded.
  `image_free_marks` allocates `vec![false; slot_count]`, and a symbolic size there is the
  pattern that ran out of memory (measured on the atom writer), so each harness fixes
  `slot_count` concretely for 0 to 4.
  The full `SlotArena` (HashMap property index, `Rc` trackers, lazy backing) gets a Bolero model
  test.
- Refactor: the `FreeList` extraction for (b) and (c).
- Cost: (a) is estimated easy now, tier `pr`; (b) and (c) are `nightly`.
- Mutant: `free` forgets to set `free_marks`.

**STR-2. Chunk-chain parser progress.**
- Kernel: `value.rs` `ChunkReader::checked_block_at` and `chunk_allocation_fits`.
- Claim: on any buffer of at most 24 symbolic bytes, `checked_block_at` is total, and
  `Ok((end, _))` implies `header < end ≤ total`.
  Strict progress is what makes `free_chunk_for`'s `while header < len` loop terminate.
  `chunk_allocation_fits` equals its arithmetic model.
- Spec: engine contract; the termination argument is written in the harness doc comment.
- Method: Kani bounded.
- Cost: estimated easy, tier `pr`.
- Mutant: `end ≥ header` in place of `>`.

**STR-3. Regexp CharSet algebra.**
- Kernel: `ironhorse-regexp/src/compile.rs`.
  A pure merge extracted from `charset_combine`'s boundary sweep, which today charges
  `self.work` and adds nodes.
  Also `charset_contains`, `charset_range` and `charset_not`.
- Claim: for well-formed inputs (strictly ascending boundaries, even count), with ≤ 2 ranges per
  side, the following hold for every code point `x`:
  - `contains(out, x) == contains(a, x) op contains(b, x)`, for union, intersection and
    subtraction;
  - the output is well-formed;
  - `charset_contains` equals a linear scan.
- Spec: §22.2.2 CharSet union, intersection and difference.
- Method: Kani bounded at `unwind(6)`.
  `charcase::find_row` needs its tables sorted and disjoint, and that is an exhaustive unit test.
- Refactor: the merge extraction.
  The `self.work` charge stays at the call site, so metering is unchanged.
- Cost: estimated easy, tier `pr`.
- Mutant: an intersection that keeps an empty range.

### Examined and rejected

The survey's §4 examined these and judged them not worth Kani.
Each stays with its current layer:

- **Number↔string formatting and parsing:** `number_to_ecma_string`,
  `canonical_numeric_index_string`, `number_to_fixed`/`exponential`/`precision`/`radix_string`,
  `string_to_number` and `parse_int`.
  These use `format!`, `String` and dtoa.
  They get a Bolero round-trip test where it is cheap, but no ledger guarantee here.
- **Transcendental Math and `fx_pow`:** outside the spec's exactness; determinism is handled by
  the provider vector (`DETERMINISM-METERING.md`).
- **GC and compaction:** `gc.rs` `collect_full`, `ChunkArena::compact_local`/`compact`,
  `property_index.rs` and `bulk.rs`.
  They are built on HashMap and BTreeMap; a Bolero model test is the better fit.
- **The compiler's peephole `optimize` and `serialize_atoms`:** already gated by byte identity
  against the oracle.
- **The dispatch loop and the natives:** too large.
  Only extracted helpers qualify.
- **`charcase::canonicalize` and `ironhorse-unicode` predicates:** their domain is ≤ 2^21, so an
  exhaustive test is strictly better.
- **SHA-256 and the cost-table digest:** known-answer tests and the digest pin suffice.
- **Temporal beyond `days_from_civil`:** Kani-friendly i128 maths, but not ECMA-262 core.
  Later stretch material.

## Defects already found

Verification that finds nothing proves little.
The spike and the survey found the following.
Each fix lands in the phase that proves it (Phase 0 for the meter, Phase 2 for the codecs), with
a release-mode regression `#[test]` built from the counterexample.

### Meter accumulation overflows and panics (measured, confirmed)

Shipped builds set `overflow-checks = true` (workspace `Cargo.toml`).
From a restored state, the following panic:

| Operation | Failing check | Counterexample |
|---|---|---|
| `tick_code` | add overflow | `index = u64::MAX` |
| `untick_code` | sub overflow | `index = 0` |
| `tick_code_n` | mul overflow; add overflow | `n = 2^63`; `index = 2^63, n = 2^47` |
| `tick_builtin` | add overflow | `index = u64::MAX` |
| `tick_builtin_some` | mul overflow; add overflow | `k = u64::MAX` (mul); add not recorded |
| `tick_slot_alloc` | add overflow | `index = u64::MAX` |
| `tick_chunk_alloc` | add overflow | `index = u64::MAX, size = 1` |
| `tick_raw` (so `tick_chunk_new`, `tick_string`) | add overflow | `index = u64::MAX` |
| `untick_raw` | its `debug_assert!` (saturates in release) | — |

The spike confirmed the panics with 11 `#[test]`s passing under
`cargo test --release -p ironhorse-vm` with `should_panic("attempt to … with overflow")`.
They were checked against `meter.rs` as it stands: `tick_*` use plain `+=` and `*`, and
`untick_code` uses `-=`.
Only `charge_and_check` and `charge_compilation` use `checked_add`.
Reaching `index ≈ 2^64` from `begin()` takes about 2^48 computrons, so in practice the path is a
crafted (or corrupted) snapshot.
That is exactly the input the snapshot decoder's contract says must fail closed.

**Decided fix:**

- All meter accumulation saturates: `saturating_add`, `saturating_mul`, and `saturating_sub` for
  `untick_code`, matching `untick_raw`.
- `u64::MAX` becomes an absorbing exhausted state.
  `check_inner` returns `Abort` whenever `index == u64::MAX`, armed or not.
  This matches `charge_and_check` ("even when checks are disabled") and `charge_compilation`
  (which already refuses `next == u64::MAX`).
- `untick_*` does not leave the exhausted state.

The explicit check is needed: saturation alone does not fail closed.
A saturated interval sets `count == u64::MAX`, so `index > count` never holds, and a pegged
index would otherwise pass every check.

The result is that a crafted meter ends the crank as `Halt::MeterAbort`, which
[ironhorse-panic](ironhorse-panic.md) already classifies as a panic.
Today the same input ends in an unclassified Rust panic.

### The wrap branch erases accrued cost (by inspection, contract-contradicting)

`check_inner`'s non-monotone branch computes `count = index.wrapping_add(interval)`.
If that wraps, it sets `index = 0`.
The unit test `check_wrap_guard_restarts_window` pins this behaviour.
It is inherited from `fxCheckMetering` (`xsRun.c:4475`), and the code comment justifies it with
"parity is the whole premise".
The behaviour contradicts the meter's own contract that guest work must not "erase its accrued
cost".
It also contradicts the engine's metering doctrine, which makes XS-computron parity "an explicit
**non-goal**"
([ironhorse-engine § Metering](ironhorse-engine.md#metering-requirement-1a)).
The branch needs `index > count` and `index + interval ≥ 2^64`.
A restored state reaches it at once: the unit test's own state is `index = 8`, `count = 4`,
`interval = u64::MAX - 2`, because a snapshot's raw `interval` need not come from
`scale_interval`.
From `begin()` with an honest interval it needs about 2^48 computrons.
(A saturated interval cannot reach it: `count == u64::MAX` and the check never fires.)

**Decided fix:** fail closed.
When advancing `count` would wrap, `check` returns `Abort` instead of resetting `index`.
`check_wrap_guard_restarts_window` is rewritten to pin `Abort` with `index` unchanged.
This flag is deliberately loud:

- It is a **deliberate departure from XS behaviour**, in a state an honest execution reaches
  only after about 2^48 computrons and a crafted snapshot reaches immediately.
- Metering is consensus-relevant, so the change **needs maintainer sign-off** before it lands,
  including a decision on whether it requires a meter-version identity change.
  It changes no weight, so the cost-table digest is unchanged.
  But two releases given the same crafted snapshot would end it differently.
  The old release ends it with a Rust panic, or with a reset and continued execution.
  The new one ends it with `MeterAbort`.
- `ironhorse-vm/tests/golden_computrons.rs` and `ironhorse-snapshot/tests/meter_fail_closed.rs`
  must be shown unchanged by running them, not by argument.

### The slot record decoder accepts non-canonical records (measured, confirmed)

`decode_slot` ignores pad byte 9 and the unused payload bytes.
`Payload::Boolean` reads `d[0] != 0`, so `0x02` decodes to `true` and re-encodes as `0x01`.
**Measured** counterexample: a record of all zeros except `rec[9] = 0xAA` decodes, and
re-encodes to different bytes.
A release `#[test]` confirmed it.
For format version ≥ 16, `read_machine` already rejects the result
("non-canonical machine encoding") by re-encoding the whole image and comparing bytes.
Older formats keep their documented normalising import path.

**Decided fix:** reject at the codec, so canonicality holds at the lowest layer instead of
depending on one caller's whole-image comparison.

- `decode_slot` returns a new `SlotCodecError` for a non-zero byte 9, a non-zero unused payload
  byte, or a Boolean byte other than 0 or 1.
- The encoder zero-fills the record, and `slot_codec.rs` has one commit in this repository's
  history (with `--follow`), which already did; so no image this engine wrote should carry such
  bytes.
  Phase 2 confirms that against the checked-in snapshot fixtures before landing the change.
- NaN payload bits stay accepted on decode, as the codec documents, so legacy images keep
  importing.
  SNAP-2(c) carves them out explicitly.
- Kind/payload pairing is not changed here.
  The survey flags that any pairing is accepted.
  That is a well-formedness question for the image layer, recorded as a gap.

### WTF-8 lead bytes F5..F7 admit code points above U+10FFFF (by inspection)

`json.rs` `wtf8_code_point` accepts lead bytes `0xF0..=0xF7`, which encode values up to 0x1FFFFF.
`code_point_units` then emits `0xD800 | (offset >> 10)`.
For 0x1FFFFF that is `0xDFBF`, a low surrogate in the high-surrogate position, produced silently
rather than as a panic.
The function's doc comment limits it to input "the parse admitted".
Whether the JSON tokenizer can pass such bytes is **not yet established**.
Phase 2 decides that first.
The sibling `cesu8_to_units` had a bug of the same class, found by the `bytecode_decoder` fuzz
target.
Whatever reachability shows, the fix is the same: `wtf8_code_point` rejects any lead byte above
`0xF4` and any result above 0x10FFFF.
TXT-1(e) then proves the kernel total and correct on its whole domain.

## Infrastructure

### Manifest: `rust/engine/verification/proofs.toml`

One entry per harness:

```toml
[[harness]]
guarantee = "NUM-1"
crate = "ironhorse-vm"
name = "interp::numeric::proofs::to_int32_matches_spec"
tier = "pr"                 # "pr" or "nightly"
flags = []                  # e.g. ["--no-overflow-checks"]; reason required if non-empty
unwind = 0                  # 0 = no loops; otherwise the #[kani::unwind] value
time_budget_s = 60
memory_budget_gb = 2
unreachable = 0             # pinned library-unreachable count (R3)
mutants = ["NUM-1-a"]       # patches under verification/mutants/
canary = false              # true: expected status is pinned and must not change (R1)
```

Bolero and exhaustive entries use the same schema with `engine = "bolero"` or
`engine = "exhaustive"`, so every guarantee in the ledger has a machine-checked row.

### Runner: `rust/engine/scripts/verify.py`

A Python script, like its siblings in `rust/engine/scripts/`, with its own test file.
It:

1. **Lists.** It runs `cargo kani list --format json` per crate and diffs the result against the
   manifest (R3).
2. **Runs per crate in batches.** It makes one `cargo kani` invocation per crate per flag set,
   with a `--harness` module-path filter.
   It uses `-Z unstable-options --export-json` for per-harness results and `--sarif` as the
   stable cross-check, and keeps the regular output for the vacuity strings.
   The spike confirmed only that regular output reports `UNSATISFIABLE` covers and "unreachable"
   counts.
   Phase 0 establishes which machine-readable format carries those statuses.
   Until then, the runner requires all formats to agree.
3. **Enforces R1 to R5.**
   - canary statuses unchanged;
   - flags justified;
   - every cover satisfied;
   - harness assertions reachable;
   - unreachable counts pinned;
   - any `ERROR` status, driver crash or missing result is a failure;
   - every guarantee has a mutant.
4. **Enforces budgets.** It applies a wall-time limit per invocation and an address-space limit
   on child processes.
   It reads per-harness verification times from the output, and fails a harness that exceeds
   twice its budget.
   Budgets come from measurements on the CI runner, not from the spike's loaded host.
5. **Checks the ledger.** It regenerates the guarantee table in `VERIFICATION.md` between marker
   comments.
   `--check` fails on drift, the same pattern as `yarn build:types:check`.
6. **Runs mutants (`--mutants`).** It applies each patch in a scratch worktree, runs that
   guarantee's harnesses, and requires a counterexample failure (R4).

The runner's tests include the `verification/selftest/` fixtures (R3).

### Ledger: `rust/engine/VERIFICATION.md`

This is the single place that states every guarantee.
For each one it gives: ID, claim, domain and bounds, assumptions, flags, method (proved, tested
or by construction), the spec source quoted, the trusted base, the mutant, and the last-verified
Kani version.
This design document holds the rationale and the catalogue as planned.
The ledger holds what is true now, and the runner keeps it honest.

### CI

- **`verify-ironhorse` (pull requests).** It runs the `pr` tier.
  Target: under about 10 minutes wall time on a 4-vCPU/16 GB runner.
  The selection is by estimate: the `pr` entries above total a few minutes of solver time,
  plus one cold build per crate (measured on the loaded host at 43 s for the VM and 21 s for the
  snapshot crate).
  Phase 0 measures it on the real runner, and entries move to `nightly` until the budget holds.
  The job is registered in `scripts/ci-changes.py` per `docs/ci-change-selection.md`.
  It is selected by changes to any crate that holds a harness, to `ironhorse-spec`, or to
  `verification/`, `VERIFICATION.md` or the runner.
- **`ironhorse-kani-nightly.yml` (scheduled, plus manual dispatch).** It runs the `nightly`
  tier, every Bolero target at a longer budget, and the mutation sanity job.
  It is a separate workflow file, following the precedent of `cargo-deny-advisories.yml` and
  `ironhorse-deep-fuzz.yml`, so that a `schedule` trigger never makes the detector select every
  `ci.yml` job.
  Memory-heavy harnesses run serially: atom N=48 measured 5 GB and `SymbolName` 4.3 GB.
- **Installation.** `cargo install --locked kani-verifier@0.68.0` then `cargo kani setup`, with
  both the binary and Kani's toolchain directory cached.
- **Upgrades.** A Kani or CBMC upgrade is a deliberate PR.
  It bumps the pin, re-runs the canaries (R1), the full `nightly` tier and the mutation job,
  updates the ledger's last-verified version, and records any status change.
  A changed canary is the expected signal that R1 can be revisited.

## Performance and metering discipline

- **Behaviour identity is proved, speed is measured.**
  Every rewrite for provability must be behaviour-identical on every input, and the proof
  against the model establishes exactly that.
  That covers integer-only ToIntN, `number_to_bigint` by shifting, the `relative_index`
  consolidation and the `civil_fields_ms` split.
  The repository rule is that a numeric-representation choice is substantiated by measurement.
  So each rewrite is also benchmarked against the code it replaces, following
  `rust/engine/benches` conventions: medians, provenance digests, and a same-host comparison
  against the pre-change revision.
  The micro-workloads are added to that roster rather than run ad hoc.
  A rewrite that regresses its workload beyond the roster's 1.25× floor needs a recorded
  justification, or a faster provable form.
- **Metering is unchanged by refactors.**
  An extraction or consolidation moves no `tick_*`, `charge_*` or `check` call.
  STR-3 leaves `charset_combine`'s `self.work` charge in the caller.
  `golden_computrons.rs` must pass unchanged after every refactor commit, and refactor commits
  are kept separate from fix commits.
  The meter fixes in [§ Defects already found](#defects-already-found) are behaviour changes, and
  they land in their own commits with the sign-off noted there.

## Non-goals

- No proof about the dispatch loop, the compiler, GC collection or compaction, the natives as a
  whole, or whole-program JavaScript semantics.
  Conformance stays with test262 and the differential harnesses.
- Proofs are about source under Kani's model of Rust, as compiled by Kani's nightly front end.
  They are not about the artefact that ships, built by rustc 1.91.1 and LLVM.
  Miscompilation is out of scope.
- Harnesses assume Kani's 64-bit `usize` model unless the harness says otherwise.
  SNAP-4(d) is the one harness that reasons about 32-bit widths, and it does so arithmetically.
- No claim about Intl, Temporal beyond `days_from_civil`, regexp matching (only CharSet algebra),
  or transcendental Math.
- No verification of `xs-oracle`, the C engine, or the daemon.

## Dependencies

| Design | Relationship |
|---|---|
| [ironhorse-engine](ironhorse-engine.md) | Parent. This design adds an assurance layer to its Memory-safety confidence, Fuzzability and Metering sections, and keeps its Miri amendment. |
| [ironhorse-panic](ironhorse-panic.md) | Related. The meter fix turns an unclassified Rust panic into `Halt::MeterAbort`, which that design already classifies; panic-freedom proofs shrink the residual set of logic-bug panics it treats as worker death. |
| [ironhorse-snapshot-schema](ironhorse-snapshot-schema.md) | Related. SNAP-1 to SNAP-3 prove canonicality and totality properties of the container and record encodings the schema perspectives describe; the codec fix tightens the record format without changing its layout. |
| [ironhorse-test262-convergence](ironhorse-test262-convergence.md) | Source of the test262 known-answer vectors for `ironhorse-spec`. |

## Phased implementation

Each phase lands with its ledger entries, manifest rows, mutants and benchmark records.
A phase is done when the runner is green on it, not when its harnesses exist.

1. **Phase 0: infrastructure, models, canaries, meter.**
   - Add `ironhorse-spec` with the ToIntN and f16 models and their known-answer tests.
   - Add workspace `check-cfg` for `cfg(kani)` and the `cfg(kani)` target dependency.
   - Add `proofs.toml`, `verify.py` with its self-test fixtures, `VERIFICATION.md`, the canary
     group, the `verify-ironhorse` job and its `ci-changes.py` registration.
   - Measure the PR-tier budget on the real runner, establish which output format carries cover
     and unreachable statuses, and pin library-unreachable counts.
   - Land the meter: MTR-1 to MTR-6, the saturation fix, and the wrap-branch fix (after sign-off;
     until then MTR-6 is recorded with the wrap branch as its stated exception).

   The meter comes first because it has the best value per effort: the harnesses exist in the
   spike's form, they run in about 20 s, and they already found a defect.
2. **Phase 1: numeric kernels, NUM-1 to NUM-8.**
   - Consolidate the ToIntN implementations and the relative-index copies, with benchmarks.
   - Extract `int32_bitop`, the immediate SameValue helpers and `number_divide`.
   - Prove NUM-1, 2, 4, 5, 6, 7 and 8, and NUM-3(a), (c) and (d).
   - Attempt the NUM-3(b) product lemma.
3. **Phase 2: parsers and codecs (SNAP, TXT).**
   - SNAP-1 to SNAP-4, the slot codec canonicality fix, `reserve_hint`, and the
     `instruction_len` checked arithmetic.
   - TXT-1, with the exhaustive and Bolero companions.
   - Establish whether the WTF-8 defect is reachable, then fix it.
4. **Phase 3: structural, Date and BigInt (STR, NUM-9 to NUM-11).**
   - `image_free_marks`, then the `FreeList` extraction; `checked_block_at`; the CharSet merge
     extraction.
   - The Date proofs after the `civil_fields_ms` split.
   - BigInt limbs at ≤ 2 to 3 limbs; `number_to_bigint` by shifting.
5. **Phase 4: depth.**
   - Mutation sanity in the scheduled job, with every guarantee's mutant required to fail.
   - Contract-based proofs: NUM-11(c) carry loops by loop invariant, and function contracts so
     that callers can be proved with `stub_verified` kernels.
   - Bolero companions for every "tested, not proved" entry, at nightly budgets.

## Design Decisions

1. **The spec is ECMA-262, not XS.**
   Where ECMA-262 is silent, the spec is the engine's written contract, quoted.
   *Rejected: XS as the reference.*
   The engine is a port of XS, so a proof against XS would let a shared misreading cancel out.
   XS also has documented deviations from ECMA-262.
   XS remains the result oracle, which is a different job.
2. **Named guarantees over small kernels, not whole-language verification.**
   A proof that covers every input of a 20-line kernel tells us something test262 cannot.
   A partial proof about the interpreter would tell us less than test262 already does.
3. **Kani, pinned, in-crate.**
   *Rejected: Verus, Creusot, Aeneas.*
   Each needs a second toolchain, or a proof assistant, and code written for the tool: Verus's
   dialect, Creusot's Pearlite annotations, or Aeneas's translatable subset.
   Kani checks ordinary Rust, after the small refactors this design lists.
   Revisit one of them only for a new component designed with it from the start.
   *Rejected: Prusti and Flux.*
   They need annotations throughout the verified code.
   Flux's refinement types fit index bounds (NUM-6, SNAP-4) well and are the first to revisit.
   Neither was evaluated in the spike.
   *Rejected: Miri.*
   It finds undefined behaviour in `unsafe` code, there is none, and the engine design retired
   its gate.
   *Rejected: a separate proofs crate.*
   The kernels are `pub(super)` or private, so the API would have to be widened for the tool.
   The spike showed in-crate proofs compile and batch well.
4. **Models in a zero-dependency, integer-only crate.**
   This keeps the trusted base small, reviewable against spec text, independent of the
   implementation, and clear of Kani's float bugs.
   *Rejected: models inside each harness.* That would duplicate them, and they could not be
   tested or reviewed as one unit.
5. **Integer-only kernels before proofs.**
   This is required by the measured float `%`/`rem_euclid`/`powi`/`powf` unsoundness, and it also
   consolidates duplicated code.
   *Rejected: stubbing `rem_euclid`.* The resulting claim would depend on the stub.
6. **Vacuity, solver errors and manifest drift are failures, enforced by a runner with its own
   self-tests.**
   This is required because Kani exits 0 in each case (measured).
7. **Mutation sanity per guarantee.**
   It is the cheapest end-to-end evidence that a harness exercises the kernel it names.
8. **Bolero for what Kani cannot decide, against the same models, labelled "tested, not
   proved".**
   *Rejected: proptest.* Bolero's harness can also run under Kani.
   *Rejected: leaving those properties to cargo-fuzz.* cargo-fuzz has no model to compare against.
9. **Fix found defects in the same program, flagging consensus-relevant changes for sign-off.**
   The meter wrap-branch change departs from XS behaviour, which the accuracy-over-parity
   doctrine permits but which needs maintainer approval.
10. **Codec-level canonicality, with a NaN carve-out.**
    The codec rejects non-canonical pad, unused and Boolean bytes.
    It keeps its documented legacy NaN acceptance, which the format-16 image gate covers.

## Known Gaps and TODOs

- [ ] Maintainer sign-off on the meter wrap-branch change, and the decision on a meter-version
      identity change.
- [ ] Pin the ECMA-262 edition and re-check every clause number cited here.
- [ ] Confirm that `[target.'cfg(kani)'.dependencies]` resolves for `ironhorse-spec` under
      `cargo kani`.
- [ ] Establish which Kani output format reliably carries cover and unreachable statuses, then
      drop the all-formats-agree requirement.
- [ ] Measure library-unreachable counts and the PR-tier wall time on the CI runner.
- [ ] Establish whether WTF-8 F5..F7 is reachable from the JSON tokenizer.
- [ ] Confirm against the snapshot fixtures that no stored slot record has a non-zero pad or
      unused byte.
- [ ] Kind/payload pairing well-formedness of slot records is unproved.
      Decide whether it belongs to the codec or to the image layer.
- [ ] "Snapshot-decoded BigInt chunks are trimmed" is an unproved restore-path obligation that
      NUM-11 assumes.
- [ ] The NUM-3(b) product lemma, and NUM-9's f64-floor-division versus `div_euclid` agreement,
      may exceed Kani's budget; their fallback is Bolero plus a written argument.
- [ ] Dispatcher operand-bound safety (the bridge from SNAP-4 to `operand_*`) needs a
      `fetch(code, pc)` refactor before it can be proved.
- [ ] Atom totality beyond 48 bytes, and multi-unit `SymbolName` round trips, are beyond the
      measured memory budget.

## Prompt

> research and write up a design doc on where what and how for adding useable meaningful formal
> verification to ironhorse. Then implement. XS is not the spec, javascript is. But thats too
> large of a target for verification. So focus on some guarantees of correct behavior. Be
> ambitious

The project manager then fixed the decisions this document records.
They are: specification stance; Kani 0.68 in-crate, with Bolero as a companion; the
`ironhorse-spec` reference-model crate; the soundness and anti-vacuity rules; the honest
Kani-limits list; the guarantee catalogue; the defects to fix; the infrastructure; performance
discipline; and phasing.
The evidence came from a code survey and a measured Kani feasibility spike on this tree.
