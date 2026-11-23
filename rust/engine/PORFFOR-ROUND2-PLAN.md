# Round 2 plan: the interpreter under the revised ground rules

Audience: engine maintainers and the project owner, deciding what the second round of the
performance campaign builds.
Round 1 is recorded in [PORFFOR-FINDINGS.md](PORFFOR-FINDINGS.md),
[PORFFOR-PLAN.md](PORFFOR-PLAN.md) and [PORFFOR-RESULTS.md](PORFFOR-RESULTS.md).
The security properties this plan relies on are drafted separately in
[SECURITY-SEAMS.md](SECURITY-SEAMS.md).
This is a design document: nothing in it has been built or measured beyond round 1's data.
**Status (2026-11-23):** round 2 is done; each item below carries a one-line status, and
[PORFFOR-RESULTS.md](PORFFOR-RESULTS.md), "Round 2", records what shipped, what was measured and
what was deferred.

## The changed ground rules

Source: project owner direction, 2026-11-22, relayed by the project manager.
Paraphrased faithfully:

1. "XS is just a guide; the real spec is JavaScript and SES."
   Byte-identical-to-XS bytecode is no longer a requirement.
   Correctness is judged against ECMAScript and SES semantics.
2. "We're really only worried about malicious guest code, not a malicious Ironhorse operator or
   malicious snapshot (though we need to document this seam's security properties in detail)."
3. "If the hash is a perf optimization technique that's not a security issue."

**Standing assumption (project manager, not an owner decision):** computron determinism still
matters.
The same binary given the same input produces the same computrons, and Ironhorse's meter is its own
versioned cost model (`rust/engine/README.md:3-21`, "Metering objective").
This plan therefore prefers designs that leave computron totals and meter-check positions
unchanged.
Where a real win needs different counts, it is written up as an explicit meter-version bump
proposal (section C, item 9) and is not assumed approved.

**Superseded (owner direction, 2026-11-23):** determinism, lockdown and compartment sandboxing
are mandatory, computrons must approximate actual work, and computron identity with earlier
versions is no longer required; see [SECURITY-SEAMS.md](SECURITY-SEAMS.md), section 1.
Every round-2 commit turned out computron-identical anyway.

## Provenance

- **Ironhorse:** this repository at `1581b8a51a5ed87ec9c13bdf6715ddf925c25026` (branch
  `ccr-e08fb75d-kdywjp`, the round-1 tip plus its results document).
  Every `path:line` below was re-read at that commit.
- **Porffor:** `c9af40c8c6913e04d491412ae9fe0f34b97b51df`, read only, never built or run, as in
  round 1.
  Porffor is an ahead-of-time compiler, so most of the new ideas here (superinstructions,
  quickening, a derived dispatch buffer) have no Porffor counterpart; they are standard interpreter
  techniques that rule 1 makes admissible.
- **Measurements:** none new.
  Ir figures are round 1's callgrind counts at the tip `0d286eef` (code-identical to `1581b8a5`),
  from the campaign's untracked scratch directory (`raw-final/cg-tipfix/`).
  Per-op figures divide a workload's Ir by its dispatch count from `PORFFOR-FINDINGS.md:111-133`.

## A. What in the repository encodes the old rules

### A.1 XS byte identity and XS parity

| # | Site | What it enforces | Runs in CI | Recommendation |
|---|---|---|---|---|
| 1 | `rust/engine/ironhorse-compile/tests/coder_byte_identity.rs:1-21` | `compile_with(src, false)` equals `xs_oracle::run(src).bytecode` byte for byte on a corpus; at `:262-277` it compares under `with_xs_bytes` and pins that each deliberate departure still departs | Yes, oracle lane only: `required-features = ["parity"]` (`ironhorse-compile/Cargo.toml:37-39`), run by `test-ironhorse-oracle` (`.github/workflows/ci.yml:1170`) | **Keep, re-scope the claim**: the coder's output stays XS-identical modulo the pinned departures, and is the guide; any optimisation happens in a separate VM-side pass (A.4) that this test never sees |
| 2 | `rust/engine/ironhorse-compile/src/coder.rs:1060-1092` (`with_xs_bytes`) | The compiler already departs from XS's bytes in three places (`delete o?.b`, `(eval)(s)`, CreateDataProperty for spread fill) and can emit XS's bytes for differential harnesses | Through item 1 | **Keep**; it is the existing mechanism for "XS is a guide": a spec-driven coder change becomes one more departure row |
| 3 | `rust/engine/ironhorse-262/src/compile_diff.rs:1-33` (`compile-diff` binary, "the STAGE BAR") | Full-corpus byte identity under `with_xs_bytes`; "a byte divergence ... is the KILL CRITERION signal" | Only its unit tests (`ironhorse-262/tests/compile_diff_panic_hook.rs`); the binary itself is run by hand (`CHANGELOG.md:1813`) | **Keep as a guide, retire the kill-criterion wording**: a divergence is a finding to classify (bug, or a new departure), not a kill signal |
| 4 | `rust/engine/ironhorse-fuzz/fuzz/fuzz_targets/differential_compile.rs:1-25`, `rust/engine/ironhorse-fuzz/src/lib.rs:2301-2326` | Fuzzed byte identity against the oracle compiler; panics on `ByteDivergence` | `fuzz-ironhorse` tripwire (`.github/workflows/ci.yml:1202`) and the deep-fuzz schedule | **Keep**; note that it calls `compile_with` without `with_xs_bytes`, so a generated program that reaches a departure would report a false divergence (none has, as far as the record shows); wrap it like item 3 |
| 5 | `rust/engine/ironhorse-vm/src/opcode.rs:1-3` ("GENERATED from c/moddable ... Do not edit by hand"), `:253-256` (`XS_CODE_COUNT = 246`), `rust/engine/scripts/generate-compiler-opcodes.py:13-18` (dense enum check), CI at `.github/workflows/ci.yml:776-777`, spot check `rust/engine/ironhorse-vm/src/lib.rs:242-251` | The VM's opcode numbering is XS's, dense, and is the source of the compiler's constants | Yes (`format-ironhorse`, `test-ironhorse`) | **Keep**; do not add superinstructions to this enum; they live in a separate derived tag space (A.4, C item 2) |
| 6 | `rust/engine/ironhorse-262/tests/xs_departures.rs:1-20`, `rust/engine/README.md:223-236` | Results ratchet against XS: every deliberate departure, kept XS answer, shared bug and gap is a row run on both engines | Oracle lane | **Keep**; it already encodes rule 1 ("matches XS unless XS contradicts the specification", `:5-6`); reword the README's first sentence from "answers as the pinned XS oracle unless" to "answers as ECMAScript and SES specify; XS is the reference implementation consulted" |
| 7 | `endot-ih` with `--oracle` on by default (`rust/engine/ironhorse-262/src/bin/endot_ih.rs:6-7`, `:534`), gated in CI at `.github/workflows/ci.yml:1182-1199` | test262 slices and the Ironhorse corpus must agree with XS's verdict and observables | Yes, PR gate (oracle lane) | **Keep**; results parity is unaffected by any item in this plan, because every item preserves observables; disagreements that the spec resolves for Ironhorse go to item 6's table |
| 8 | `rust/engine/ironhorse-262/tests/intrinsic_key_order.rs:1-4` | Own-key order of every intrinsic equals XS's | Oracle lane | **Keep as-is** (key order is observable; matching XS is a reasonable reference where the spec leaves order to the implementation) |
| 9 | `rust/engine/ironhorse-regexp/tests/parity.rs`, `rust/engine/ironhorse-fuzz/src/regexp.rs:232`, `rust/engine/ironhorse-fuzz/src/snapshot.rs:905`, `:964` | Regexp results and snapshot round-trip programs compared with XS | Oracle lane, fuzz lanes | **Keep**; results only |
| 10 | `designs/ironhorse-engine.md:90-91` (kill criterion: "Stage 5 cannot reach byte-identical bytecode output") and `:1029` (roadmap row 5 bar) | Historical stage bar | Not a test | **Retire** the kill criterion; annotate as met historically and superseded by rule 1 |
| 11 | `designs/ironhorse-engine.md:399-401` ("no execution-count-dependent behavior, no fast paths whose cost differs from the metered count") | Forbids quickening and cost-divergent fast paths | Not a test; round 1 treated it as binding (`PORFFOR-FINDINGS.md:70`) | **Keep but re-scope**: "no execution-count-dependent *observable or metered* behaviour; host-side fast paths, including derived dispatch buffers, are allowed when results, computrons and meter-check positions are identical" |
| 12 | `designs/ironhorse-engine.md:406-409` ("the same frame geometry as XS") and `rust/engine/ARCHITECTURE.md:49` ("The opcode enum and decoding metadata follow the pinned XS bytecode format") | Stack and opcode layout follow XS | Not a test | **Keep**; nothing in this plan changes either |
| 13 | `rust/engine/ironhorse-compile/Cargo.toml:3` (description: "replaces the oracle compiler behind a byte-identical-bytecode bar") | Description only | No | **Reword** at the owner's convenience: "an XS-derived compiler whose output is compared with XS's as a guide" |
| 14 | `designs/ironhorse-engine.md:92-99` and `rust/engine/benches/xs_compare.py --check-micro` (nightly, `.github/workflows/ironhorse-full-test262.yml:70`) | Performance envelope: geomean within 2.0x of XS | Nightly, report only | **Keep** as telemetry; it measures speed, not identity |
| 15 | `rust/engine/README.md:9-21` | Computron parity with XS is already a non-goal | - | **Keep**; this is the basis of the standing assumption |

Computron parity with XS was never a gate (item 15), so rule 1 changes nothing about the meter.
The only identity gate rule 1 actually touches is the coder's (items 1-4), and the least disruptive
way to honour it is to leave that gate alone and put new transformations after the coder.

### A.2 Defences against a malicious snapshot or operator that cost something at run time

The store was already made trusted on 2026-09-24 (`designs/ironhorse-snapshot-store-seam.md:11-31`:
"A heap store is the canonical representation of the machine it holds, and Ironhorse trusts it as
such"), and that phase removed the hash tree, seals and run-time re-checks (`:35-61`).
Rule 2 extends the same stance to containers and to bytecode.
What remains:

| # | Site | What it does | Cost and when | Recommendation |
|---|---|---|---|---|
| 1 | `rust/engine/ironhorse-vm/src/interp/dispatch.rs:291-344` | Per-opcode decode checks: `pc >= len`, `Opcode::from_u8`, resolved length, truncation; `designs/ironhorse-engine.md:894-897` says the loader "must not panic on corrupt input from a bad snapshot or a buggy compiler" | Every dispatch | **Re-scope** (C item 5): verify each buffer once when it is installed (the relink walk at `rust/engine/ironhorse-vm/src/interp/link.rs:1227-1245` and `:1380-1400` already decodes every instruction), then dispatch over verified buffers without per-op decode refusals; a corrupt buffer is still refused, at install rather than mid-run |
| 2 | `rust/engine/ironhorse-snapshot/src/image.rs:5438` | Container admission re-encodes the whole image and compares bytes (`encode_machine(&image)? != buf`) | One extra full encode per container read | **Measure, then consider** moving it to the explicit validator, as phase 13 did for stores; it guards canonical form (one machine, one encoding), which is a content-addressing property, not a guest defence |
| 3 | `rust/engine/ironhorse-snapshot/src/image.rs:5450-5460` | Scans for stored property ids outside the name tables | Linear in the heap at container read | **Keep**: a bad id would otherwise surface as a panic or a wrong key, so this is robustness |
| 4 | `rust/engine/ironhorse-vm/src/interp/persist.rs:23-160`, `rust/engine/ironhorse-vm/src/interp/restore.rs:68-130` | Liveness, kind and acyclicity checks on every restored row reference; quiescence and lockdown-marker checks | Linear in restored rows | **Keep**: these turn an inconsistent image into a `RestoreError` instead of a panic; their cost is restore-only |
| 5 | `rust/engine/ironhorse-vm/src/interp/restore.rs:156-245` (`validate_suspended_cursors`) | Checks each suspended generator and async frame's `resume_pc` and handler pcs against its function's instruction starts | For each distinct suspended function it walks the body and then scans **every** function (`:212-226`), so frames x functions | **Keep, fix the complexity** (sort intervals once); it is also exactly the check a fused dispatch buffer relies on (A.4) |
| 6 | `rust/engine/ironhorse-snapshot/src/machine.rs:1280-1300` and `rust/engine/ARCHITECTURE.md:225-229` | Store open: compatibility gates (format, schema, signature with boot fingerprint, cost table) and decode bounds checks; no digest re-verification | Open only | **Keep**: the compatibility gates protect determinism (a heap must not resume under another meter, `rust/engine/ironhorse-snapshot/src/image.rs:132-148`) |
| 7 | `rust/engine/ironhorse-vm/src/value.rs:1296-1318` | Every slot access tests `self.lazy` for lazy paging | Every slot read | **Keep**; it serves lazy restore, not defence |

None of these sits on a hot path except item 1, so rule 2's performance value is mainly the
per-op decode checks; everything else is restore-time and worth at most a constant factor on
open.

### A.3 How bytecode is stored, linked, persisted and addressed

These facts decide what an optimiser may do.

- **Buffers.** Bytecode lives in immutable `Rc<[u8]>` buffers: one per eval/`Function` unit
  (`rust/engine/ironhorse-vm/src/interp/eval.rs:152-154`), plus the crank's top-level program,
  shared with the caller (`rust/engine/ironhorse-vm/src/interp.rs:2881-2883`, `:3099`) and
  promoted into `code_segments` at its first function definition
  (`rust/engine/ironhorse-vm/src/interp/code.rs:21-33`).
  The table is declared at `rust/engine/ironhorse-vm/src/interp/state.rs:475-536`.
- **Linking.** Before a crank runs, `relink_crank`
  (`rust/engine/ironhorse-vm/src/interp/link.rs:1380`)
  and, for eval units, `relink_program_symbols` (`:1227`) copy the bytes and rewrite every 2-byte
  symbol-id operand through the realm's name table.
  So the bytes that execute and persist are already a VM-side transform of the coder's output, not
  the coder's bytes; a post-coder pass has precedent.
- **Addressing.** Everything that points into code is a byte offset into a specific buffer:
  function bodies (`FunctionRow.body_start`/`body_len`,
  `rust/engine/ironhorse-vm/src/interp/persist.rs:1578-1590`), return addresses (`ret_pc`,
  `rust/engine/ironhorse-vm/src/interp.rs:2157`), catch targets (`CatchJump.target_pc`,
  `:2259-2261`),
  suspended frames' `resume_pc` and saved handlers (`:2312-2350`), and branch operands relative to
  the branch (`branch_target`, `:3646`).
  The landing check for a catch compares buffer identity by pointer
  (`rust/engine/ironhorse-vm/src/interp/code.rs:36-44`).
- **Persistence.** A snapshot writes each referenced segment's bytes verbatim
  (`rust/engine/ironhorse-vm/src/interp/persist.rs:1563-1568`) and every pc as a `u64` offset
  (`:2455-2487`); restore installs the bytes back (`:1834`) and validates suspended cursors against
  instruction starts (A.2 item 5).
  Snapshots are taken only of quiescent machines at completed-crank boundaries
  (`rust/engine/ARCHITECTURE.md:218-220`), so the only pcs inside code at snapshot time are
  suspended generators' and async functions' `resume_pc` and their saved handler targets.
- **Readers other than dispatch.** Several paths re-read opcode bytes outside the dispatch loop:
  parameter mapping (`rust/engine/ironhorse-vm/src/interp/environment.rs:460-480`), local counting
  (`rust/engine/ironhorse-vm/src/interp.rs:3595-3610`), the derived-class test
  (`rust/engine/ironhorse-vm/src/interp/dispatch.rs:2311-2317`), one-instruction lookahead in
  variable access (`:1523`, `:1634`), the disassembler
  (`rust/engine/ironhorse-vm/src/lib.rs:178-193`)
  and the relink walkers.
- **Debug lines.** `LINE`, `FILE`, `DEBUGGER` and `PROFILE` are dispatched as metered no-ops
  (`rust/engine/ironhorse-vm/src/interp/dispatch.rs:998-1009`); there is no pc-keyed source map or
  breakpoint table to keep in step.
- **`id_map`.** It is a per-activation `IntMap<u16, usize>` from key id to local index, shared by
  `Rc` with catch and suspend checkpoints (`rust/engine/ironhorse-vm/src/interp.rs:2265`,
  `:2318`) and persisted as rows (`rust/engine/ironhorse-vm/src/interp/persist.rs:2459`); it
  does not address code.

### A.4 Consequence: where an optimiser should live

Rewriting the persisted bytes in place, or changing the coder, would move every one of those
offsets, change the snapshot bytes (`state_golden`), and break every reader in the list above.
A transformation that **preserves layout** avoids all of that:

- Keep the canonical buffer exactly as today: operands, walkers, lookahead, identity checks,
  persistence and restore validation all keep reading it.
- Beside each buffer, build a **derived dispatch-opcode buffer** of the same length, identical
  except that the opcode byte at selected instruction starts is replaced by a superinstruction tag
  from a separate tag space (values 246-255 are free in the XS byte space,
  `rust/engine/ironhorse-vm/src/opcode.rs:253-256`, and
  one tag can name a pattern family whose members are re-read from the canonical bytes).
- The dispatch loop reads its opcode from the derived buffer and everything else from the canonical
  one.
  A superinstruction at pc `A` covering instructions `A, B, ...` leaves `B`'s bytes untouched, so a
  jump, catch target or `resume_pc` that lands on `B` still finds a valid instruction; no pc
  anywhere changes meaning.
- The derived buffer is never persisted; it is rebuilt when a segment is installed (eval, crank
  entry, restore), as `property_index` is (`rust/engine/ironhorse-vm/src/property_index.rs:1-2`).
  A machine restored from a snapshot therefore runs the same canonical bytes as its live twin, with
  a freshly built (and identical, since the builder is a pure function of the bytes) dispatch
  buffer.
- If the lookup from a canonical buffer to its derived buffer ever fails, dispatch uses the
  canonical buffer itself; correctness never depends on the optimiser.

This keeps the byte-identity test, the oracle and the snapshot goldens meaningful unchanged, and it
makes the optimiser switchable for differential testing.

## B. Every round-1 deferral, re-evaluated

"Blocker" quotes the round-1 reason.
"Rule effect" says which of the new rules, if any, removes it.
Effects: **R** results, **C** computrons, **S** snapshot bytes.

### B.1 Round-1 "does not transfer" and "deferred" items

| Item | Round-1 blocker (precise) | Rule effect | Win evidence | Cost | JS/SES risk | C | S |
|---|---|---|---|---|---|---|---|
| T6 shapes | Changes heap layout, the metered slot-allocation sequence and snapshot rows (`PORFFOR-FINDINGS.md:255`) | Rule 1 frees the rows from XS's, but shape slots would still be allocated and metered (`rust/engine/ironhorse-vm/src/meter.rs:227`) | IC-class win, see T7 | Very large | High | Changes unless shapes are host-side only | Changes |
| | **Verdict:** still deferred; the derived form of a shape is the IC epoch of C item 7, which needs no layout change. | | | | | | |
| T7, T8, T23 inline caches | Needs "a live `SlotIndex`'s membership in the exotic side tables never changes once observable" for about 15 tables, or an epoch bump on every insert; unproven because construction paths run guest code between allocation and registration (`PORFFOR-RESULTS.md:232-241`) | **None**: a proof burden, not an XS rule | `dispatch_get_property` 16.7% and `find_property` 9.4% of `prop_getset_fn`; 7.2% and 3.4% of `method_calls_fn` (tip profiles) | Large | A wrong hit is a wrong value and can defeat `Object.freeze` or a getter: an SES integrity bug | None if hit and miss charge alike (they charge only dispatch today) | None (derived) |
| | **Verdict:** feasible after C item 3, whose superset bits replace the membership proof; do as C item 7. | | | | | | |
| T10 per-key intercept bitset | Every writer of `XS_DONT_SET`/`XS_GETTER_FLAG` and every synthesized non-writable property would have to set the bit; flags are written through `get_mut`, so there is no single hook (`PORFFOR-RESULTS.md:208-213`) | None | `ctor_fn` after `6ac8bbed` (unmeasured remainder) | Medium | Wrong clear bit skips a setter or ignores non-writability | None | None |
| | **Verdict:** still deferred; lower priority than C items 3 and 7, which reach the same walks. | | | | | | |
| T19 no index keys on prototypes | One missed writer of the monotone flag is a silent wrong `undefined` (`PORFFOR-RESULTS.md:195-201`) | None | About 13% of `array_hole_fn` before the hasher, ceiling about 1.15x | Medium | As stated | None | None |
| | **Verdict:** after C item 3, using the superset-bit trick (a stale set bit only costs the slow path). | | | | | | |
| T12 string append builders | A builder changes which chunks are allocated (metered, `rust/engine/ironhorse-vm/src/meter.rs:248`), and aliasing needs compiler-inserted seals (`PORFFOR-FINDINGS.md:261`, `:449-453`) | Rule 1 allows seal opcodes, but the chunk sequence and `HeapExhausted` positions would change | `string_concat` still 2.05x time against 5.2x Ir (`PORFFOR-RESULTS.md:440-442`) | Large | Medium | **Changes** (and where `HeapExhausted` lands) | Changes |
| | **Verdict:** meter-bump proposal only (C item 9). | | | | | | |
| T13 monomorphic builtin dispatch | "Depends on the cheaper lookups; metering must match the generic path" (`PORFFOR-PLAN.md:469`) | None | Not profiled at the tip | Medium | Low if keyed on callee identity | None | None |
| | **Verdict:** later; fits as a GET_PROPERTY+CALL superinstruction after C items 2 and 7. | | | | | | |
| T14 type-switch pruning | `eval`, `Function` and snapshots make no type impossible (`PORFFOR-FINDINGS.md:263`) | None | - | - | - | - | - |
| | **Verdict:** does not transfer. | | | | | | |
| T15 constant folding | "Bytecode must equal XS's" (`PORFFOR-FINDINGS.md:264`) | **Rule 1 removes it**, but folding in the coder removes dispatches and changes compile metering (`rust/engine/README.md:29-30`) | Little: the roster's loops have no foldable constant expressions | Small | Low | Changes in the coder; unchanged as a superinstruction that charges its parts | Unchanged as a superinstruction |
| | **Verdict:** only as a "constant-operand" superinstruction family (C item 2). | | | | | | |
| T16 unboxed typed locals | Needs different bytecode or quickening (`PORFFOR-FINDINGS.md:265`) | Rule 1 removes the bytecode objection | `Slot` already carries an unboxed `Payload::Integer`; the remaining cost is tag tests and stack traffic | Very large (type inference, new frame layout) | High | Changes unless guarded | Changes if frames change |
| | **Verdict:** not worth it; integer-guarded superinstructions capture most of it. | | | | | | |
| T17 calling convention | Thunks need a compiler; per-call `Vec`s bounded at 4.4% (`PORFFOR-RESULTS.md:257-264`) | Rule 1 allows the compiler part; rule 2 allows a snapshot row change for `id_map` | Call path at the tip: `enter_call` 6.0%, `exec_run` 5.1%, `leave_call` 2.8%, allocator 10.6%, `HashMap::insert` 3.0% of `func_calls_fn` | Medium | Medium (`id_map` drives eval/`with` name resolution) | None | `id_map` rows change if made lazy |
| | **Verdict:** C item 8. | | | | | | |
| T20 arena redesign | Allocation order and chunk layout are metered and snapshotted (`PORFFOR-FINDINGS.md:269`) | Rule 1 frees layout from XS, not from the meter | Allocator share is malloc for host `Vec`s, not the arenas | Large | Low | Changes | Changes |
| | **Verdict:** rejected. | | | | | | |
| T22 cheap exceptions | Lazy messages change allocation (`PORFFOR-FINDINGS.md:271`) | None | No profile shows throws | Tiny | None | None for `#[cold]` | None |
| | **Verdict:** opportunistic `#[cold]` only. | | | | | | |
| T24 PGO and LTO | Stack-height gate failures and no held-out gain (`PORFFOR-RESULTS.md:362-380`) | None | PGO 1.20x Ir in-sample, none held out | Small | None | None | None |
| | **Verdict:** revisit only with a broad training corpus; unchanged. | | | | | | |
| T25 partial inlining | An interpreter must push a frame (`PORFFOR-FINDINGS.md:274`) | None | - | - | - | - | - |
| | **Verdict:** does not transfer. | | | | | | |

### B.2 Round-1 Ironhorse-specific deferrals

| Item | Round-1 blocker | Rule effect | Evidence | Verdict |
|---|---|---|---|---|
| Global `var` fast path (plan 2.4) | Must reproduce accessor, Proxy-global, compartment and TDZ behaviour (`PORFFOR-RESULTS.md:246-255`) | None | `int_loop` is 7,074M Ir against `int_loop_fn`'s 2,233M (3.17x); global-access functions are 43.7% of `int_loop` self time (`exec_get_variable` 12.0%, `find_property` 11.3%, `exec_set_variable` 6.2%, `ordinary_get_own_descriptor` 5.2%, `exec_eval_reference` 5.1%, `ordinary_get` 3.9%) | C item 6, a cache validated by an epoch, after C item 3 |
| Caching resolved globals | Same as above | None | Same | Same item |
| Per-call pooling (E8) | Measured bound about 4.4%; `reserved_vec` under the admission audit | None | Allocator 10.6% of `func_calls_fn` at the tip | C item 8 |
| Dense array storage (#12) | "Medium risk; `side_charge` must charge the same, and the row stream must stay ascending" (`PORFFOR-PLAN.md:467`) | Rule 1 frees row layout from XS, but the row stream is still canonical (`state_golden`) and the side charge is consensus state (`rust/engine/ironhorse-vm/src/side_storage.rs:11-27`) | `BTreeMap::get` 7.65% of `array_rw_fn` (181.9M Ir) | C item 4, keeping both the declared widths and the row stream |
| Loop-header remainder | Folding `step_limit`, the bounded-run ceiling and the id-space latch needs every writer to maintain the flag (`PORFFOR-RESULTS.md:330-332`) | **Rule 2 removes the decode half**: the per-op decode refusals guard against corrupt bytecode, which is now out of the threat model | `dispatch_at_inner` self time is 85 Ir per op on `empty_loop_fn` and 83 on `int_loop_fn` | C item 5 (verified install) and C item 2 (fewer headers) |
| Per-slot exotic-class tag | The "next step" for T7, T19 and T10, never designed in detail | None (it was scope, not a rule) | Up to 16 hash probes per `o.x` before the ordinary path (`rust/engine/ironhorse-vm/src/interp/dispatch/property_read.rs:15-347`) | C item 3, as superset bits |
| Number `==` and unary fast paths | No roster workload | None | - | Add a workload, then the `b25b8971` pattern; small |

### B.3 Ideas the relaxation enables

| Idea | What it needs | Win evidence | Cost | JS/SES risk | C | S | Verdict |
|---|---|---|---|---|---|---|---|
| Superinstructions (opcode fusion) | A.4's derived dispatch buffer | Dispatch is most of the time on simple code: `dispatch_at_inner` self is 89.8% of `empty_loop_fn`, 77.6% of `int_loop_fn`, 51.8% of `func_calls_fn`; each fused pair skips one loop header and one push/pop pair | Medium | Low if fusions are pure and guarded | Unchanged by construction (below) | Unchanged | **C item 2** |
| Quickening (rewrite in place after first execution) | A mutable dispatch buffer (`Rc<[Cell<u8>]>` is safe Rust) | Over static fusion, only where the profitable form depends on run-time types | Medium | Low | Unchanged if guarded | Unchanged (never persisted) | **Not now**: static fusion with inline type guards gets most of it, deterministically; revisit with data |
| Integer-specialised opcodes | Guards inside superinstructions | Round 1's int fast paths gave 1.76x on `int_loop_fn` (`PORFFOR-RESULTS.md:65`) by removing coercion; fusion removes the stack traffic around them | Small inside item 2 | Low | Unchanged | Unchanged | Part of C item 2 |
| Constant-operand opcodes | Fusion of `INTEGER_*` with arithmetic or compare | The loop bound and `* 3` style constants of the roster | Small | None | Unchanged | Unchanged | Part of C item 2 |
| Peephole removal of stack shuffles (`SET_LOCAL; POP` and similar) | Removing a dispatch changes computrons | One header per removed op | Small | None | **Changes** if removed; unchanged if fused and charged as two | Unchanged | Fuse, do not remove (C item 2); removal is C item 9 |
| Coder changes (emit `PULL_LOCAL`, fold, new opcodes) | Rule 1 | Same as the peephole row | Medium | Low | **Changes** (fewer dispatches, compile metering) | Changes | Meter bump only (C item 9) |
| Install-time verification instead of per-op decode checks | Rule 2 | See C item 5 | Small | None | Unchanged | Unchanged | **C item 5** |
| Cheaper restore validation | Rule 2 | Restore-only; A.2 items 2 and 5 | Small | None | None | None | Measure first; low priority for a throughput campaign |
| Cheaper hashing | Rule 3 | SipHash is already gone from the hot paths at the tip: `hash_one` and `sip` do not appear in the top entries of `method_calls_fn`, `prop_getset_fn` or `func_calls_fn` | - | - | - | - | Done in round 1; rule 3 confirms the integer hasher was the right call; see `SECURITY-SEAMS.md` for the residual HashDoS position |

### B.4 How a fused opcode keeps computrons and abort points identical

The dispatch loop does, per opcode: the 4096-dispatch meter check
(`rust/engine/ironhorse-vm/src/interp/dispatch.rs:222-228`), the step limit (`:264`), the
bounded-mode slot ceiling (`:278`), the id-space latch (`:288`), decode (`:291-344`), one
`tick_code` and one `n_dispatched` (`:304-305`) and the calibration histogram (`:309`).
A superinstruction covering `k` canonical instructions is exact if:

1. It is entered only when none of the `k - 1` inner loop tops would have fired a check: the
   dispatch count `N` before it satisfies `N % 4096 <= 4096 - k`, `N + k - 1 < step_limit`, and the
   machine is not in bounded mode (`step_limit != u64::MAX`, which only tests and fuzzing use).
   Otherwise it executes its first instruction only, through the ordinary arm, and continues at the
   next canonical pc.
2. Its constituents cannot set the id-space latch (none interns a key), cannot allocate, cannot call
   guest code, cannot suspend, and cannot throw once their guards pass.
   Every guard (operand kinds, integer range, uninitialised-local test) is evaluated before any
   effect; a failed guard falls back as in rule 1.
3. It charges `k` code units (`tick_code_n(k)`, `rust/engine/ironhorse-vm/src/meter.rs:206-208`),
   adds `k` to `n_dispatched`, records each constituent with `cost.on_dispatch` (the calibration
   golden runs in CI with that feature, `.github/workflows/ci.yml:985`), and performs a backward
   branch's `check_meter` after all `k` ticks, which is where the unfused sequence performs it,
   since each tick precedes its opcode's body.
4. Under `cfg(test)`, the `GC_AT_STEP`/`PANIC_AT_STEP` hooks
   (`rust/engine/ironhorse-vm/src/interp/dispatch.rs:237-260`) see every
   count: fusion is disabled while either is armed.

Under those rules the meter host sees the same sequence of checks at the same indices, every
`MeterAbort` and `StepLimit` lands at the same dispatch count and pc, and the computron total is
identical.

## C. Ranked round-2 plan

Each item is one reviewable commit series.
Every item keeps the round-1 invariants (`PORFFOR-PLAN.md:13-45`): identical computrons and check
positions, identical slot and chunk allocation, identical snapshot bytes, identical observables,
no `unsafe`, `overflow-checks` on, slow halves out of line.
Every item adds to the round-1 gates (`PORFFOR-PLAN.md:47-60`) the new differential gate D below.

### The new differential gate (D)

**Status:** built (`2ef6265e2`, `4e6a5278e`); since `c3e9e775a` it runs every accelerator on
against all off; see [PORFFOR-RESULTS.md](PORFFOR-RESULTS.md), "Round 2".

A switch on `Interp` (test-visible, default on once item 2 lands) turns all derived accelerators
of this round off: the dispatch buffer, exotic bits and caches.
A new integration test, `ironhorse-vm/tests/optimised_differential.rs`, runs each program twice on
fresh machines, accelerated and plain, and asserts equality of: the `RunOutcome` (result, halt,
`computrons`, `dispatched`, `meter_raw`); the sequence of meter-host check callbacks with the index
at each; and the snapshot bytes after the run.
Corpus: the roster, the `golden_computrons` fixtures, the `ironhorse-262` corpus programs
(`compile_diff::corpora_programs`, already used by
`ironhorse-262/tests/generated_multi_crank.rs:3`),
and generated loops.
Two sweeps target the fusion edges: a meter-limit sweep that forces a `MeterAbort` at every
dispatch count in a window around several 4096 boundaries, and a `step_limit` sweep over the same
window; both compare halt pc and counts.
A snapshot sweep suspends generators and async functions at every `yield`/`await` inside fused
regions, snapshots, restores into an accelerated and a plain machine, and compares the resumed runs.
A fuzz target variant of `differential_source` runs the same comparison on generated sources.
Any difference fails, regardless of timing.

### 1. Instruments: pair census, line profile, the switch (small; prerequisite)

**Status:** shipped as `2ef6265e2`; see [PORFFOR-RESULTS.md](PORFFOR-RESULTS.md), "Round 2".

- Extend the `cost-calibration` histogram (`rust/engine/ironhorse-vm/src/cost.rs:101-108`) with
  dynamic opcode pair and triple counts keyed by the previous opcode, compiled away without the
  feature, and print them from the roster (`ironhorse-vm/tests/porffor_micro_bench.rs`), the
  gated fixtures and an SES boot.
- Take one callgrind profile of `empty_loop_fn` and `int_loop_fn` with line tables, to split
  `dispatch_at_inner`'s 85 Ir per op into header and inlined bodies; round 1's profiles have no
  line attribution.
- Add the switch and the skeleton of gate D.
- Files: `ironhorse-vm/src/cost.rs`, `ironhorse-vm/tests/porffor_micro_bench.rs`,
  `ironhorse-vm/src/interp/state.rs` (one field), `ironhorse-vm/tests/optimised_differential.rs`.
- Gates: clippy, fmt, `golden_computrons` with `cost-calibration`.
- Output: the ranked list of fusion candidates that item 2 implements, recorded in a results file.

### 2. Layout-preserving superinstructions (medium; the breakthrough candidate)

**Status:** shipped as `4e6a5278e` (`empty_loop_fn` 0.487, `int_loop_fn` 0.720 in Ir); see
[PORFFOR-RESULTS.md](PORFFOR-RESULTS.md), "Round 2".

- **Design:** A.4 and B.4.
  A pure builder (`ironhorse-vm/src/interp/fuse.rs`, new) walks a verified buffer and returns the
  derived dispatch buffer; it runs where segments are installed
  (`rust/engine/ironhorse-vm/src/interp.rs:3099` for the crank,
  `rust/engine/ironhorse-vm/src/interp/eval.rs:152-154`,
  `rust/engine/ironhorse-vm/src/interp/code.rs:21-33` for promotion,
  `rust/engine/ironhorse-vm/src/interp/persist.rs:1834` on
  restore).
  `dispatch_at_inner` (`rust/engine/ironhorse-vm/src/interp/dispatch.rs:218`) gains the derived
  buffer, looked up once per entry
  by buffer identity, falling back to the canonical buffer.
  Fused arms stay register-sized; their slow halves are the existing arms.
- **First candidates, to be confirmed by item 1's census:**
  `GET_LOCAL; INTEGER_n; LESS|LESS_EQUAL|MORE|...; BRANCH_ELSE_n` (loop test, integer guarded),
  `GET_LOCAL; INCREMENT; SET_LOCAL; POP` (the `i++` statement, reusing `step_integer_in_place`),
  `SET_LOCAL; POP`,
  `GET_LOCAL; GET_LOCAL`,
  `GET_LOCAL; INTEGER_n; <arith>` (integer guarded),
  and compare-then-branch generally (removing the Boolean push, pop and `truthy`).
  The opcode sequences above are the expected XS coder output for the roster loops; item 1's
  disassembly (`MICRO_DISASM`) confirms them before any is built.
- **Exclusions:** anything that can call, allocate, intern, suspend, throw past a guard, or read the
  meter; `LINE`/`FILE`; instructions whose canonical bytes other readers re-interpret are
  unaffected, since they read the canonical buffer.
- **Expected win (estimate, not measured):** on local-variable loops each fused pair removes one
  loop header and usually one push/pop pair; with `dispatch_at_inner` at 85 Ir per op and
  comparison plus truthiness at 7.6% of `empty_loop_fn` (`relational` 5.28%, `truthy` 2.34%),
  1.2-1.5x on `empty_loop_fn`, `int_loop_fn`, `typed_array_fn` and `string_charcode_fn`, and
  1.0-1.1x on property- and call-bound workloads.
  Published interpreter work reports wins of that order for static superinstructions; this
  engine's figure is unknown until the prototype.
- **Kill criterion:** if the first three fusions do not cut `empty_loop_fn` or `int_loop_fn` Ir by
  at least 10%, stop and record why (most likely the native frame cost of more arms).
- **Risks:** the native stack-height gate (`dispatch_at_inner`'s frame is gated,
  `rust/engine/STACK-DEPTH-REFACTOR.md:863`); host memory for the derived buffer, equal to the
  bytecode size, derived and uncharged like `property_index` (see `SECURITY-SEAMS.md`, open
  question on retained code); the `dispatch_loop_control_transfer` and
  `allocation_admission_audit` source audits, which fused arms must satisfy.
- **Gates:** round 1's list, gate D with all three sweeps, and `stack_height.py --check` (nightly in
  CI, `.github/workflows/ironhorse-full-test262.yml:244`, so run it by hand before merge).
- **Keep if:** `empty_loop_fn` and `int_loop_fn` each improve by at least 15% in Ir and no
  workload regresses beyond the round-1 noise rule.
- **Snapshots:** unchanged; nothing is persisted, and restore rebuilds the same buffer.

### 3. Exotic-membership superset bits (medium)

**Status:** shipped as `5d71c8b91` (`proto_method_fn` 1.18x, `prop_getset_fn` 1.14x in Ir); see
[PORFFOR-RESULTS.md](PORFFOR-RESULTS.md), "Round 2".

- **Problem:** every `o.x` on an ordinary object probes up to 16 side tables (`arrays`,
  `wrapper_data`, four Temporal tables, `disposable_stacks`, `array_buffers`, `typed_arrays`,
  `data_views`, `regexps`, `locales`, `collators`, `functions`, `proxies`) before the ordinary path
  (`rust/engine/ironhorse-vm/src/interp/dispatch/property_read.rs:15-347`); `dispatch_get_property`
  spends 280.8M Ir self on 1.2M reads in `prop_getset_fn`, about 234 Ir per read.
- **Design:** a derived `Vec<u32>` indexed by `SlotIndex`, one bit per exotic table.
  The invariant is only **superset**: if an instance is in a table, its bit is set.
  A stale bit (after a removal, or on a reused slot) only sends a read down the existing guard
  chain, which re-checks the real tables, so it is always correct.
  When the word is zero the read takes the ordinary path directly; otherwise the existing chain
  runs unchanged.
  The superset invariant is enforced by type, not by audit: each of those tables becomes a newtype
  whose only mutating entry points (`insert`, `entry`, bulk rebuild) set the bit, so a new writer
  cannot forget it.
  Restore and collection rebuild the vector from the tables
  (`ironhorse-vm/src/interp/restore.rs:68`, next to `rederive_side_reserved` in
  `ironhorse-vm/src/interp/side_ledger.rs:40`).
- **Why this removes round 1's blocker:** round 1's cache needed membership to be immutable once
  observable; a superset bit needs only that inserts set it, which the newtype makes
  unrepresentable to violate.
- **Expected win (estimate):** most of `dispatch_get_property`'s self time on ordinary receivers,
  about 1.1-1.2x on `prop_getset_fn`, `method_calls_fn` and `proto_method_fn`, more if the
  prototype walk's per-level probes (`PORFFOR-RESULTS.md:221-222`) use the same word.
  It is also the enabler for items 6 and 7 and for T19.
- **Risks:** a table insert path that bypasses the newtype (for example through `Tracked`'s
  deref); the newtype must not expose `&mut` to the inner map.
- **Files:** `ironhorse-vm/src/side_tables.rs` or a new `ironhorse-vm/src/interp/exotic_bits.rs`,
  `ironhorse-vm/src/interp/state.rs` (field types),
  `ironhorse-vm/src/interp/dispatch/property_read.rs`,
  `ironhorse-vm/src/interp/dispatch/property_write.rs`,
  `ironhorse-vm/src/interp/property/ordinary.rs`
  (walk), `ironhorse-vm/src/interp/restore.rs`, `ironhorse-vm/src/interp/gc.rs`.
- **Gates:** round 1's list and gate D; a test that every exotic constructor path (including a
  Proxy `newTarget` whose `prototype` getter runs guest code mid-construction) leaves the bit set.
- **Keep if:** `prop_getset_fn` or `method_calls_fn` improves by at least 10% in Ir.

### 4. Dense array element storage (medium)

**Status:** shipped as `33ac5a288` and `643d2967b` (`array_rw_fn` 1.45x in Ir), with the
conversion-work test `aa5eb8b8e`; see [PORFFOR-RESULTS.md](PORFFOR-RESULTS.md), "Round 2".

- **Design:** replace the `BTreeMap<u32, Slot>` item store
  (`rust/engine/ironhorse-vm/src/bulk.rs:173-185`)
  with a dense `Vec<Option<Slot>>` while the array is dense enough (a count-based policy, never a
  time-based one), falling back to the map for sparse arrays.
  The side charge must stay the declared width per element by capacity class
  (`rust/engine/ironhorse-vm/src/side_storage.rs:11-27`), computed from the element count exactly as
  now, so where `HeapExhausted` lands is unchanged.
  Rows stay an ascending `(index, slot)` stream
  (`rust/engine/ironhorse-vm/src/interp/snapshot_views.rs:12-27`),
  so snapshot bytes are unchanged.
- **Expected win (estimate):** `BTreeMap::get` is 7.65% of `array_rw_fn`; with inserts and
  iteration, 1.08-1.2x on `array_rw_fn`, `array_fill_sum_fn` and `array_rw_push`.
- **Files:** `ironhorse-vm/src/bulk.rs`, `ironhorse-vm/src/interp/property.rs`,
  `ironhorse-vm/src/interp/property/indexed.rs`, `ironhorse-vm/src/interp/natives/array.rs`,
  `ironhorse-vm/src/interp/snapshot_views.rs`.
- **Gates:** round 1's list, gate D, the side-ledger rederivation tests, `state_golden`.
- **Keep if:** `array_rw_fn` improves by at least 10% in Ir.

### 5. Verified install and a slimmer loop header (small; after item 2, same worktree)

**Status:** not built: its measured upper bound (0.956 on `empty_loop_fn`) is below the keep bar;
see [PORFFOR-RESULTS.md](PORFFOR-RESULTS.md), "Round 2".

- **Design:** verify each buffer once at install: every instruction decodes, no instruction crosses
  its function body, and every branch and catch target is an instruction start of the same body
  (the instruction-start computation already exists at
  `rust/engine/ironhorse-vm/src/interp/restore.rs:191-226`).
  Dispatch over verified buffers then drops the `ProgramCounterOutOfBounds`,
  `InvalidOpcode`, `UnresolvableInstructionLength` and `TruncatedInstruction` refusals
  (`rust/engine/ironhorse-vm/src/interp/dispatch.rs:291-344`); a 256-entry table replaces
  `Opcode::from_u8`'s match.
  Indexing stays bounds-checked (`forbid(unsafe_code)`), so a verifier bug becomes a panic rather
  than memory unsafety.
- **Observable change:** malformed bytecode, which only an engine bug or a corrupt snapshot can
  produce, is refused at install instead of halting at its pc.
  The `bytecode_decoder` fuzz target
  (`rust/engine/ironhorse-fuzz/fuzz/fuzz_targets/bytecode_decoder.rs`)
  must be re-scoped to assert install-time refusal and no panic.
- **Expected win (estimate):** 5-10% Ir on simple-op code, on top of item 2.
- **Files:** `ironhorse-vm/src/interp/dispatch.rs`, `ironhorse-vm/src/interp/fuse.rs` (shares the
  walk), `ironhorse-fuzz`.
- **Keep if:** `empty_loop_fn` improves by at least 5% in Ir over item 2.

### 6. Global binding cache (medium; after item 3)

**Status:** not started; first round-3 candidate (global reads are 26% of `array_hole_fn` at the
round-2 tip); see [PORFFOR-RESULTS.md](PORFFOR-RESULTS.md), "Round 2".

- **Design:** a per-site cache keyed by `(segment, pc)` in a bounded, lazily allocated table (T23),
  holding the global object's property slot for a data property, validated by an epoch on the
  global object(s) bumped by any define, delete, flag or prototype change on them, and bypassed for
  exotic globals (item 3's bits) and `with`/eval environments (already split by `envref.kind`).
  The epoch hook point is the slot mutation choke point (`SlotArena::get_mut`,
  `rust/engine/ironhorse-vm/src/value.rs:1305-1318`, which already notifies `property_index`), plus
  allocation and free.
- **Expected win (estimate):** up to 1.5x on `int_loop` (43.7% of its self time is global access);
  little on function-local code.
- **Gates:** as item 3, plus tests for accessor globals, frozen globals, Proxy globals in
  compartments, TDZ of global lexicals and `typeof` of unresolvable names, written before the
  change.

### 7. Property inline and prototype caches (large; after item 3)

**Status:** not started; blocked on a value-write/structural-write split of `SlotArena::get_mut`;
see [PORFFOR-RESULTS.md](PORFFOR-RESULTS.md), "Round 2".

- Round 1's recorded design (`PORFFOR-RESULTS.md:224-231`), with item 3's bits in place of the
  membership proof and item 6's epoch mechanism.
- Must preserve getter calls, Proxy traps and SES integrity exactly; a hit returns the slot the walk
  would.
- **Expected win (estimate):** most of `find_property` (3.4-9.4%) and the remaining walk on
  property workloads.

### 8. Call path: pooled argument and local vectors, lazy `id_map` (medium)

**Status:** not started; see [PORFFOR-RESULTS.md](PORFFOR-RESULTS.md), "Round 2", round-3
candidates.

- Pool the two host-only `Vec`s; make the `id_map` lazy for functions with no direct eval, `with`,
  or other dynamic name lookup.
- The `id_map` is persisted (`rust/engine/ironhorse-vm/src/interp/persist.rs:2459`), so a lazy map
  either materialises at snapshot (rows unchanged) or changes the row schema
  (`ROW_SCHEMA_VERSION`, `rust/engine/ARCHITECTURE.md:388`), which rule 1 now permits but which
  needs a format and store bump.
- **Expected win (estimate):** most of the 10.6% allocator and 3.0% `HashMap::insert` share of
  `func_calls_fn`.

### 9. Meter-version-bump proposals (document only; needs owner approval)

**Status:** no meter change shipped; the calibration measurements that would inform one are in
[PORFFOR-RESULTS.md](PORFFOR-RESULTS.md), "Round 2", "Metering calibration: host work per
computron".

None of these is in the implement-now set.

- **Charge a superinstruction as fewer units.** After item 2, a fused `i++` costs much less CPU than
  four dispatches; charging it less would serve the "approximate CPU time" objective
  (`rust/engine/README.md:5`), but changes every computron total and needs `ironhorse-meter-10`
  with regenerated goldens (`rust/engine/ARCHITECTURE.md:384`).
- **Coder changes that remove dispatches** (`PULL_LOCAL` for `SET_LOCAL; POP`, constant folding).
- **String builders or ropes** (T12), which would also address the under-metered quadratic
  concatenation (`PORFFOR-RESULTS.md:440-442`) and the heap churn of `s += x`
  (`PORFFOR-FINDINGS.md:457-463`).

### Recommendation: implement now

Implement items 1, 2, 3 and 4, with item 5 following item 2 in the same worktree.
Order: item 1 first (about a day, and it decides item 2's fusions), then items 2, 3 and 4 in
parallel, then item 5, then integrate and run the stack-height gate on the integrated tree
(round 1 showed per-branch frame gates do not compose, `PORFFOR-RESULTS.md:431-434`).
Items 6 and 7 follow item 3.

Why this set: the tip spends 40-90% of its time in `dispatch_at_inner` on the roster, so the
dispatch loop is now the floor, and items 2 and 5 are the only ones that lower it; items 3 and 4
remove the two largest remaining non-dispatch costs that need no cache proof.
All four are meter-neutral and snapshot-neutral by construction.

### Worktrees and file ownership

| Worktree | Items | Files it owns | Shared files |
|---|---|---|---|
| A | 1, 2, 5 | `ironhorse-vm/src/interp/dispatch.rs`, `ironhorse-vm/src/interp/fuse.rs` (new), `ironhorse-vm/src/interp/code.rs`, `ironhorse-vm/src/interp/eval.rs`, `ironhorse-vm/src/interp.rs` (`run_inner` only), `ironhorse-vm/src/cost.rs`, `ironhorse-vm/tests/porffor_micro_bench.rs`, `ironhorse-vm/tests/optimised_differential.rs` (new), `ironhorse-fuzz` | `ironhorse-vm/src/interp/state.rs` (one new field), `ironhorse-vm/src/interp/persist.rs:1834` (segment install only) |
| B | 3 | `ironhorse-vm/src/interp/exotic_bits.rs` (new) or `ironhorse-vm/src/side_tables.rs`, `ironhorse-vm/src/interp/dispatch/property_read.rs`, `ironhorse-vm/src/interp/dispatch/property_write.rs`, `ironhorse-vm/src/interp/property/ordinary.rs`, `ironhorse-vm/src/interp/gc.rs` | `ironhorse-vm/src/interp/state.rs` (table field types), `ironhorse-vm/src/interp/restore.rs` (`finish`) |
| C | 4 | `ironhorse-vm/src/bulk.rs`, `ironhorse-vm/src/interp/property.rs`, `ironhorse-vm/src/interp/property/indexed.rs`, `ironhorse-vm/src/interp/natives/array.rs`, `ironhorse-vm/src/interp/snapshot_views.rs` | none expected |

`state.rs` is the only file all of A and B edit; its fields are declared one attribute block each
(`rust/engine/ironhorse-vm/src/interp/state.rs:475-536` shows the form), so the edits are separate
hunks.
Integrate C, then B, then A, because A's fused arms are the most sensitive to frame size and should
be gated last on the full tree.
Gate D's test file is created in A; B and C add their own cases to it after integration, or carry a
copy of the harness until then.

## Prompt

> Architect round 2 of the Ironhorse performance campaign under the owner's revised ground rules
> (XS is a guide, the spec is JavaScript and SES; only malicious guest code is in the threat model;
> hashing is a performance question). Inventory what encodes the old rules, re-evaluate every
> round-1 deferral, rank a round-2 plan with gates and a parallel split, and draft the snapshot and
> operator seam's threat model. Keep computron determinism as a stated assumption.
