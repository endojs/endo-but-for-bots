# Security seams: guest, operator and snapshot

**Draft for owner review.**
First written 2026-11-22 against `1581b8a51`; revised 2026-11-23 for the owner's final rules and
the round-2 derived state, against `d5871aac0` (the last code commit of round 2), where every
`path:line` below was re-read.
Sections 3-6 separate what was verified in the code (each claim cited) from what was not; section 9
lists the open questions.

## 1. The owner's rules

Project owner direction, 2026-11-22 and 2026-11-23, quoted:

1. "XS is just a guide; the real spec is JavaScript and SES."
2. "We're really only worried about malicious guest code, not a malicious Ironhorse operator or
   malicious snapshot (though we need to document this seam's security properties in detail)."
3. "If the hash is a perf optimization technique that's not a security issue."
4. "Determinism, lockdown, and compartment sandboxing are mandatory. Computrons must approximate
   actual work done for the sake of preserving DoS resistance. This can be tightened later but
   should be set to realistic patterns."
5. Computron identity with earlier versions is no longer required: "the current gates are a
   too-strict version of our initial guard rails".

Rule 5 relaxes a gate, not a property: computrons must still be deterministic (rule 4), and a
meter change is still a new `ironhorse-meter-N` release with regenerated goldens.
Round 2 did not use the relaxation: every round-2 commit is computron-identical to the round-1 tip
on the roster, and no meter version was added (`PORFFOR-RESULTS.md`, "Round 2").

## 2. The threat model

There are three parties:

- **The guest**: JavaScript source and everything it can construct at run time (`eval`,
  `Function`, regular expressions, Compartments), running under SES. **Adversarial; in scope.**
- **The operator or embedder**: the process that links the engine, chooses limits, supplies
  bytecode to `Interp::run` (`rust/engine/ironhorse-vm/src/interp.rs:2842`), attaches the meter host
  and decides when to snapshot, collect and restore. **Trusted; out of scope.**
- **The snapshot or store**: container bytes and paged heap stores. **Trusted as the machine they
  hold; out of scope**, provided a trusted operator wrote them with a compatible engine build.

The store half of that stance was adopted on 2026-09-24
(`designs/ironhorse-snapshot-store-seam.md:11-31`): "Whoever can write the store can already write
the machine, so no property Ironhorse offers survives a store it cannot trust", and
"Tamper-evidence and authentication are therefore not goals of Ironhorse or of its store backends."
Rule 2 extends the same position to containers and to bytecode; question Q2 asks whether that is
meant to retire the container checks too.

What "out of scope" means precisely: the engine makes no promise when a snapshot, store or bytecode
argument was written by anyone other than a trusted operator running a compatible build.
It still refuses many malformed inputs without a panic (section 6), because that protects against
engine bugs and accidental damage, but those checks are robustness, not a defence.

## 3. The mandatory properties and where each is enforced

### 3.1 Determinism

Requirement: the same binary given the same input produces the same results, computrons and
snapshot bytes (`rust/engine/README.md:3-21`, "Metering objective").

Enforced by:

- **No host clock reaches a guest.**
  `Date.now` returns 0 (`rust/engine/ironhorse-vm/src/interp/natives/date.rs:50`, installed at
  `rust/engine/ironhorse-vm/src/interp/boot.rs:2734`), and `Temporal.Now` is a fixed epoch in UTC
  (`rust/engine/ironhorse-vm/src/interp/natives/temporal.rs:1854-1855`,
  `rust/engine/ironhorse-vm/src/interp/boot.rs:2275-2278`).
  This answers the draft's question about `Date.now`.
  No `SystemTime` or `Instant` appears in `ironhorse-vm/src`.
- **Hash iteration order never leaks.**
  Every snapshot row writer sorts (for example
  `rust/engine/ironhorse-vm/src/interp/persist.rs:492`), and computrons never depend on probe
  counts.
- **Math.** The `deterministic-math` feature (implied by `consensus`) computes `Math` through `libm`
  rather than the platform library; its vectors are exported and compared (`math_determinism`,
  `math_provider_comparison`).
- **Derived accelerators are not observable** (section 7): each is a pure function of state that
  is itself deterministic, never persisted, and gated by a differential test.

Tested by: `ironhorse-vm/tests/golden_computrons.rs` (plain, `cost-calibration` and `consensus`
builds), the deterministic-Math configuration, the snapshot crate's `*_carry.rs` suites (each
compares a continuous machine with checkpointed and restored ones, computrons included,
`rust/engine/ironhorse-snapshot/tests/common/twin.rs:25-34`), and round 2's three differential
tests.

### 3.2 Lockdown

Requirement: after `lockdown()`, the shared intrinsics are frozen and the realm behaves as SES
specifies.

Enforced by: the guest `lockdown()` (`rust/engine/ironhorse-vm/src/interp/realm.rs:283`, reached
from `NativeMethod::GlobalLockdown`,
`rust/engine/ironhorse-vm/src/interp/natives/dispatch.rs:7390`),
which refuses re-entry and a start from inside an unfinished `harden`
(`rust/engine/ironhorse-vm/src/interp/realm.rs:291-308`).
On restore, the completion marker is read and must be a Boolean; a shared-compartment realm must be
locked down (`rust/engine/ironhorse-vm/src/interp/restore.rs:101-123`).
The marker is trusted as written: a forged image can claim "locked down" over unfrozen intrinsics
(section 5).

Tested by: `ironhorse-vm/tests/native_lockdown.rs` (35 tests),
`ironhorse-vm/tests/hardened_js_boundary.rs` (21), `ironhorse-snapshot/tests/lockdown_carry.rs`
(5), and in round 2 gate D's lockdown edge cases and the array-storage differential's hardened
arrays under `lockdown()` across a collection and a restore.

### 3.3 Compartment sandboxing

Requirement: guest code evaluated in a `Compartment` sees that compartment's global object and
lexicals, shares only the intrinsics, and cannot reach the caller's environment.

Enforced by: `compartment_evaluate`
(`rust/engine/ironhorse-vm/src/interp/natives/compartment.rs:402`),
which switches to the compartment's environment, evaluates strict source and restores the caller's
environment on every exit, including a throw (`:408-414`).

Tested by: `ironhorse-vm/tests/guest_compartment.rs` (24 tests, including
`a_throw_inside_a_compartment_restores_the_calling_environment` and
`lockdown_poisons_the_compartment_constructor`), `ironhorse-vm/tests/realms.rs` (30), and in round
2 gate D's Compartment evaluations with their own globals and the array-storage differential's
arrays shared into guest Compartments.

The real SES bundle boot (`ironhorse-262/tests/stage4_ses_boot.rs`) needs the XS oracle crate and
the generated bundle; it was not run in round 2 (`PORFFOR-RESULTS.md`, "Round 2", gates not run).
The `ses_boot_intrinsics` (14) and `ses_prelude_reach` (3) tests that did run are self-contained
probes of what the bootstrap uses.

### 3.4 Work-proportional metering

Requirement: computrons approximate the host work done, so a guest cannot buy much host time with
few computrons (rule 4).

Enforced by:

- **One code unit per dispatched opcode**, charged before its body runs
  (`rust/engine/ironhorse-vm/src/interp/dispatch.rs:324`).
  A fused superinstruction of `k` opcodes charges `k` units and counts `k` dispatches
  (`rust/engine/ironhorse-vm/src/interp/fuse.rs:250`, `tick_fused`).
- **Check points**: every 4096 dispatches
  (`rust/engine/ironhorse-vm/src/interp/dispatch.rs:243-247`),
  on backward branches (`:1048-1053` and the other branch arms) and after native calls return (for
  example `:2537`, `:2595`).
  A fused sequence runs only if none of the loop tops it skips would have checked
  (`rust/engine/ironhorse-vm/src/interp/fuse.rs:239`, `fusion_admits`), and performs a closing
  branch's check after all `k` ticks, so check positions are identical.
- **Fail-closed**: an armed meter with no host aborts at its first check
  (`rust/engine/ironhorse-vm/src/interp/admission.rs:61-80`); built-ins charge their own work
  through
  `charge_and_check` (`:83-95`).
- **Heap and side storage**: slot and chunk ceilings, default one million slots and 256 MiB
  (`rust/engine/ironhorse-vm/src/value.rs:10-15`), capped in consensus builds (`:17-41`); side
  storage charged by declared widths (`rust/engine/ironhorse-vm/src/side_storage.rs:1-27`).

What is approximate, measured in round 2 (`PORFFOR-RESULTS.md`, "Metering calibration: host work
per computron"): host work per computron spreads by more than an order of magnitude across
patterns (6.3x between the roster's median and its maximum in Ir, more for targeted patterns).
The most under-charged, highest first: `length` shrinks on an array with many named properties
(about 158,000 Ir per computron with 4,000 of them, linear in their number), `eval`, string growth
by concatenation, JSON, and `push`/`pop` on holey arrays.
No meter change ships with round 2; that table is input for a future `ironhorse-meter` version.
Fusion only lowers host work per computron on the loops it fuses, so those loops become
over-charged relative to others, never under-charged.

## 4. What the engine guarantees against a malicious guest

### 4.1 Memory safety

Verified:

- Every engine library root forbids `unsafe`: `ironhorse-vm/src/lib.rs:1`,
  `ironhorse-snapshot/src/lib.rs:1`, `ironhorse-runtime/src/lib.rs:1`,
  `ironhorse-regexp/src/lib.rs:1`,
  `ironhorse-text/src/lib.rs:3`, `ironhorse-meter/src/lib.rs:9`, `ironhorse-unicode/src/lib.rs:14`,
  `ironhorse-compile/src/lib.rs:28` (all under `rust/engine/`).
  The policy and its limits are stated at `rust/engine/README.md:89-93`: `xs-oracle` (test-only C)
  is excepted, transitive dependencies are not covered, and the store backend outside this
  workspace links bundled SQLite.
- Release builds keep arithmetic overflow checks on (`rust/engine/Cargo.toml:29-31`).
- Heap references are integer handles (`SlotIndex`, `ChunkOffset`), not pointers
  (`rust/engine/ARCHITECTURE.md:56-58`); an out-of-range handle is a bounds-checked index.

What this does not mean:

- **Panics are not excluded.**
  Resource stops (`HeapExhausted`, `HostAllocationFailed`) are deliberate unwinds
  (`rust/engine/ironhorse-vm/src/value.rs:89-105`) caught at the run boundary and turned into halts
  (`rust/engine/ironhorse-vm/src/interp.rs:2974-2997`); any other panic is re-raised to the embedder
  (`:2990`).
  A guest-reachable panic is a denial of service against the embedder's thread, not a
  memory-safety break.
- **The unwind strategy is load-bearing.**
  Under `panic=abort`, the only stable option on wasm targets, these halts become process aborts
  (`rust/engine/WASM-BLOCKERS.md:150-178`).
- **Native stack exhaustion is not containable** (`rust/engine/ironhorse-vm/src/interp.rs:367-370`).
  It is prevented by a counted budget (`NATIVE_DEPTH_LIMIT = 2048`, `:410`) calibrated to a thread
  stack of `NATIVE_STACK_BYTES` (`rust/engine/ironhorse-vm/src/lib.rs:106-112`); the guarantee holds
  only on a thread at least that large, and only while the stack-height gate
  (`rust/engine/benches/stack_height.py`) holds frame sizes to its baseline.

### 4.2 Limits

- **Value stack**: a fixed 4096-slot geometry (`rust/engine/ironhorse-vm/src/interp.rs:323-329`).
- **Property-key space**: guest interning is admitted against the `u16` id space with a catchable
  `RangeError` (`rust/engine/ironhorse-vm/src/interp/property/keys.rs:54-69`), and an intern that
  would alias latches a halt before the next instruction
  (`rust/engine/ironhorse-vm/src/interp/dispatch.rs:301-310`).
- **Host allocator failure** inside an admitted growth halts as `HostAllocationFailed`
  (`rust/engine/ironhorse-vm/src/value.rs:93-105`, pre-flight at `:128-140`); the dense array store
  reserves fallibly before any mutation (`rust/engine/ironhorse-vm/src/bulk.rs:526`).

### 4.3 Host memory outside the limits

Outside every ceiling, bounded only indirectly:

- **Derived indexes and accelerators**: `property_index`, the integer-hash tables' own overhead,
  and round 2's dispatch buffers, exotic-membership words and dense-store slack (section 7).
  Each is proportional to charged quantities.
- **Garbage within a crank**: nothing collects within a crank, so a crank's garbage is resident
  until the operator collects; it still occupies charged slots and chunks.
- **Retained bytecode.** Each `eval` or `Function` unit's bytecode is pushed into `code_segments`
  for the realm's lifetime (`rust/engine/ironhorse-vm/src/interp/eval.rs:148-155`), compacted only
  by
  a collection (`rust/engine/ironhorse-vm/src/interp/gc.rs:323`), with no footprint charge;
  compilation is metered by source bytes and compiler work (`rust/engine/README.md:29-30`).
  Since round 2 a fusable unit also gets a dispatch buffer of the same size.
  Measured in round 2: 3,000 `eval` calls retain 3,000 segments within one crank, whether the
  sources are distinct or the same source repeated (no unit is shared), at about 6,700 and 3,200 Ir
  per computron against a roster median of 238 (`PORFFOR-RESULTS.md`, calibration section).
  See Q1.

### 4.4 Hash flooding, per hasher

| Table family | Hasher | Keys | Can the guest steer the keys? | Worst case |
|---|---|---|---|---|
| Name and string-keyed tables (`SymbolName`, registry keys) | std `RandomState` (SipHash-1-3, OS-seeded per table) | Guest-spelled text | Fully | The standard keyed-SipHash position |
| Integer side tables: `SlotIndex`, `u16` key ids and pairs (for example `func_segments`, `rust/engine/ironhorse-vm/src/interp/state.rs:565`) | `IntBuildHasher`: one folded 64x64-bit multiply per word, keyed by a per-process seed (`rust/engine/ironhorse-vm/src/int_hash.rs:65-68`), finish `state ^ (state >> 32)` (`:137-139`) | Arena handles and interned ids | It shapes the key set (below) | Quadratic probing in one table, unmetered |
| Decimal index-name index | `BTreeMap<u32, u16>` | Guest-spelled index names | Fully | O(log n); no hashing |

**The position (rule 3): the integer hasher is a performance choice, not a security boundary.**
Stated precisely, as the hasher's own documentation now says
(`rust/engine/ironhorse-vm/src/int_hash.rs:16-35`):

- **A guest shapes the key set.**
  Slots come from a deterministic LIFO free list, else arena growth
  (`rust/engine/ironhorse-vm/src/value.rs:1244-1260`, `:1277-1289`); a guest that allocates filler
  objects can place a table's keys at an arithmetic progression of a stride it picks, and across
  collections it can shape which indices are reused.
  Key ids are assigned densely in interning order
  (`rust/engine/ironhorse-vm/src/interp/property/keys.rs:61-69`), so a guest chooses which name
  gets which id.
- **A guest cannot learn the seed.**
  It is drawn from OS randomness once per process and never persisted
  (`rust/engine/ironhorse-vm/src/int_hash.rs:65-68`); iteration order is not observable (section
  3.1); computrons do not depend on probe counts; a guest has no clock (section 3.1).
- **The argument is seed secrecy plus measured spread**, not a keyed pseudorandom function:
  power-of-two strides filled at least 2,442 of 4,096 buckets over 40 seeds in round 1's
  simulation, against about 2,590 for a uniform hash (`rust/engine/PORFFOR-RESULTS.md:279-287`).
  Nothing proves that no seed-independent multicollision family exists.
- **Worst case if the seed leaked** (it is in process memory, so this needs a separate leak from a
  trusted operator's process): a table whose keys share one probe sequence, O(n) per probe and
  O(n^2) per bulk build, n bounded by live slots (one million by default) for `SlotIndex` keys and
  65,536 for key ids.
  Measured in round 2 with a std map whose keys all share one hash: a lookup costs 414 ns at 1,024
  keys and 39.5 us at 65,536, 199x and 8,053x a spread lookup (`PORFFOR-RESULTS.md`, calibration
  section).
  This is a **work-proportionality gap** (unmetered host time), not a correctness one: results,
  computrons and snapshot bytes stay correct.
- If the owner wants it closed: a per-table seed, direct `Vec` indexing for dense `SlotIndex`-keyed
  tables (the exotic-membership words already take that shape), or a probe-length guard that
  rehashes.

### 4.5 SES integrity of accelerators

A stale cache that returned a value past `Object.freeze`, a deleted accessor or a Proxy trap would
be a guest escape from hardening, not a performance bug.
Round 2's rule, kept: every accelerator is either a superset filter that falls back to the exact
path, a derived structure that is a pure function of canonical state, or a representation change
behind an unchanged interface, and each is held to unobservability by a differential test against
the plain engine (section 7).

## 5. What the engine does not defend against

- **Forged or corrupted snapshot contents.**
  A container or store can describe any heap, including one that violates SES invariants (a
  lockdown marker that says "locked down" over unfrozen intrinsics, section 3.2).
  Restore validation (section 6) refuses many malformed images; it is not a proof that the image is
  one an honest machine could reach, and it is not designed to be.
- **Bit rot that still decodes.** The stores carry no integrity hashes; SQLite checksums only its
  WAL frames and the file store none (`designs/ironhorse-snapshot-store-seam.md:21-27`).
- **A hostile operator or embedder.** The embedder sets the ceilings
  (`rust/engine/ironhorse-vm/src/value.rs:10-13`), attaches or omits the meter host, chooses when to
  collect, and may hand the VM arbitrary bytecode through `Interp::run`
  (`rust/engine/ironhorse-vm/src/interp.rs:2842`).
- **A tampered store or a second writer** (`designs/ironhorse-snapshot-store-seam.md:61-80`).
- **Cross-boundary exchange**: a consumer that accepts a heap across a trust boundary must
  authenticate it itself (`designs/ironhorse-snapshot-store-seam.md:27-31`).
- **Side channels and host resources outside the engine**: wall-clock timing seen by the operator,
  transitive dependencies, SQLite.

## 6. Validation that still runs on restore, and why

| Check | Where | Purpose | Classification |
|---|---|---|---|
| Format, schema, signature with boot fingerprint, cost-table name and digest | `rust/engine/ironhorse-snapshot/src/machine.rs:1280-1300`, `rust/engine/ironhorse-snapshot/src/image.rs:132-148`, `rust/engine/ARCHITECTURE.md:225-229` | Refuse a heap from an incompatible build or meter release | **Compatibility, required**: protects computron determinism across releases |
| Decode bounds checks on rows and atoms | `rust/engine/ARCHITECTURE.md:226-228` | Turn a corrupt row into a typed error | Robustness |
| Container canonical form: re-encode and compare | `rust/engine/ironhorse-snapshot/src/image.rs:5438` | One machine, one encoding | Optional under this model; Q2 |
| Stored property ids inside the name tables | `rust/engine/ironhorse-snapshot/src/image.rs:5450-5460` | A stray id would read or write the wrong key | Robustness |
| Row references live, of the right kind, acyclic; owners ascending | `rust/engine/ironhorse-vm/src/interp/persist.rs:23-160` | Avoid panics and impossible graphs | Robustness |
| Session completeness, callable graph, suspended cursors at instruction starts, lockdown marker well-formed | `rust/engine/ironhorse-vm/src/interp/restore.rs:68-130`, `:159-248` | Same | Robustness; the cursor check also makes a resumed pc safe to dispatch from |
| Lazy faults: exact row lengths, pairing check | `designs/ironhorse-snapshot-store-seam.md:61-80`, `:320-325` | Avoid splicing two machines' rows | Robustness against operator error |
| Explicit validators (`validate_store`, `validate_store_content`) | `rust/engine/ARCHITECTURE.md:234-235` | On-request full checks | Tooling |

Dispatch-time decode refusals (`rust/engine/ironhorse-vm/src/interp/dispatch.rs:312-362`) remain
the one per-instruction check whose stated purpose includes corrupt snapshots
(`designs/ironhorse-engine.md:894-897`).
Round 2 measured the upper bound of moving them to a once-per-buffer verification at install:
at most 4.4% on `empty_loop_fn` before paying for the verified/unverified split, below the keep
bar, so they stay.

## 7. Derived state added in round 2

All three are host state: never persisted, never charged, rebuilt from canonical state, and
switched off for tests by a diagnostics hook.
Gate D (`rust/engine/ironhorse-snapshot/tests/optimised_differential.rs`) runs its whole corpus and
sweeps with all three on against all three off; `exotic_bits_differential.rs` and
`array_storage_differential.rs` compare each one alone and all three together.
Each comparison covers completion, halt, result, computrons, dispatch count, raw meter index and
snapshot bytes after every crank, and the gate-D and array-storage ones also the meter host's whole
check sequence.

### 7.1 Dispatch buffers (superinstructions)

- **What**: beside an installed bytecode buffer, a copy of the same length whose bytes differ only
  at the heads of fusable straight-line sequences, where the opcode byte becomes a tag in the
  range XS leaves unused (`rust/engine/ironhorse-vm/src/interp/fuse.rs:1-30`, builder
  `derive` at `:706`).
- **Why a guest cannot observe it**: the canonical bytes are never changed and every reader other
  than a head opcode's own arm reads them; any pc (branch, catch, resume, callback start) that
  lands on a non-head member dispatches it normally; a sequence runs fused only when its guards
  pass and no skipped loop top would have checked the meter or the step limit; it charges and
  counts exactly what sequential dispatch does
  (`rust/engine/ironhorse-vm/src/interp/fuse.rs:31-54`).
  Members cannot call, allocate, intern, suspend, throw or read the meter.
- **Rebuilt on restore**: every restored segment is installed
  (`rust/engine/ironhorse-vm/src/interp/persist.rs:1839`); the buffer is a pure function of the
  bytes.
- **What it trusts about snapshot contents**: nothing beyond what dispatch already trusts.
  `derive` walks with the same instruction decoder and stops at the first undecodable byte, and a
  tag is written only where the canonical byte is an opcode, so corrupt code is never taken for a
  tag (`rust/engine/ironhorse-vm/src/interp/fuse.rs:28-30`, unit test
  `nothing_to_fuse_builds_nothing_and_corrupt_code_stops_the_walk`).
- **Host memory**: one byte per byte of fusable bytecode, including retained `eval` units (Q1).

### 7.2 Exotic-membership words

- **What**: one 16-bit word per slot index, one bit per exotic side table (arrays, index
  properties, wrappers, four Temporal tables, disposable stacks, buffers, typed arrays, data views,
  regexps, locales, collators, functions, proxies), plus one overflow word for indices at or above
  2^26 (`rust/engine/ironhorse-vm/src/exotic_bits.rs:102-120`).
  The invariant is a superset: if an instance is in a table, its bit is set.
  The tables have the type `ExoticTable` (`rust/engine/ironhorse-vm/src/exotic_bits.rs:197`), whose
  only key-adding methods set
  the bit first (`rust/engine/ironhorse-vm/src/exotic_bits.rs:222`) and which exposes no `&mut` to
  the inner map.
- **Why a guest cannot observe it**: a clear word only skips probes that would have missed; a set
  bit, stale or not, runs the original probes.
  No metering, allocation or slot write depends on it.
- **Rebuilt on restore and after collection**: `Interp::rebuild_exotic_bits`
  (`rust/engine/ironhorse-vm/src/interp/gc.rs:12-32`), called at `RestoreSession::finish`
  (`rust/engine/ironhorse-vm/src/interp/restore.rs:133`) and after both collectors' pruning.
  It commits only if every registered table contributed, so a forgotten table can stop the
  clearing but never lose a bit.
- **What it trusts about snapshot contents**: only the restored tables' keys.
  A key's word grows the vector to that index, at most 2^26 words (128 MiB) for a trusted image,
  whose indices are below the slot ceiling anyway.
- **Host memory**: two bytes per slot index up to the highest exotic one.

### 7.3 Dense array item storage

- **What**: an array's (or an ordinary object's index-property) items in a `Vec<Option<Slot>>`
  while dense enough, else in the ordered map as before
  (`rust/engine/ironhorse-vm/src/bulk.rs:240-245`,
  leave and enter rules at `:198-206`).
  The rules depend only on the store's own mutation history, never on host memory, capacity or
  time.
- **Why a guest cannot observe it**: the interface (`get`, ascending iteration, length, side
  charge by count) is unchanged; the side charge is computed from the item count exactly as before,
  so `HeapExhausted` lands where it did; snapshot rows are the same ascending `(index, slot)`
  stream.
- **Rebuilt on restore**: restored items go through the same transition rules
  (`rust/engine/ironhorse-vm/src/bulk.rs:763`, `restore_item`); representation history may differ
  between a restored and a
  continuous machine, which the differential shows cannot reach computrons or bytes.
- **What it trusts about snapshot contents**: ascending indices, which restore validation already
  requires; a far index stays in the map (`a[4294967294] = 1` is a one-item map), so an image
  cannot force a huge vector.
- **Host memory and work**: at most 96 bytes per item plus 288 per dense store, about 3x the
  32-byte charge asymptotically (before: up to about 2.4x); conversions move at most about twice
  the item mutations that paid for them (`ironhorse-vm/tests/array_storage_work.rs`).

## 8. What a deployer must therefore ensure

1. **Snapshot integrity and provenance are the operator's responsibility.**
   Restore only containers and stores written by an engine build you trust, at a compatible
   release; the checks in section 6 refuse incompatible images, not malicious ones.
2. **Storage that detects corruption** if undetected bit rot matters.
3. **One writer per store.**
4. **Authenticate any heap that crosses a trust boundary** outside the engine.
5. **Run the engine on a thread of at least `NATIVE_STACK_BYTES`**
   (`rust/engine/ironhorse-vm/src/lib.rs:106-112`), with `panic=unwind`, on a build whose
   stack-height gate passed.
6. **Choose ceilings and meter limits**, and attach a meter host to every armed machine, including
   after restore (`rust/engine/ironhorse-vm/src/interp/admission.rs:61-72`).
7. **Collect between cranks** on a schedule that bounds crank-local garbage and retained eval code
   with its dispatch buffers (section 4.3).
8. **Treat `Interp::run`'s bytecode argument as trusted input**: only compiler output from the
   same release.
9. **Size meter limits for the most under-charged patterns**, not the median: until a meter
   version recalibrates, a crank's host time per computron can be several times the median
   (section 3.4).
10. **Keep the process's memory private**: the integer hasher's seed is in it (section 4.4).

## 9. Open questions for the owner

- **Q1. Retained eval bytecode.**
  Is it intended that `code_segments` growth inside a crank is bounded only by compile computrons
  and not by the chunk ceiling (`rust/engine/ironhorse-vm/src/interp/eval.rs:148-155`)?
  Since round 2 a fusable unit also carries a dispatch buffer of the same size.
  A footprint charge would be a meter-version change.
- **Q2. Containers versus stores.**
  Does rule 2 cover containers as fully as stores, so that the canonical re-encode
  (`rust/engine/ironhorse-snapshot/src/image.rs:5438`) may leave the production read path?
  ARCHITECTURE says "Containers can come from elsewhere, so they are still validated completely
  before adoption" (`rust/engine/ARCHITECTURE.md:236`).
- **Q3. Charging fused opcodes less.**
  May a future meter version charge a superinstruction less than its members?
  Rule 4 points that way (a fused loop costs less host time), but it changes every computron total
  of fused code, and round 2 found no host-work saving from it: what a handler charges does not
  change what it executes.
- **Q4. The hasher residual** (section 4.4): acceptable as documented, or should dense
  `SlotIndex`-keyed tables move to direct indexing?
- **Q5. Guest-reachable panics**: is there an inventory outside the resource halts?
- **Q6. Regular expressions**: whether every backtracking step is metered was not checked.
