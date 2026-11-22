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
  Every meter harness but `mtr1_sequence_of_four` (unwind 5) is unbounded over
  its stated domain (no loops, no unwind).

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
   The numeric guarantees (NUM-1 to NUM-9) are stated against them, and the
   ordinary differential tests check the same models.
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
  (`flags_reason`).
  No harness uses it: `num3_add_paths_agree` and `num3_sub_paths_agree` were
  written with it, and pass without it.
- **R3. Vacuity is a failure.**
  Kani exits 0 and says SUCCESSFUL for an unsatisfiable cover and for a
  contradictory `assume`, and reports an out-of-memory or timed-out solver as
  a failed harness with no failed check.
  So the runner reads `--export-json` (the only format with a status per check
  and the function each check lives in; SARIF lists failures only) and fails:
  - a harness without a `kani::cover!`, or with any cover not SATISFIED;
  - any UNREACHABLE check in harness code, which is every function in a
    proof module (`proofs`, `*_proofs`, `kani_canaries`), shared helpers
    included, unless the harness's `unreachable_allow` names that function;
  - a library UNREACHABLE count different from the manifest's `unreachable`
    (pinned per harness from a measured run; the Lib. unreachable column);
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
2. Add a `[[harness]]` entry to `verification/proofs.toml`, or to a per-area fragment
   `verification/proofs.d/<area>.toml` that the runner merges into it (and a
   `[[guarantee]]` if the ID is new) with its statement, exact domain, unwind,
   flags, budgets and mutants.
3. Write at least one mutant per guarantee: a one-line semantic change, as a
   unified diff relative to `rust/engine`, with a one-line description first.
   Check that `verify.py mutants --id <ID>` kills it.
4. Run `verify.py run --tier all --id <ID>`, set the budgets from the measured
   times, and regenerate the ledger.

## Production code that differs under `cfg(kani)`

A proof is about the code Kani compiles.
These are the places where that differs from the code that ships;
`verify.py check` counts every `cfg(kani)` attribute outside a proof module
and a `kani::Arbitrary` derive and fails on any not listed in the manifest's
`[[cfg_kani]]` tables.

- **`ironhorse-snapshot/src/atom.rs` `first_duplicate`.**
  A shipped build scans pairwise up to 64 atoms and uses a `BTreeSet` above
  that; under Kani only the pairwise scan is compiled, because the
  `BTreeSet` node code did not finish symbolic execution in 300 s for three
  symbolic tags.
  Every container the SNAP-1 harnesses admit (at most 48 bytes, so at most
  five atoms) takes the pairwise scan in a shipped build as well, so the
  proofs are about shipped behaviour on their domain; the `BTreeSet` shape is
  tested, not proved.
- **`ironhorse-regexp/src/encoding.rs` `cesu8_unit`** is a
  `cfg(any(test, kani))` reference encoder for the TXT-1 tests and proofs;
  no shipped code calls it.
- **`kani::Arbitrary` derives** on `Slot`, `Payload`, `Kind` and their
  neighbours in `ironhorse-vm/src/value.rs` add an impl and change no
  existing code.
- **`[target.'cfg(kani)'.dependencies]`** in `ironhorse-vm/Cargo.toml` links
  `ironhorse-spec` into proof builds only.

## Tested, not proved

Each of these was in the design's catalogue and is covered by ordinary tests
against the same reference models (or, where noted, against the XS oracle),
but has no Kani proof.
The obstacle is the one measured when the proof was attempted.

| Property | Obstacle | Covered by |
|---|---|---|
| `Math.imul` (`math_imul`) equals the Int32 multiply model (NUM-2) | timed out at 600 s (the 32-bit multiplier equivalence) | `interp::numeric` test `int32_operators_match_the_spec` |
| The integer Mod fast path equals Number::remainder (NUM-3(d)) | timed out at 900 s, directly and in a division-free form | `interp::numeric` test `integer_arithmetic_matches_the_spec_and_the_number_path` |
| The Number paths of Mul and Mod agree with the Integer paths (NUM-3) | float `*` too slow for the solver; float `%` miscomputed by Kani (R1) | the same test |
| `days_from_civil` against the spec day model over the whole TimeClip year range (NUM-9) | the symbolic-year proof did not finish in 600 s; proved instead on years -10000..=10000 and on named boundary years | `interp::temporal` test `days_from_civil_matches_the_spec` |
| NUM-10 array-index string recognition (`string_to_index`, `string_to_array_like_index`) | timed out at 900 s | `interp::numeric` test `index_strings_match_the_spec` |
| `civil_fields`' f64 floor division of a time value, `time_clip`, `date_from_components_exact` (NUM-9(c), (d)) | not attempted as proofs (f64 division timed out in the spike) | `interp::date` test `civil_fields_matches_its_legacy_algorithm`; `ironhorse-262` `date_core` differential tests against XS |
| Float32 typed-array elements (NUM-8) | not attempted (the `n as f32` cast was never measured) | no model-based test from this work; test262 TypedArray coverage only |
| `MeterImage::decode_fields` and `Signature::decode` exactness and round trips (SNAP-3) | no harness landed | `image` test `meter_fields_are_exact_and_round_trip`; `format` test `signature_decode_is_exact_and_round_trips` |
| The `BTreeSet` duplicate-tag shape for containers above 64 atoms (SNAP-1) | `BTreeSet` node code did not finish symbolic execution in 300 s | `atom` tests `duplicate_shapes_agree_with_the_reference`, `many_tiny_atoms_check_duplicates_in_bounded_time` |
| The `Vec`-building transcoders (`SymbolName::from_units`/`from_cesu8`/`to_units`, `cesu8_to_units`, `wtf8_to_units`, `units_to_be16` beyond two units) (TXT-1) | symbolic `Vec` growth; only the allocation-free per-unit kernels are proved | `ironhorse-text` tests `sequences_are_lossless`, `accepted_bytes_are_canonical`; `interp::text` tests `decoders_agree_on_canonical_cesu8`, `cesu8_to_units_is_total_and_short`, `be16_order_is_code_unit_order`; `json` test `wtf8_round_trips_units` |
| `SlotArena::try_from_image`, and `image_free_marks` beyond slot count 4 (STR-1) | symbolic `vec![false; slot_count]` allocation | `value` test `image_free_marks_accepts_exactly_coherent_images` |

Not attempted at all:

- **NUM-11**, BigInt limbs and `number_to_bigint`.
- **STR-1(b) and (c)**, free-list preservation by `alloc`, `free`, `mark` and
  `sweep`: the `FreeList` extraction was judged too risky for the serialised
  LIFO reuse order that snapshots depend on.
- **NUM-6 for `arg_to_last_index`**, the `lastIndexOf` variant of the
  relative-index clamp, which keeps its own float form.

## Defects found by this work

Each fix landed in its own commit with a regression test.

| Defect | Found by | Fix |
|---|---|---|
| Meter accumulation (`tick_*`, `untick_code`) overflowed and panicked from a restored state under `overflow-checks` | Kani (MTR-1) | `5714b2e8`: saturating accumulation; `index == u64::MAX` is absorbing |
| The meter's wrap branch reset `index` to 0, erasing accrued cost | Kani (MTR-3, MTR-6) | `952e08a9`: fail closed with `Abort`. **Breaking and consensus-relevant: needs maintainer sign-off** |
| `String.fromCharCode(n)` returned U+FFFF for Numbers at or above 2^63 (a saturating cast where ToUint16 reduces modulo 2^16) | review for NUM-1 | `32a0daaf` |
| The slot record decoder accepted non-canonical records (pad byte 9, unused payload bytes, Boolean bytes other than 0 and 1) | Kani (SNAP-2) | `086ed0bf` |
| `decode_slot` panicked on a short record in release builds; `decode_slots` dropped a trailing partial record | review for SNAP-2 | `00546987` |
| `AtomReader::parse`'s quadratic duplicate-tag check let a 2 MiB container of empty atoms cost about 3.4e10 compares | review for SNAP-1 | `8c3c0067` |
| The snapshot row encoders panicked for a page or extent past the arena; `runtime_intern_floor` wrapped at 65536 names | the crate-wide panic and cast lints | `4f8c582f` |
| `wtf8_code_point` admitted code points above U+10FFFF (not reachable from guest input today) | review for TXT-1 | `3dbbda5f` |
| `instruction_len` could overflow `usize` on a 32-bit target for a declared length near `u32::MAX` | review for SNAP-4 | `6ed5c3a4` |

## Run times

Measured on 2026-11-22 on a 4-core, 15 GB development host with nothing else
running, Kani's build cache warm; the CI runner (4 vCPU, 16 GB) has not been
measured yet.
"Peak" is the largest process's resident set in each `cargo kani` batch.

| Run | Harnesses | Wall time | Peak memory per batch |
|---|---|---|---|
| `run --tier pr` | 90 | 252 s | vm 1.36 GB, snapshot 0.79 GB, regexp 0.13 GB, spec 0.11 GB, text 0.05 GB, meter 0.03 GB |
| `run --tier nightly` | 24 | 2190 s | vm 4.83 GB, snapshot 6.05 GB (the 48-byte SNAP-1 parse), regexp 0.46 GB |
| `mutants` | 73 mutants, every one killed | 2403 s | (per mutant, as the referencing harnesses) |
| `selftest` | 6 deliberately bad or good harnesses, each verdict as expected | 4 s | 0.14 GB |

The slowest proofs are `snap1_parse_tiles_48` (257 s),
`num9_days_from_civil_matches_spec_10000_years` (331 s),
`snap4_remap_ids_only_ids_6` (209 s) and `num3_add_paths_agree` (193 s), all
nightly; no `pr` harness takes more than 10 s.
The ironhorse-snapshot nightly batch peaks at 6 GB, so it must not share a
16 GB runner with another heavy job.

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
| SNAP-1 | Atom container: total, tiling, round-tripping and canonical (bounded) | On every input of up to 48 bytes AtomReader::parse does not panic, and when it accepts, the envelope is [len BE][XS_M] and the atoms tile buf[8..] exactly: each header is [8 + payload.len() BE][tag] and each payload is the sub-slice right after it, the last ending at buf.len(); the writer emits exactly that layout for one to three atoms with symbolic tags and contents and concrete payload lengths, and parse of its output returns the same (tag, payload) list or DuplicateAtom(first repeated tag), so an accepted container is the writer's encoding of its atoms (parse -> write canonicality); atom_size and appended_atom_size refuse exactly the sizes whose atom or envelope exceeds u32::MAX, for every usize; the pairwise duplicate scan names the first repeated tag (up to 4 tags). Under cfg(kani) first_duplicate compiles only its pairwise scan in place of the shipped dispatch (pairwise up to 64 atoms, a BTreeSet above), which selects the pairwise scan for every container of at most 48 bytes (at most five atoms) anyway; the BTreeSet shape is tested, not proved. | ironhorse-snapshot/src/atom.rs AtomError::TrailingBytes: accepting a trailing tail "would give one logical machine unboundedly many container encodings, and so unboundedly many CAS keys"; DuplicateAtom: "both non-canonical and a way to hide a payload behind one the reader prefers". | Kani 0.68 / CBMC 6.11, the harnesses | 7 (nightly) | `SNAP-1-a`, `SNAP-1-b`, `SNAP-1-c`, `SNAP-1-d` |
| SNAP-2 | Slot record codec: total, round-tripping and canonical | decode_slot is total on every 20-byte record and returns BadLength(len) on every other width up to 41 bytes; decode_slot(encode_slot(s)) is s with a NaN Number payload replaced by the canonical NaN, for every Slot, and re-encoding reproduces the bytes; an accepted record re-encodes to exactly its own 20 bytes unless its Number payload is a non-canonical NaN (the documented carve-out, refused for format >= 16 at the image gate). | ironhorse-snapshot/src/slot_codec.rs layout table: "9 \| reserved (0)", "10..20 \| payload data (tag-specific; unused bytes 0)"; "Encoding always zero-fills the record first, so a round-trip (write -> read -> write) is byte-identical"; "Decoding preserves legacy NaN bits; re-encoding normalizes them." | Kani 0.68 / CBMC 6.11, the harnesses | 4 (pr) | `SNAP-2-a`, `SNAP-2-b`, `SNAP-2-c`, `SNAP-2-d`, `SNAP-2-e` |
| SNAP-3 | Fixed-format section decoders: total, exact, bounded reservation (bounded) | The Cursor reads (u8, u16, u32, bytes(n) for any usize n), three in sequence on buffers of up to 8 bytes, succeed iff their bytes fit, return exactly them big-endian, advance by exactly their width and never past the end; be_u32_at/be_u64_at are exact on buffers of up to 12 bytes and any offset; decode_u32s on every 8-byte payload and Version::decode on payloads of up to 12 bytes do not panic and accept only payloads that re-encode to themselves (exact consumption); decode_u32s(encode_u32s(l)) == l for every two-element list and Version::decode(v.encode()) == v iff v is readable, for every Version; the list pre-reservation reserve_hint(count, len, width) is min(count, len / width) for every usize count and len, so never more entries than the payload can hold. Signature::decode and the METR framing MeterImage::decode_fields are tested, not proved: PRNG payloads must re-encode to themselves and round-trip. | ironhorse-fuzz snapshot_decoder.rs: from_snapshot_bytes "must NEVER panic, hang, or allocate unboundedly"; image.rs MeterImage::decode: "Exact consumption"; decode_u32s: "a malformed `count` must not reserve gigabytes". | Kani 0.68 / CBMC 6.11, the harnesses | 7 (nightly, pr) | `SNAP-3-a`, `SNAP-3-b`, `SNAP-3-c`, `SNAP-3-e` |
| SNAP-4 | Bytecode instruction framing (bounded) | instruction_len does not panic for any code of up to 6 bytes and any pc: usize; Some(l) implies l >= 1 and pc + l <= code.len(), with l the fixed size, 1 + ID_SIZE, or header width plus declared little-endian payload for the -1/-2/-4 sentinels; the width kernel prefixed_len is exact and panic-free in u32 (the usize of wasm32) and u64 for every header and u32 payload, fixing the 32-bit overflow; Opcode::from_u8 is total and round-trips; remap_ids on every 6-byte stream preserves length and changes only the two ID bytes after each ID-sentinel opcode of the walk, to the map's answer for the ID read there. | ironhorse-vm/src/opcode.rs instruction_len: "This function never panics on malformed input; the bytecode-decoder fuzz target relies on it"; WASM-BLOCKERS.md: overflow-checks panics on wasm32. | Kani 0.68 / CBMC 6.11, the harnesses | 4 (nightly, pr) | `SNAP-4-a`, `SNAP-4-b`, `SNAP-4-c`, `SNAP-4-d`, `SNAP-4-e` |
| TXT-1 | CESU-8, WTF-8 and UTF-16 transcoder kernels (bounded; sequences tested) | Per-unit and per-code-point kernels, proved on their whole domains: ironhorse-text encode_unit/decode_unit invert on every u16 (no zero byte) and decode_unit is total within its input on up to 3 bytes; json.rs code_point_units is UTF16EncodeCodePoint for every code point <= 0x10FFFF, wtf8_code_point is total on up to 4 bytes, decodes exactly the lead/continuation payload and never yields a value above 0x10FFFF, and inverts the WTF-8 encoding of every code point 0x80..=0x10FFFF; regexp cesu8_decode is CodePointAt on a high surrogate followed by any unit and utf8_decode/cesu8_decode invert every other non-NUL unit; big-endian units compare as the units do, and units_to_be16 preserves order on strings of lengths (1,2) and (2,2). The Vec-building wrappers (from_units/from_cesu8/to_units, cesu8_to_units, wtf8_to_units, units_to_be16 on longer strings) are tested, not proved: exhaustive single units, surrogate pairs, all code points, PRNG sequences up to 8 units. | ironhorse-text: "Lossless JavaScript symbol spellings"; interp/text.rs units_to_be16: "a byte-lexicographic compare of two payloads equals their code-unit ordering"; ECMA-262 11.1.1 UTF16EncodeCodePoint, 11.1.3 UTF16SurrogatePairToCodePoint, 11.1.4 CodePointAt, 7.2.13 IsLessThan. | Kani 0.68 / CBMC 6.11, the harnesses | 9 (pr) | `TXT-1-a`, `TXT-1-b`, `TXT-1-c`, `TXT-1-d`, `TXT-1-e`, `TXT-1-f` |
| STR-1 | Slot-arena free-list image acceptance (bounded) | For every slot_count in 0..=4, every free list of up to 5 u32 entries and every live: u32, SlotArena::image_free_marks accepts iff the entries are distinct and below slot_count and free.len() + live == slot_count, and then marks exactly the free slots. try_from_image (which builds on it) and the counts beyond the bound are tested exhaustively, not proved; the FreeList extraction for alloc/free/mark/sweep preservation was not attempted. | ironhorse-vm/src/value.rs SlotArena::free_marks: "kept in exact sync by every free-list writer"; try_from_image: "Rejects out-of-range and duplicate free entries and inconsistent counts." | Kani 0.68 / CBMC 6.11, the harnesses | 2 (nightly) | `STR-1-a`, `STR-1-b` |
| STR-2 | Chunk-chain parser progress (bounded) | On a plain chunk byte space of 24 symbolic bytes, for every total <= 24 and every header: usize, ChunkReader::checked_block_at does not panic and Ok((end, _)) implies header < end <= total, so free_chunk_for's chain walk terminates; chunk_allocation_fits equals header + 4 + payload < ceiling computed without overflow, for every usize triple. | ironhorse-vm/src/value.rs checked_block_at: "Validate a whole chain block before using either its end or free tag"; chunk_allocation_fits: "The exclusive end must remain below the reserved NULL offset". | Kani 0.68 / CBMC 6.11, the harnesses | 2 (pr) | `STR-2-a`, `STR-2-b` |
| STR-3 | Regexp CharSet algebra (bounded) | For well-formed endpoint lists of at most two ranges per side with boundaries in [-2^20, 2^20], the boundary-merge sweep extracted from charset_combine yields a well-formed list (even, strictly ascending) whose membership is the union, difference or intersection of the inputs' at every i32 x, and charset_contains (binary search) equals a linear scan on every well-formed set of up to two ranges. Metering is unchanged: the extraction leaves the work charge and node allocation in charset_combine. | ECMA-262 22.2.2 CharSet union, intersection and difference (CharacterClass evaluation); xsre.c fxCharSetCombine. | Kani 0.68 / CBMC 6.11, the harnesses | 4 (nightly, pr) | `STR-3-a`, `STR-3-b`, `STR-3-c` |
| NUM-1 | ToInt32 … ToUint8 and ToUint8Clamp for every Number | For every u64 bit pattern b, numeric_kernel::number_to_u64_wrapping(b) = truncate(ℝ(b)) mod 2^64 (0 for NaN, ±∞, ±0), and to_int32, to_uint32, to_int16, to_uint16, to_int8, to_uint8 and to_uint8_clamp each equal the ironhorse-spec model of their clause. Integer-only kernels, default checks. value::to_int32, interp::numeric::number_to_u64_wrapping, encode_element_le, String.prototype.split's limit, ArraySetLength and String.fromCharCode all call these kernels. | ECMA-262 §7.1.6 ToInt32, §7.1.7 ToUint32, §7.1.8 ToInt16, §7.1.9 ToUint16, §7.1.10 ToInt8, §7.1.11 ToUint8, §7.1.12 ToUint8Clamp (steps quoted in ironhorse-spec/src/to_integer.rs) | Kani 0.68 / CBMC 6.11, the ironhorse-spec models, the harnesses | 8 (pr) | `NUM-1-a`, `NUM-1-b`, `NUM-1-c`, `NUM-1-d`, `NUM-1-e` |
| NUM-6 | Relative-index clamping | For every Number n that is integral or ±∞ (the range of ToIntegerOrInfinity) and every len < 2^53, numeric_kernel::relative_index(n, len) equals the spec clamp computed in i128 (0 if n = -∞; max(len + n, 0) if n < 0; min(n, len) otherwise); for every f64 n (NaN and fractions included) the result is in 0..=len. It is the one clamp behind Array.prototype splice, copyWithin, fill, toSpliced and the generic slice, the %TypedArray% relative indices, String.prototype.slice's string_arg_to_index and Interp::arg_to_index. | ECMA-262 §23.1.3.28 Array.prototype.slice steps 3-6 (quoted in ironhorse-spec/src/relative_index.rs); the same steps in §23.1.3.4 copyWithin, §23.1.3.7 fill, §23.1.3.31 splice, §23.1.3.35 toSpliced, §23.2.3 %TypedArray% methods and §22.1.3.22 String.prototype.slice | Kani 0.68 / CBMC 6.11, the ironhorse-spec models, the harnesses | 1 (pr) | `NUM-6-a`, `NUM-6-b` |
| NUM-7 | binary64 to binary16 rounding and its round trip | For every u64 bit pattern b, interp::f64_to_f16_bits(f64::from_bits(b)) equals the IEEE 754 roundTiesToEven binary16 model (NaN to 0x7E00, overflow to ±∞ of the sign); for every binary16 h, f16_bits_to_f64(h) has exactly the model's binary64 bits when h is not a NaN and is a NaN when h is; and f64_to_f16_bits(f16_bits_to_f64(h)) == h for every non-NaN h. This substantiates the kernel's claim that every host rounds alike. | ECMA-262 §21.3.2.17 Math.f16round steps 2-5, and the Float16 cases of §25.1.3.17 NumericToRawBytes and §25.1.3.15 RawBytesToNumeric (quoted in ironhorse-spec/src/float16.rs); IEEE 754-2019 §3.3, §4.3.1, §7.4 | Kani 0.68 / CBMC 6.11, the ironhorse-spec models, the harnesses | 3 (pr) | `NUM-7-a`, `NUM-7-b` |
| NUM-8 | Typed-array element encode and decode | For each integer element kind (Int8, Int16, Int32, Uint8, Uint16, Uint32, Uint8Clamped) and every u64 bit pattern b, encode_element_le(kind, b) stores exactly the little-endian bytes of the clause's conversion model (ToInt8 … ToUint32, ToUint8Clamp), and decode_element_le of those bytes is Integer(v) of the model value v, or Number(v) for a Uint32 above i32::MAX; for every byte pattern of the element width (all 2^8, 2^16 or 2^32), decode then encode returns the same bytes. Float64 stores a non-NaN Number's own bits and every NaN as 0x7FF8_0000_0000_0000, and decodes any 8 bytes to the Number with those bits (a NaN canonicalised, as Slot::number does); Float16 stores the NUM-7 rounding and decodes with the NUM-7 widening. Float32 is not covered. | ECMA-262 §25.1.3.17 NumericToRawBytes, §25.1.3.15 RawBytesToNumeric, the conversion operations of Table 71 (§7.1.6-§7.1.12) | Kani 0.68 / CBMC 6.11, the ironhorse-spec models, the harnesses | 9 (pr) | `NUM-7-a`, `NUM-8-a`, `NUM-8-b`, `NUM-8-c`, `NUM-8-d` |
| NUM-2 | Int32 bitwise and shift operators and Math.clz32 | For every a, b: i32 and each of & \| ^ << >> >>>, interp::numeric::int32_bitop(op, a, b) holds the Number the ironhorse-spec model of the clause gives (shift count ToUint32(b) mod 32; bits as floor(v / 2^k) mod 2), as Integer exactly when that value is an int32 (so >>> yields Integer(u) iff u <= i32::MAX and Number(u) otherwise, and every other operator yields Integer); math_clz32(n) equals its model for every n: u32. Interp::binary_bit and the Math.clz32 native call these helpers. Math.imul (math_imul) is tested against its model, not proved: the 32-bit multiplier equivalence timed out at 600 s. | ECMA-262 §6.1.6.1.9 Number::leftShift, §6.1.6.1.10 signedRightShift, §6.1.6.1.11 unsignedRightShift, §6.1.6.1.16-§6.1.6.1.19 NumberBitwiseOp / bitwiseAND / XOR / OR, §21.3.2.11 Math.clz32 (quoted in ironhorse-spec/src/int32.rs) | Kani 0.68 / CBMC 6.11, the ironhorse-spec models, the harnesses | 7 (nightly, pr) | `NUM-2-a`, `NUM-2-b`, `NUM-2-c` |
| NUM-3 | The integer fast path agrees with the Number path | For every x, y: i32, apply_arith(op, Integer x, Integer y) holds exactly (to_bits, so -0 counts) the ironhorse-spec model's Number for Add and Sub (𝔽 of the exact sum or difference) and Mul (𝔽 of the exact product, rounded ties-to-even above 2^53; -0 for +0 times a negative, nightly), and is Integer exactly when that Number is an int32 other than -0; unary_minus(Integer x) is Number::unaryMinus (0 -> -0, i32::MIN -> 2^31). Add and Sub (nightly, default checks): the Integer path and the Number path (apply_arith on Number(x), Number(y)) are bit-identical. Div: both paths call number_divide, equal by construction (reviewed, not proved). Not proved (tested against the same models): the Mod fast path (a proof against Number::remainder timed out at 900 s, both directly and in a division-free form) and the Number paths of Mul and Mod (float * and % are out of reach; R1). | ECMA-262 §6.1.6.1.1 Number::unaryMinus, §6.1.6.1.4 Number::multiply, §6.1.6.1.6 Number::remainder, §6.1.6.1.7 Number::add, §6.1.6.1.8 Number::subtract, and 'the Number value for x' (§6.1.6.1), quoted in ironhorse-spec/src/arith.rs | Kani 0.68 / CBMC 6.11, the ironhorse-spec models, the harnesses | 6 (nightly, pr) | `NUM-3-b`, `NUM-3-c`, `NUM-3-d` |
| NUM-4 | Integer/Number canonical representation | For every u64 bit pattern b, Interp::slot_from_number(f64::from_bits(b)) and interp::numeric::math_to_integer(f64::from_bits(b)) are Integer(i) when b is 𝔽(i) for an int32 i (excluding -0), and otherwise a Number slot whose payload has exactly the bits b, except that every NaN becomes the canonical NaN 0x7FF8_0000_0000_0000 (Slot::number canonicalises); so to_number of the result has the input's bits for every non-NaN b. | ironhorse-vm/src/interp/coerce.rs Interp::slot_from_number: "Preserve the integer fast representation without losing negative zero or a non-integral/non-finite Number"; ECMA-262 §6.1.6.1 (the Number type; -0𝔽 is not an integer's Number value) | Kani 0.68 / CBMC 6.11, the ironhorse-spec models, the harnesses | 2 (pr) | `NUM-4-a`, `NUM-4-b` |
| NUM-5 | SameValue, SameValueZero and IsStrictlyEqual on immediates | For every pair of well-formed slots with immediate payloads, same_value_immediate, same_value_zero_immediate and strict_equals equal SameValue, SameValueZero and IsStrictlyEqual over the language values the slots denote (Integer(i) denotes 𝔽(i)), with Number::sameValue / sameValueZero / equal from ironhorse-spec; so Integer(1) and Number(1.0) are equal under all three and Integer(0) against -0 is false under SameValue and true under ===. Interp::same_value and Interp::same_value_zero call the first two for every pair that is not two strings or two BigInts. A cover witnesses a pair that Payload::eq (representation equality) separates but SameValue equates. String and BigInt contents are out of scope. | ECMA-262 §7.2.10 SameValue, §7.2.11 SameValueZero, §7.2.15 IsStrictlyEqual, §6.1.6.1.13-§6.1.6.1.15 (quoted in ironhorse-spec/src/arith.rs) | Kani 0.68 / CBMC 6.11, the ironhorse-spec models, the harnesses | 3 (pr) | `NUM-5-a`, `NUM-5-b`, `NUM-5-c` |
| NUM-9 | Date day and civil arithmetic | For every day number in [-10^8, 10^8] (the TimeClip range), interp::temporal::civil_from_days is a left inverse of days_from_civil: days_from_civil(civil_from_days(day)) == Some(day) (a self-consistency proof: it does not consult the spec model). days_from_civil(y, m, d) equals the ironhorse-spec day model (DayFromYear plus the MonthFromTime/DateFromTime offsets), None for a nonexistent month or day included, for every m, d: u32 and every year y in -10000..=10000 (nightly), 1900..=2100 and the concrete years 1968..1972, -401, -400, -1, 0, 1, 1600, 1601, 1900, 1901, 2000, 2100, -271822, -271821, 275759 and 275760 (pr). Over the whole TimeClip year range it is tested, not proved (the symbolic-year proof did not finish in 600 s): years -2000..3000, every 997th year to ±300000 and the i64 extremes. civil_fields now calls civil_from_days, so the Date and Temporal civil algorithms are one (by construction). Not proved: civil_fields' f64 floor division of a time value into days and milliseconds, time_clip and date_from_components_exact (tested only). | ECMA-262 §21.4.1 DaysInYear, DayFromYear, DayWithinYear, MonthFromTime, DateFromTime (quoted in ironhorse-spec/src/date.rs) | Kani 0.68 / CBMC 6.11, the ironhorse-spec models, the harnesses | 6 (nightly, pr) | `NUM-9-a`, `NUM-9-b`, `NUM-9-c`, `NUM-9-d` |

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
| MTR-2 | `ironhorse-vm` `meter::proofs::mtr2_ticks_saturate_exactly` | pr | Every tick_* leaves index = min(index + exact cost, u64::MAX), the exact cost computed in u128. | every MeterState (index, interval, count: all u64 triples); every tick op and u64 argument | 0 | default | 5 s / 1 GB | 2 | pass |
| MTR-2 | `ironhorse-vm` `meter::proofs::mtr2_charge_and_check_fails_closed` | pr | charge_and_check(n): an unrepresentable total aborts with index unchanged and no host call; a total of exactly u64::MAX aborts at u64::MAX; otherwise index = index + n. | every MeterState (index, interval, count: all u64 triples); every n: u64; host answer: any bool | 0 | default | 5 s / 1 GB | 0 | pass |
| MTR-2 | `ironhorse-vm` `meter::proofs::mtr2_charge_compilation_fails_closed` | pr | charge_compilation(n, host): an unrepresentable total is refused with index unchanged; a total of exactly u64::MAX is refused at u64::MAX; otherwise index = index + n. | every MeterState (index, interval, count: all u64 triples); every n: u64; host Some(any bool) or None | 0 | default | 5 s / 1 GB | 0 | pass |
| MTR-2 | `ironhorse-vm` `meter::proofs::mtr2_exhausted_is_absorbing` | pr | From index = u64::MAX, every guest-driven operation leaves index = u64::MAX, consults no host, and every check or admission refuses, armed or not. | every MeterState (index, interval, count: all u64 triples) with index = u64::MAX; every op and u64 argument | 0 | default | 5 s / 1 GB | 1 | pass |
| MTR-3 | `ironhorse-vm` `meter::proofs::mtr3_check_consults_the_host_when_due` | pr | check and check_compilation: exhausted aborts without the host; else if armed and index > count the host is consulted exactly once with index >> 16, false gives Abort, Continue implies count > index, and Abort after approval only on the execution path with index + interval unrepresentable; else no host call, Continue, state unchanged; index never changes. | every MeterState (index, interval, count: all u64 triples); host answer: any bool | 0 | default | 5 s / 1 GB | 0 | pass |
| MTR-3 | `ironhorse-vm` `meter::proofs::mtr3_unarmed_never_consults` | pr | An un-armed meter (interval = 0) never consults the host in check, check_compilation, charge_and_check or charge_compilation. | every MeterState (index, interval, count: all u64 triples) with interval = 0; every u64 argument | 0 | default | 5 s / 1 GB | 4 | pass |
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
| SNAP-1 | `ironhorse-snapshot` `atom::proofs::snap1_parse_tiles_16` | nightly | AtomReader::parse does not panic; on acceptance the envelope is [len BE][XS_M] and the atoms tile buf[8..] exactly (headers [8 + payload.len() BE][tag], payloads the sub-slices after them, the last ending at buf.len()). | every buf[..len] of every [u8; 16], len <= 16 | 5 | default | 146 s / 7 GB | 6 | pass |
| SNAP-1 | `ironhorse-snapshot` `atom::proofs::snap1_parse_tiles_32` | nightly | As snap1_parse_tiles_16, on longer inputs (up to three atoms, duplicate tags). | every buf[..len] of every [u8; 32], len <= 32 | 6 | default | 471 s / 7 GB | 6 | pass |
| SNAP-1 | `ironhorse-snapshot` `atom::proofs::snap1_parse_tiles_48` | nightly | As snap1_parse_tiles_16, on inputs holding up to five atoms. | every buf[..len] of every [u8; 48], len <= 48 | 7 | default | 838 s / 7 GB | 6 | pass |
| SNAP-1 | `ironhorse-snapshot` `atom::proofs::snap1_write_parse_two` | nightly | The writer emits exactly [total BE][XS_M] then [8 + len BE][tag][payload] per atom; parse of the result returns the same (tag, payload) list for distinct tags and DuplicateAtom(first repeated tag) otherwise. | two atoms, payload lengths [1, 3]; every tag ([u8; 4] each) and every payload byte | 5 | default | 102 s / 7 GB | 11 | pass |
| SNAP-1 | `ironhorse-snapshot` `atom::proofs::snap1_write_parse_three` | nightly | As snap1_write_parse_two, for three atoms including an empty payload. | three atoms, payload lengths [0, 2, 3]; every tag and every payload byte | 5 | default | 139 s / 7 GB | 11 | pass |
| SNAP-1 | `ironhorse-snapshot` `atom::proofs::snap1_sizes_refuse_above_u32` | nightly | atom_size(n) is Ok(n + 8) iff n + 8 <= u32::MAX, else TooLarge; appended_atom_size(body, n) is Ok(n + 8) iff body + (n + 8) + 8 <= u32::MAX, else TooLarge (sums in u128). | every body: usize and payload: usize (64-bit) | 0 | default | 32 s / 7 GB | 2 | pass |
| SNAP-1 | `ironhorse-snapshot` `atom::proofs::snap1_duplicate_scan_first_repeat` | nightly | The pairwise duplicate scan returns the tag of the first atom (file order) whose tag an earlier atom used, or None. | every list of up to 4 tags ([u8; 4] each) | 5 | default | 54 s / 7 GB | 10 | pass |
| SNAP-2 | `ironhorse-snapshot` `slot_codec::proofs::snap2_decode_total` | pr | decode_slot does not panic on any 20-byte record. | every [u8; 20] | 0 | default | 5 s / 1 GB | 0 | pass |
| SNAP-2 | `ironhorse-snapshot` `slot_codec::proofs::snap2_bad_length` | pr | decode_slot on a slice of any length other than 20 returns Err(BadLength(len)) without panicking. | every prefix buf[..len] of every [u8; 41], len <= 41 | 0 | default | 5 s / 1 GB | 0 | pass |
| SNAP-2 | `ironhorse-snapshot` `slot_codec::proofs::snap2_round_trip` | pr | decode_slot(encode_slot(s)) == Ok(s with a NaN Number canonicalised), and encode_slot of the result equals the first encoding. | every kani::Arbitrary Slot (all kinds, flags, ids, next links, payload arms and payload bits) | 0 | default | 16 s / 1 GB | 7 | pass |
| SNAP-2 | `ironhorse-snapshot` `slot_codec::proofs::snap2_accepted_is_canonical` | pr | If decode_slot(r) == Ok(s) and r's Number payload (if any) is not a non-canonical NaN, encode_slot(s) == r. | every [u8; 20] | 0 | default | 11 s / 1 GB | 7 | pass |
| SNAP-3 | `ironhorse-snapshot` `wire::proofs::snap3_reserve_hint_bounded_by_input` | nightly | reserve_hint(count, len, w) == min(count, len / w) (0 for w = 0), so it is at most count and at most len / w, and hint * w <= len. | every count: usize and payload_len: usize; width in {0, 1, 4, 8, 20, 28} | 7 | default | 185 s / 2 GB | 1 | pass |
| SNAP-3 | `ironhorse-snapshot` `wire::proofs::snap3_field_readers` | pr | be_u32_at / be_u64_at return the big-endian value at `at` iff its bytes fit, else None. | every buf[..len] of every [u8; 12], len <= 12; every at: usize | 13 | default | 6 s / 2 GB | 0 | pass |
| SNAP-3 | `ironhorse-snapshot` `image::proofs::snap3_cursor_reads_exactly` | nightly | Three Cursor reads, each u8, u16, u32 or bytes(n): each succeeds iff its bytes fit, returns exactly them, advances by exactly its width (not at all on failure) and never past the end; done() iff all bytes were consumed. | every buf[..len] of every [u8; 8], len <= 8; every op sequence of length 3; every n: usize | 5 | default | 211 s / 2 GB | 2 | pass |
| SNAP-3 | `ironhorse-snapshot` `image::proofs::snap3_decode_u32s_exact_8` | nightly | decode_u32s does not panic and accepts only [count BE][count u32s BE] with nothing after, returning those values. | every [u8; 8] | 4 | default | 70 s / 2 GB | 6 | pass |
| SNAP-3 | `ironhorse-snapshot` `image::proofs::snap3_u32s_round_trip` | pr | decode_u32s(encode_u32s(l)) == Ok(l). | every [u32; 2] | 13 | default | 13 s / 2 GB | 6 | pass |
| SNAP-3 | `ironhorse-snapshot` `format::proofs::snap3_version_decode_exact` | pr | Version::decode does not panic; an accepted payload re-encodes to itself and the version is readable. | every buf[..len] of every [u8; 12], len <= 12 | 13 | default | 5 s / 2 GB | 7 | pass |
| SNAP-3 | `ironhorse-snapshot` `format::proofs::snap3_version_round_trip` | pr | Version::decode(v.encode()) is Ok(v) iff v.is_readable(), for every Version. | every format_version: u32, slot_width: u8, endian: u8 | 11 | default | 5 s / 2 GB | 7 | pass |
| SNAP-4 | `ironhorse-vm` `opcode::proofs::snap4_instruction_len_bounded` | pr | instruction_len does not panic; Some(l) implies l >= 1, pc + l <= code.len(), and l equals the fixed size, 1 + ID_SIZE, or header width plus declared LE payload for -1/-2/-4. | every code[..len] of every [u8; 6], len <= 6; every pc: usize | 7 | default | 26 s / 5 GB | 1 | pass |
| SNAP-4 | `ironhorse-vm` `opcode::proofs::snap4_prefixed_len_any_width` | pr | prefixed_len::<u32> is Some(header + payload) iff that fits u32 (the usize of wasm32), else None; prefixed_len::<u64> and ::<usize> are always the exact sum; no instantiation panics. | every header: u8 and payload: u32 | 0 | default | 5 s / 5 GB | 0 | pass |
| SNAP-4 | `ironhorse-vm` `opcode::proofs::snap4_from_u8_round_trips` | pr | Opcode::from_u8 is total; Some(op) implies op as u8 == byte and op.size() is positive, 0, -1, -2 or -4. | every byte: u8 | 0 | default | 13 s / 5 GB | 0 | pass |
| SNAP-4 | `ironhorse-vm` `opcode::proofs::snap4_remap_ids_only_ids_6` | nightly | A successful remap_ids returns the input's length; at each ID-sentinel opcode of the walk the two operand bytes hold the map's answer for the LE ID read there; every other byte is unchanged. | every [u8; 6]; every map answer sequence (3 symbolic Option<u16>) | 7 | default | 687 s / 5 GB | 9 | pass |
| TXT-1 | `ironhorse-text` `proofs::txt1_unit_round_trip` | pr | encode_unit(u) has width 1/2/3 by range, contains no zero byte, and decode_unit inverts it. | every u: u16 | 4 | default | 5 s / 1 GB | 1 | pass |
| TXT-1 | `ironhorse-text` `proofs::txt1_decode_unit_bounded` | pr | decode_unit does not panic; Some((u, n)) implies 1 <= n <= len. | every buf[..len] of every [u8; 3], len <= 3 | 4 | default | 5 s / 1 GB | 0 | pass |
| TXT-1 | `ironhorse-regexp` `encoding::transcoder_proofs::txt1_cesu8_decode_combines_pairs` | pr | On a high surrogate's CESU-8 followed by any non-NUL unit's, cesu8_decode returns UTF16SurrogatePairToCodePoint and consumes both for a low surrogate, else the lone high surrogate consuming 3 bytes. | every high surrogate 0xD800..=0xDBFF and every next unit 1..=0xFFFF | 7 | default | 10 s / 1 GB | 4 | pass |
| TXT-1 | `ironhorse-regexp` `encoding::transcoder_proofs::txt1_utf8_decode_single_unit` | pr | utf8_decode and cesu8_decode return (u, width) on the CESU-8 of every non-NUL unit that is not a high surrogate. | every u: u16 outside {0} and 0xD800..=0xDBFF | 7 | default | 7 s / 1 GB | 7 | pass |
| STR-3 | `ironhorse-regexp` `compile::charset_proofs::str3_contains_is_scan` | pr | charset_contains(set, x) equals the linear scan of set's ranges. | every well-formed set of up to two ranges (any i32 boundaries); every x: i32 | 6 | default | 5 s / 1 GB | 1 | pass |
| STR-3 | `ironhorse-regexp` `compile::charset_proofs::str3_union` | nightly | The union sweep's output is well-formed and contains x iff a or b does; charset_contains agrees on output and input. | every pair of well-formed sets of up to two ranges with boundaries in [-2^20, 2^20]; every x: i32 | 10 | default | 258 s / 1 GB | 1 | pass |
| STR-3 | `ironhorse-regexp` `compile::charset_proofs::str3_subtract` | nightly | As str3_union, for subtraction: x in out iff x in a and not in b. | as str3_union | 10 | default | 241 s / 1 GB | 3 | pass |
| STR-3 | `ironhorse-regexp` `compile::charset_proofs::str3_intersection` | nightly | As str3_union, for intersection: x in out iff x in a and in b. | as str3_union | 10 | default | 133 s / 1 GB | 5 | pass |
| TXT-1 | `ironhorse-vm` `interp::natives::json::wtf8_proofs::txt1_code_point_units_is_utf16_encode` | pr | code_point_units(p) equals UTF16EncodeCodePoint(p) (ECMA-262 11.1.1, written from the spec text with integer / and %). | every code point p <= 0x10FFFF | 5 | default | 5 s / 2 GB | 0 | pass |
| TXT-1 | `ironhorse-vm` `interp::natives::json::wtf8_proofs::txt1_wtf8_code_point_in_range` | pr | wtf8_code_point does not panic; Some((p, w)) implies 2 <= w <= 4, w <= len, a lead of width w and continuation bytes, p their combined payload bits, and p <= 0x10FFFF. | every buf[..len] of every [u8; 4], len <= 4 | 5 | default | 6 s / 2 GB | 1 | pass |
| TXT-1 | `ironhorse-vm` `interp::natives::json::wtf8_proofs::txt1_wtf8_code_point_inverts_encoding` | pr | The WTF-8 encoding of p (two, three or four bytes; a surrogate in the generalised three-byte form) decodes to (p, width). | every code point 0x80..=0x10FFFF | 5 | default | 5 s / 2 GB | 1 | pass |
| TXT-1 | `ironhorse-vm` `interp::text::transcoder_proofs::txt1_be16_unit_order` | pr | a.to_be_bytes().cmp(&b.to_be_bytes()) == a.cmp(&b). | every a: u16 and b: u16 | 0 | default | 5 s / 2 GB | 0 | pass |
| TXT-1 | `ironhorse-vm` `interp::text::transcoder_proofs::txt1_be16_order_short_strings` | pr | units_to_be16 preserves the order of code-unit strings (byte-lexicographic == unit-lexicographic). | every pair of [u16; 2] strings, and every [u16; 1] against every [u16; 2] | 5 | default | 19 s / 2 GB | 182 | pass |
| STR-1 | `ironhorse-vm` `value::structure_proofs::str1_image_free_marks_count_0_to_2` | nightly | image_free_marks(count, free, live) is Ok iff free's entries are distinct and < count and free.len() + live == count; Ok(marks) has marks[i] iff i is in free. | slot_count in {0, 1, 2}; every free list of up to 5 u32 entries; every live: u32 | 6 | default | 84 s / 2 GB | 13 | pass |
| STR-1 | `ironhorse-vm` `value::structure_proofs::str1_image_free_marks_count_3_to_4` | nightly | As str1_image_free_marks_count_0_to_2. | slot_count in {3, 4}; every free list of up to 5 u32 entries; every live: u32 | 6 | default | 98 s / 2 GB | 13 | pass |
| STR-2 | `ironhorse-vm` `value::structure_proofs::str2_checked_block_at_progresses` | pr | checked_block_at does not panic; Ok((end, _)) implies header < end <= total. | a plain byte space of 24 symbolic bytes; every total <= 24; every header: usize | 6 | default | 6 s / 2 GB | 18 | pass |
| STR-2 | `ironhorse-vm` `value::structure_proofs::str2_chunk_allocation_fits_model` | pr | chunk_allocation_fits(h, p, c) == (h + 4 + p < c), computed in u128. | every header, payload, ceiling: usize | 0 | default | 5 s / 2 GB | 0 | pass |
| NUM-1 | `ironhorse-vm` `numeric_kernel::proofs::num1_number_to_u64_wrapping_matches_spec` | pr | number_to_u64_wrapping(b) == ironhorse_spec::truncate_to_integer_mod_2n(b, 64). | every b: u64 (all 2^64 binary64 bit patterns, every NaN payload) | 0 | default | 7 s / 1 GB | 0 | pass |
| NUM-1 | `ironhorse-vm` `numeric_kernel::proofs::num1_to_int32_matches_spec` | pr | to_int32(b) == ironhorse_spec::to_int32(b). | every b: u64 (all 2^64 binary64 bit patterns, every NaN payload) | 0 | default | 5 s / 1 GB | 0 | pass |
| NUM-1 | `ironhorse-vm` `numeric_kernel::proofs::num1_to_uint32_matches_spec` | pr | to_uint32(b) == ironhorse_spec::to_uint32(b). | every b: u64 (all 2^64 binary64 bit patterns, every NaN payload) | 0 | default | 5 s / 1 GB | 0 | pass |
| NUM-1 | `ironhorse-vm` `numeric_kernel::proofs::num1_to_int16_matches_spec` | pr | to_int16(b) == ironhorse_spec::to_int16(b). | every b: u64 (all 2^64 binary64 bit patterns, every NaN payload) | 0 | default | 5 s / 1 GB | 0 | pass |
| NUM-1 | `ironhorse-vm` `numeric_kernel::proofs::num1_to_uint16_matches_spec` | pr | to_uint16(b) == ironhorse_spec::to_uint16(b). | every b: u64 (all 2^64 binary64 bit patterns, every NaN payload) | 0 | default | 5 s / 1 GB | 0 | pass |
| NUM-1 | `ironhorse-vm` `numeric_kernel::proofs::num1_to_int8_matches_spec` | pr | to_int8(b) == ironhorse_spec::to_int8(b). | every b: u64 (all 2^64 binary64 bit patterns, every NaN payload) | 0 | default | 5 s / 1 GB | 0 | pass |
| NUM-1 | `ironhorse-vm` `numeric_kernel::proofs::num1_to_uint8_matches_spec` | pr | to_uint8(b) == ironhorse_spec::to_uint8(b). | every b: u64 (all 2^64 binary64 bit patterns, every NaN payload) | 0 | default | 5 s / 1 GB | 0 | pass |
| NUM-1 | `ironhorse-vm` `numeric_kernel::proofs::num1_to_uint8_clamp_matches_spec` | pr | to_uint8_clamp(b) == ironhorse_spec::to_uint8_clamp(b) (clamp to [0, 255], round half to even). | every b: u64 (all 2^64 binary64 bit patterns, every NaN payload) | 0 | default | 5 s / 1 GB | 0 | pass |
| NUM-6 | `ironhorse-vm` `numeric_kernel::proofs::num6_relative_index_matches_spec` | pr | relative_index(f64::from_bits(b), len) <= len for every b, and == ironhorse_spec::relative_index(b, len) whenever the model accepts b (integral or infinite). | every b: u64 and every len: u64 with len < 2^53 (assume); equality on the b the model accepts (integral or ±∞) | 0 | default | 17 s / 1 GB | 0 | pass |
| NUM-7 | `ironhorse-vm` `interp::element_proofs::num7_f64_to_f16_matches_spec` | pr | f64_to_f16_bits(f64::from_bits(b)) == ironhorse_spec::binary64_to_binary16(b). | every b: u64 (all 2^64 binary64 bit patterns, every NaN payload) | 0 | default | 5 s / 1 GB | 2 | pass |
| NUM-7 | `ironhorse-vm` `interp::element_proofs::num7_f16_round_trip` | pr | f64_to_f16_bits(f16_bits_to_f64(h)) == h. | every h: u16 that is not a binary16 NaN (assume: exponent field != 31 or trailing field == 0) | 12 | default | 5 s / 1 GB | 0 | pass |
| NUM-7 | `ironhorse-vm` `interp::element_proofs::num7_f16_to_f64_matches_spec` | pr | f16_bits_to_f64(h).to_bits() == ironhorse_spec::binary16_to_binary64(h) for a non-NaN h; a NaN h widens to a NaN. | every h: u16 (all 2^16 binary16 patterns) | 12 | default | 5 s / 1 GB | 0 | pass |
| NUM-8 | `ironhorse-vm` `interp::element_proofs::num8_int8_element` | pr | encode_element_le stores ironhorse_spec::to_int8(b) little-endian and decode_element_le reads it back as its canonical slot; decode then encode is the identity on every byte pattern. | every b: u64; every byte pattern of the element width | 0 | default | 10 s / 1 GB | 70 | pass |
| NUM-8 | `ironhorse-vm` `interp::element_proofs::num8_int16_element` | pr | encode_element_le stores ironhorse_spec::to_int16(b) little-endian and decode_element_le reads it back as its canonical slot; decode then encode is the identity on every byte pattern. | every b: u64; every byte pattern of the element width | 0 | default | 10 s / 1 GB | 69 | pass |
| NUM-8 | `ironhorse-vm` `interp::element_proofs::num8_int32_element` | pr | encode_element_le stores ironhorse_spec::to_int32(b) little-endian and decode_element_le reads it back as its canonical slot; decode then encode is the identity on every byte pattern. | every b: u64; every byte pattern of the element width | 0 | default | 12 s / 1 GB | 67 | pass |
| NUM-8 | `ironhorse-vm` `interp::element_proofs::num8_uint8_element` | pr | encode_element_le stores ironhorse_spec::to_uint8(b) little-endian and decode_element_le reads it back as its canonical slot; decode then encode is the identity on every byte pattern. | every b: u64; every byte pattern of the element width | 0 | default | 9 s / 1 GB | 69 | pass |
| NUM-8 | `ironhorse-vm` `interp::element_proofs::num8_uint16_element` | pr | encode_element_le stores ironhorse_spec::to_uint16(b) little-endian and decode_element_le reads it back as its canonical slot; decode then encode is the identity on every byte pattern. | every b: u64; every byte pattern of the element width | 0 | default | 9 s / 1 GB | 69 | pass |
| NUM-8 | `ironhorse-vm` `interp::element_proofs::num8_uint32_element` | pr | encode_element_le stores ironhorse_spec::to_uint32(b) little-endian and decode_element_le reads it back as its canonical slot; Integer iff <= i32::MAX; decode then encode is the identity on every byte pattern. | every b: u64; every byte pattern of the element width | 0 | default | 14 s / 1 GB | 67 | pass |
| NUM-8 | `ironhorse-vm` `interp::element_proofs::num8_uint8_clamped_element` | pr | encode_element_le stores ironhorse_spec::to_uint8_clamp(b) little-endian and decode_element_le reads it back as its canonical slot; decode then encode is the identity on every byte pattern. | every b: u64; every byte pattern of the element width | 0 | default | 7 s / 1 GB | 65 | pass |
| NUM-8 | `ironhorse-vm` `interp::element_proofs::num8_float64_element` | pr | encode_element_le(Float64) stores b, or the canonical NaN when b is a NaN; decode_element_le returns Slot::number of any 8 stored bytes. | every b: u64; every [u8; 8] | 0 | default | 5 s / 1 GB | 72 | pass |
| NUM-8 | `ironhorse-vm` `interp::element_proofs::num8_float16_element` | pr | encode_element_le(Float16) stores ironhorse_spec::binary64_to_binary16(b); decode_element_le returns Number(f16_bits_to_f64(h)) of any 2 stored bytes. | every b: u64; every [u8; 2] | 12 | default | 9 s / 1 GB | 58 | pass |
| NUM-2 | `ironhorse-vm` `interp::numeric::proofs::num2_bitwise_and` | nightly | int32_bitop(And, a, b) represents ironhorse_spec::int32::bitwise(And, a, b). | every a: i32 and b: i32 (the operands' ToInt32 results; ToInt32 itself is NUM-1) | 33 | default | 64 s / 1 GB | 22 | pass |
| NUM-2 | `ironhorse-vm` `interp::numeric::proofs::num2_bitwise_or` | pr | int32_bitop(Or, a, b) represents ironhorse_spec::int32::bitwise(Or, a, b). | every a: i32 and b: i32 (the operands' ToInt32 results; ToInt32 itself is NUM-1) | 33 | default | 24 s / 1 GB | 19 | pass |
| NUM-2 | `ironhorse-vm` `interp::numeric::proofs::num2_bitwise_xor` | pr | int32_bitop(Xor, a, b) represents ironhorse_spec::int32::bitwise(Xor, a, b). | every a: i32 and b: i32 (the operands' ToInt32 results; ToInt32 itself is NUM-1) | 33 | default | 21 s / 1 GB | 20 | pass |
| NUM-2 | `ironhorse-vm` `interp::numeric::proofs::num2_left_shift` | pr | int32_bitop(Shl, a, b) represents ironhorse_spec::int32::left_shift(a, b). | every a: i32 and b: i32 (the operands' ToInt32 results; ToInt32 itself is NUM-1) | 0 | default | 19 s / 1 GB | 13 | pass |
| NUM-2 | `ironhorse-vm` `interp::numeric::proofs::num2_signed_right_shift` | nightly | int32_bitop(Sar, a, b) represents ironhorse_spec::int32::signed_right_shift(a, b). | every a: i32 and b: i32 (the operands' ToInt32 results; ToInt32 itself is NUM-1) | 0 | default | 39 s / 1 GB | 14 | pass |
| NUM-2 | `ironhorse-vm` `interp::numeric::proofs::num2_unsigned_right_shift` | pr | int32_bitop(Shr, a, b) represents ironhorse_spec::int32::unsigned_right_shift(a, b): Integer iff <= i32::MAX. | every a: i32 and b: i32 (the operands' ToInt32 results; ToInt32 itself is NUM-1) | 0 | default | 13 s / 1 GB | 13 | pass |
| NUM-2 | `ironhorse-vm` `interp::numeric::proofs::num2_clz32` | pr | math_clz32(n) == ironhorse_spec::int32::clz32(n). | every n: u32 (ToUint32's result) | 34 | default | 5 s / 1 GB | 0 | pass |
| NUM-3 | `ironhorse-vm` `interp::numeric::proofs::num3_add_integer_path` | pr | apply_arith(Add, Integer x, Integer y) represents ironhorse_spec::arith::add_int32(x, y), canonically. | every x: i32 and y: i32 | 0 | default | 7 s / 1 GB | 14 | pass |
| NUM-3 | `ironhorse-vm` `interp::numeric::proofs::num3_sub_integer_path` | pr | apply_arith(Sub, Integer x, Integer y) represents ironhorse_spec::arith::subtract_int32(x, y), canonically. | every x: i32 and y: i32 | 0 | default | 9 s / 1 GB | 14 | pass |
| NUM-3 | `ironhorse-vm` `interp::numeric::proofs::num3_mul_integer_path` | nightly | apply_arith(Mul, Integer x, Integer y) represents ironhorse_spec::arith::multiply_int32(x, y), canonically. | every x: i32 and y: i32 | 0 | default | 143 s / 1 GB | 4 | pass |
| NUM-3 | `ironhorse-vm` `interp::numeric::proofs::num3_unary_minus` | pr | unary_minus(Integer x) represents ironhorse_spec::arith::unary_minus_int32(x), canonically. | every x: i32 | 0 | default | 7 s / 1 GB | 10 | pass |
| NUM-3 | `ironhorse-vm` `interp::numeric::proofs::num3_add_paths_agree` | nightly | apply_arith(Add, Integer x, Integer y) and apply_arith(Add, Number(x), Number(y)) have the same bits. | every x: i32 and y: i32 | 0 | default | 540 s / 4 GB | 4 | pass |
| NUM-3 | `ironhorse-vm` `interp::numeric::proofs::num3_sub_paths_agree` | nightly | apply_arith(Sub, Integer x, Integer y) and apply_arith(Sub, Number(x), Number(y)) have the same bits. | every x: i32 and y: i32 | 0 | default | 550 s / 4 GB | 4 | pass |
| NUM-4 | `ironhorse-vm` `interp::numeric::proofs::num4_slot_from_number` | pr | slot_from_number(b) == Integer(i) iff ironhorse_spec::arith::exact_int32(b) == Some(i), else a Number with bits b (the canonical NaN for every NaN b). | every b: u64 (all 2^64 binary64 bit patterns, every NaN payload) | 0 | default | 5 s / 1 GB | 0 | pass |
| NUM-4 | `ironhorse-vm` `interp::numeric::proofs::num4_math_to_integer` | pr | math_to_integer(b) == Integer(i) iff ironhorse_spec::arith::exact_int32(b) == Some(i), else a Number with bits b (the canonical NaN for every NaN b). | every b: u64 (all 2^64 binary64 bit patterns, every NaN payload) | 0 | default | 5 s / 1 GB | 0 | pass |
| NUM-5 | `ironhorse-vm` `interp::numeric::proofs::num5_same_value` | pr | same_value_immediate(a, b) == SameValue(a, b), and the pair never needs the arena. | every pair of immediate slots as the constructors build them: undefined, null, Boolean(any), Integer(any i32), Slot::number(f64::from_bits(any u64)) (NaN canonicalised), Reference(any SlotIndex) | 0 | default | 10 s / 1 GB | 9 | pass |
| NUM-5 | `ironhorse-vm` `interp::numeric::proofs::num5_same_value_zero` | pr | same_value_zero_immediate(a, b) == SameValueZero(a, b). | every pair of immediate slots as the constructors build them: undefined, null, Boolean(any), Integer(any i32), Slot::number(f64::from_bits(any u64)) (NaN canonicalised), Reference(any SlotIndex) | 0 | default | 10 s / 1 GB | 9 | pass |
| NUM-5 | `ironhorse-vm` `interp::numeric::proofs::num5_strict_equals` | pr | strict_equals(a, b) == IsStrictlyEqual(a, b). | every pair of immediate slots as the constructors build them: undefined, null, Boolean(any), Integer(any i32), Slot::number(f64::from_bits(any u64)) (NaN canonicalised), Reference(any SlotIndex) | 0 | default | 9 s / 1 GB | 9 | pass |
| NUM-9 | `ironhorse-vm` `interp::temporal::proofs::num9_civil_round_trip` | nightly | days_from_civil(civil_from_days(day)) == Some(day). | every day: i128 with -10^8 <= day <= 10^8 (assume; the TimeClip range) | 0 | default | 500 s / 4 GB | 0 | pass |
| NUM-9 | `ironhorse-vm` `interp::temporal::proofs::num9_days_from_civil_matches_spec_epoch_years` | pr | days_from_civil(y, m, d) == ironhorse_spec::date::day_from_civil(y, m, d), Some and None alike. | y in {1968, 1969, 1970, 1971, 1972}; every m: u32 and d: u32 | 6 | default | 20 s / 1 GB | 3 | pass |
| NUM-9 | `ironhorse-vm` `interp::temporal::proofs::num9_days_from_civil_matches_spec_boundary_years` | nightly | days_from_civil(y, m, d) == ironhorse_spec::date::day_from_civil(y, m, d), Some and None alike. | y in {-401, -400, -1, 0, 1, 1600, 1601, 1900, 1901, 2000, 2100}; every m: u32 and d: u32 | 12 | default | 45 s / 1 GB | 2 | pass |
| NUM-9 | `ironhorse-vm` `interp::temporal::proofs::num9_days_from_civil_matches_spec_time_clip_ends` | pr | days_from_civil(y, m, d) == ironhorse_spec::date::day_from_civil(y, m, d), Some and None alike. | y in {-271822, -271821, 275759, 275760} (the TimeClip year ends); every m: u32 and d: u32 | 5 | default | 20 s / 1 GB | 2 | pass |
| NUM-9 | `ironhorse-vm` `interp::temporal::proofs::num9_days_from_civil_matches_spec_1900_to_2100` | pr | days_from_civil(y, m, d) == ironhorse_spec::date::day_from_civil(y, m, d), Some and None alike. | every y: i64 in 1900..=2100 (assume); every m: u32 and d: u32 | 0 | default | 30 s / 1 GB | 2 | pass |
| NUM-9 | `ironhorse-vm` `interp::temporal::proofs::num9_days_from_civil_matches_spec_10000_years` | nightly | days_from_civil(y, m, d) == ironhorse_spec::date::day_from_civil(y, m, d), Some and None alike. | every y: i64 in -10000..=10000 (assume); every m: u32 and d: u32 | 0 | default | 900 s / 2 GB | 1 | pass |

<!-- END GENERATED: scripts/verify.py ledger -->
