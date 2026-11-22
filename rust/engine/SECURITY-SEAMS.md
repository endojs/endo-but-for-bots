# Security seams: guest, operator and snapshot

**Draft for owner review.**
Written 2026-11-22 against `1581b8a51a5ed87ec9c13bdf6715ddf925c25026`; every `path:line` was read at
that commit.
Sections 2-5 separate what was verified in the code (each claim cited) from what was not; section 7
lists the open questions.

## 1. The threat model

Project owner direction, 2026-11-22: "we're really only worried about malicious guest code, not a
malicious Ironhorse operator or malicious snapshot (though we need to document this seam's security
properties in detail)."
And: "If the hash is a perf optimization technique that's not a security issue."

So there are three parties:

- **The guest**: JavaScript source (and anything it can construct at run time: `eval`, `Function`,
  regular expressions, Compartments) running under SES. **Adversarial.**
- **The operator or embedder**: the process that links the engine, chooses limits, supplies
  bytecode to `Interp::run` (`rust/engine/ironhorse-vm/src/interp.rs:2841`), attaches the meter host
  and decides when to snapshot, collect and restore. **Trusted.**
- **The snapshot or store**: container bytes and paged heap stores. **Trusted as the machine they
  hold**, provided they were written by a trusted operator with a compatible engine build.

The store half of that stance was already adopted on 2026-09-24
(`designs/ironhorse-snapshot-store-seam.md:11-31`): "Whoever can write the store can already write
the machine, so no property Ironhorse offers survives a store it cannot trust", and
"Tamper-evidence and authentication are therefore not goals of Ironhorse or of its store backends."
This document extends the same position to containers and to bytecode, and records what that
leaves.

Computron determinism (same binary and same input give the same computrons,
`rust/engine/README.md:9-15`) is treated throughout as a requirement, not a security property; it is
listed where a defence also protects it.

## 2. What the engine guarantees against a malicious guest

### 2.1 Memory safety

Verified:

- Every engine library root forbids `unsafe`: `ironhorse-vm/src/lib.rs:1`,
  `ironhorse-snapshot/src/lib.rs:1`, `ironhorse-runtime/src/lib.rs:1`,
  `ironhorse-regexp/src/lib.rs:1`,
  `ironhorse-text/src/lib.rs:3`, `ironhorse-meter/src/lib.rs:9`, `ironhorse-unicode/src/lib.rs:14`,
  `ironhorse-compile/src/lib.rs:28` (all under `rust/engine/`).
  The policy and its limits are stated at `rust/engine/README.md:89-93`: `xs-oracle` (test-only C)
  is excepted, transitive dependencies are not covered, and the store backend outside this
  workspace links bundled SQLite.
- Release builds keep arithmetic overflow checks on (`rust/engine/Cargo.toml:29-31`), so
  guest-influenced arithmetic panics rather than wrapping silently.
- Heap references are integer handles (`SlotIndex`, `ChunkOffset`), not pointers
  (`rust/engine/ARCHITECTURE.md:56-58`); an out-of-range handle is a bounds-checked index, so an
  engine bug yields a panic, not an out-of-bounds read.

What this does not mean:

- **Panics are not excluded.**
  Resource stops (`HeapExhausted`, `HostAllocationFailed`) are deliberate unwinds
  (`rust/engine/ironhorse-vm/src/value.rs:89-105`) caught at the run boundary and turned into halts
  (`rust/engine/ironhorse-vm/src/interp.rs:2973-2996`); any other panic is re-raised to the embedder
  (`:2989`).
  A guest-reachable panic is therefore a denial of service against the embedder's thread, not a
  memory-safety break.
- **The unwind strategy is load-bearing.**
  Under `panic=abort`, which is the only stable option on wasm targets, these halts become process
  aborts, and a guest can crash the instance with a `SyntaxError` it meant to catch
  (`rust/engine/WASM-BLOCKERS.md:150-178`).
- **Native stack exhaustion is not containable** (`rust/engine/ironhorse-vm/src/interp.rs:366-369`:
  "a `SIGABRT` no `catch_unwind` can contain").
  It is prevented by a counted budget (`NATIVE_DEPTH_LIMIT = 2048`, `:409`) calibrated to a thread
  stack of `NATIVE_STACK_BYTES` (`rust/engine/ironhorse-vm/src/lib.rs:105-111`); the guarantee holds
  only on a thread at least that large.

### 2.2 Metering and limits

Verified:

- **Computrons.** Every dispatched opcode charges one code unit before its body runs
  (`rust/engine/ironhorse-vm/src/interp/dispatch.rs:304-305`).
  The meter host is consulted every 4096 dispatches (`:222-228`), on backward branches
  (`:1015-1020` and the other branch arms) and after native calls return (for example `:2504`,
  `:2562`).
  An armed meter with no host attached aborts at its first check rather than running unmetered
  (`rust/engine/ironhorse-vm/src/interp/admission.rs:61-80`).
  Built-ins charge their own work through `charge_and_check` (`:83-95`).
- **Heap.** Slot and chunk arenas have ceilings, default one million slots and 256 MiB
  (`rust/engine/ironhorse-vm/src/value.rs:10-15`), capped in consensus builds at 44,739,242 slots
  and 2^29 bytes (`:17-41`); exceeding them halts with an uncatchable `HeapExhausted`
  (`:1226-1231`).
- **Side storage.** Array items, index properties, Map/Set/Weak entries and Segmenter results live
  in host tables but are charged against the chunk ceiling by declared widths
  (`rust/engine/ironhorse-vm/src/side_storage.rs:1-27`,
  `rust/engine/ironhorse-vm/src/value.rs:2399-2404`),
  so large collections halt at the ceiling instead of exhausting host memory.
- **Host allocator failure** inside an admitted growth halts as `HostAllocationFailed`, not as a
  crash (`rust/engine/ironhorse-vm/src/value.rs:93-105`, pre-flight at `:128-140`).
- **Value stack**: a fixed 4096-slot geometry (`rust/engine/ironhorse-vm/src/interp.rs:322-328`).
- **Property-key space**: guest interning is admitted against the `u16` id space with a catchable
  `RangeError` (`rust/engine/ironhorse-vm/src/interp/property/keys.rs:54-69`), and an intern that
  would alias latches a halt before the next instruction
  (`rust/engine/ironhorse-vm/src/interp/dispatch.rs:281-290`).
- **No guest clock.** `Temporal.Now` is a fixed epoch in UTC
  (`rust/engine/ironhorse-vm/src/interp/natives/temporal.rs:1854-1855`,
  `rust/engine/ironhorse-vm/src/interp/boot.rs:2275-2278`); see open question Q4 for `Date.now`.

### 2.3 Host memory outside the limits

Verified to be outside every ceiling, and bounded only indirectly:

- **Derived indexes** (`property_index`, the int-hash tables' own overhead, the derived structures
  round 2 proposes) are not charged; they are proportional to charged quantities (slots, keys).
- **Garbage within a crank.** Nothing collects within a crank
  (`designs/ironhorse-engine.md:996-999`), so a crank's garbage is resident until the operator
  collects; it is still bounded by the ceilings, since garbage occupies slots and chunks.
- **Retained bytecode.** Each `eval` or `Function` unit's bytecode is pushed into `code_segments`
  for the realm's lifetime (`rust/engine/ironhorse-vm/src/interp/eval.rs:147-154`), compacted only
  by
  a collection (`rust/engine/ironhorse-vm/src/interp/gc.rs:271-295`).
  I found no footprint charge on that push; compilation itself is metered by source bytes and
  compiler work (`rust/engine/README.md:29-30`), so within one crank the growth is bounded by the
  computrons spent compiling, not by the chunk ceiling.
  See Q1.

### 2.4 Hash flooding (HashDoS), per hasher

| Table family | Hasher | Keys | Can the guest steer the keys? | Worst case |
|---|---|---|---|---|
| Name and string-keyed tables (`SymbolName`, registry keys) | std `RandomState` (SipHash-1-3, OS-seeded per table) | Guest-spelled text | Fully | The standard keyed-SipHash position: collisions need the key |
| Integer side tables: `SlotIndex`, `u16` key ids and pairs (for example `func_segments`, `rust/engine/ironhorse-vm/src/interp/state.rs:536`) | `IntBuildHasher`: one folded 64x64-bit multiply per word, keyed by a per-process seed drawn from `RandomState` (`rust/engine/ironhorse-vm/src/int_hash.rs:36-56`), finish `state ^ (state >> 32)` (`:123-127`) | Arena handles and interned ids | **Partly** (below) | Quadratic probing within one table, unmetered |
| Decimal index-name index | `BTreeMap<u32, u16>` (`rust/engine/PORFFOR-RESULTS.md:91-93`) | Guest-spelled index names | Fully | O(log n); no hashing |

**The int-hash claim, checked.**
The module documentation says "The keys are not chosen by the guest. A guest influences which arena
slots and key ids exist ... but it cannot pick their values"
(`rust/engine/ironhorse-vm/src/int_hash.rs:14-18`).
That is too strong as written:

- Slots are handed out from a LIFO free list, else by growing the arena
  (`rust/engine/ironhorse-vm/src/value.rs:1244-1260`, `:1277-1289`), and allocation is
  deterministic.
  A guest that allocates filler objects between the objects it cares about can therefore place the
  keys of a table such as `functions` or `arrays` at an arithmetic progression of its chosen stride,
  and across collections it can shape which indices are reused.
- Key ids are assigned densely in interning order (names upward, symbol keys downward from the top,
  `rust/engine/ironhorse-vm/src/interp/property/keys.rs:61-69`), so the guest chooses which name
  gets
  which id, inside a contiguous range of at most 65,536.

What the guest cannot do, as far as the code shows:

- **Learn the seed.**
  It is drawn from OS randomness once per process and never persisted
  (`rust/engine/ironhorse-vm/src/int_hash.rs:31`, `:52-56`).
  Iteration order of these tables is not observable: every snapshot row writer sorts
  (`rust/engine/ironhorse-vm/src/int_hash.rs:26-30`; for example
  `rust/engine/ironhorse-vm/src/interp/persist.rs:492`), and computrons do not depend on probe
  counts.
  The guest has no clock to time probes (section 2.2).
- **Spread-insensitive structure.** The fold and finish mix high key bits into the bucket bits, and
  the round-1 simulation measured power-of-two strides filling at least 2,442 of 4,096 buckets over
  40 seeds, against about 2,590 for a uniform hash (`rust/engine/PORFFOR-RESULTS.md:279-287`).

What is not established:

- The mixer is not a keyed pseudorandom function, and nothing in the repository proves that no
  seed-independent multicollision family exists for it; the argument is seed secrecy plus measured
  spread.
- If an attacker did know the seed (it is in process memory, and the operator is trusted, so this
  needs a separate leak), it could build a table whose keys share a probe sequence.
  The worst case is then O(n) per probe and O(n^2) per bulk build for one table, with n bounded by
  live slots (at most the slot ceiling, one million by default) for `SlotIndex` keys and by 65,536
  for key ids.
  That costs host CPU time that the meter does not charge, so it is a liveness attack on the
  operator, not a safety break: results, computrons and snapshot bytes stay correct.
- Under rule 3 ("If the hash is a perf optimization technique that's not a security issue") this
  residual is accepted.
  If the owner wants it closed, the cheap options are a per-table seed, replacing dense
  `SlotIndex`-keyed tables by direct `Vec` indexing (round 2's exotic bits take that shape), or a
  probe-length guard that rehashes.

**Correction to carry into the source:** reword `rust/engine/ironhorse-vm/src/int_hash.rs:14-18` to
"a guest shapes the key set
but cannot learn the seed".

### 2.5 SES integrity

Not a seam property, but the reason derived caches are held to exactness: a stale property cache
that returned a value past `Object.freeze`, a deleted accessor or a Proxy trap would be a guest
escape from hardening, not a performance bug.
Round 2 requires every accelerator to be either a superset filter that falls back to the exact path,
or a cache validated on every relevant write (`rust/engine/PORFFOR-ROUND2-PLAN.md`, items 3, 6 and
7), plus a differential gate comparing accelerated and plain execution.

## 3. What the engine does not defend against

- **Forged or corrupted snapshot contents.**
  A container or store can describe any heap, including one that violates SES invariants (for
  example a lockdown marker that says "locked down" over unfrozen intrinsics; restore reads that
  marker and trusts it, `rust/engine/ironhorse-vm/src/interp/restore.rs:101-123`).
  Restore validation (section 4) refuses many malformed images, but it is not a proof that the image
  is one an honest machine could reach, and it is not designed to be.
- **Bit rot that still decodes.**
  The stores carry no integrity hashes since phase 13; SQLite checksums only its WAL frames and the
  file store none (`designs/ironhorse-snapshot-store-seam.md:21-27`).
- **A hostile operator or embedder.**
  The embedder sets the ceilings (`rust/engine/ironhorse-vm/src/value.rs:10-13`), attaches or omits
  the meter host, chooses when to collect, and may hand the VM arbitrary bytecode through
  `Interp::run` (`rust/engine/ironhorse-vm/src/interp.rs:2841`); none of that is checked against a
  policy.
- **A tampered store or a second writer.**
  A store has one writer by contract; the run-time re-checks that once detected a second writer
  were retired, and a pairing token now catches a mismatched session at its next checkpoint
  (`designs/ironhorse-snapshot-store-seam.md:61-80`).
- **Cross-boundary exchange.**
  A consumer that accepts a heap across a trust boundary must authenticate it itself, for example by
  signing the canonical export's CAS address (`designs/ironhorse-snapshot-store-seam.md:27-31`).
- **Side channels and host resources outside the engine**: wall-clock timing seen by the operator,
  the transitive dependencies `README.md:91` excludes, and SQLite.

## 4. Validation that still runs on restore, and why

| Check | Where | Purpose | Classification under this model |
|---|---|---|---|
| Format, schema, signature with boot fingerprint, cost-table name and digest | `rust/engine/ironhorse-snapshot/src/machine.rs:1280-1300`, `rust/engine/ironhorse-snapshot/src/image.rs:132-148`, `rust/engine/ARCHITECTURE.md:225-229` | Refuse a heap made by an incompatible build or under another meter release | **Compatibility, required**: it protects computron determinism across releases, which a trusted snapshot does not supply by itself |
| Decode bounds checks on rows and atoms | `rust/engine/ARCHITECTURE.md:226-228` | Turn a corrupt row into a typed error | **Robustness**: guards engine bugs and accidental damage; not a guest defence |
| Container canonical form: the image is re-encoded and compared with the input | `rust/engine/ironhorse-snapshot/src/image.rs:5434-5439` | One machine, one encoding (content addressing) | **Optional under this model**; candidate to move to the explicit validator after measuring its cost |
| Stored property ids inside the name tables | `rust/engine/ironhorse-snapshot/src/image.rs:5450-5460` | A stray id would otherwise read or write the wrong key | Robustness |
| Row references live, of the right kind, acyclic; row owners ascending | `rust/engine/ironhorse-vm/src/interp/persist.rs:23-160` | Avoid panics and impossible graphs during reconstruction | Robustness |
| Session completeness, callable graph, suspended cursors at instruction starts, accessor backing, mapped arguments, promise capabilities, quiescence, lockdown marker well-formed | `rust/engine/ironhorse-vm/src/interp/restore.rs:68-130`, `:156-245` | Same | Robustness; the cursor check is also what makes a resumed generator's pc safe to dispatch from |
| Lazy faults: exact row lengths; a pairing check on faults of an unbound machine | `designs/ironhorse-snapshot-store-seam.md:61-80`, `:320-325` | Avoid splicing two machines' rows | Robustness against operator error |
| Explicit validators (`validate_store`, `validate_store_content`) | `rust/engine/ARCHITECTURE.md:234-235` | On-request full checks | Tooling; not on the open path |

Two of these have a cost worth noting.
The container re-encode doubles the encode work of a container read.
The suspended-cursor check scans every function for each suspended function's body
(`rust/engine/ironhorse-vm/src/interp/restore.rs:212-226`), so its cost grows with suspended
functions times functions; it should be kept and made linear, not removed.

Dispatch-time decode refusals (`rust/engine/ironhorse-vm/src/interp/dispatch.rs:291-344`) are the
one per-instruction check whose stated purpose includes corrupt snapshots
(`designs/ironhorse-engine.md:894-897`).
Under this model they can move to a once-per-buffer verification at install, which still refuses a
corrupt buffer without a panic (round-2 plan, item 5).

## 5. What a deployer must therefore ensure

1. **Snapshot integrity and provenance are the operator's responsibility.**
   Restore only containers and stores written by an engine build you trust, at a compatible release
   (the gates in section 4 refuse incompatible ones, not malicious ones).
2. **Storage that detects corruption** if undetected bit rot matters: a checksumming filesystem or
   SQLite VFS (`designs/ironhorse-snapshot-store-seam.md:21-27`).
3. **One writer per store**, and no store shared between processes that are not coordinated.
4. **Authenticate any heap that crosses a trust boundary** outside the engine (sign the export's CAS
   address).
5. **Run the engine on a thread of at least `NATIVE_STACK_BYTES`**
   (`rust/engine/ironhorse-vm/src/lib.rs:105-111`), with `panic=unwind`
   (`rust/engine/WASM-BLOCKERS.md:150-178`).
6. **Choose ceilings and meter limits**, and attach a meter host to every armed machine, including
   after restore (`rust/engine/ironhorse-vm/src/interp/admission.rs:61-72`).
7. **Collect between cranks** on a schedule that bounds crank-local garbage and retained eval code
   (section 2.3).
8. **Treat `Interp::run`'s bytecode argument as trusted input**: give it only compiler output from
   the same release.

## 6. Verified facts and their citations, in one place

- Engine library roots forbid `unsafe`: section 2.1.
- Overflow checks on in release: `rust/engine/Cargo.toml:29-31`.
- Resource halts unwind and are caught at the run boundary; other panics propagate:
  `rust/engine/ironhorse-vm/src/value.rs:89-105`,
  `rust/engine/ironhorse-vm/src/interp.rs:2973-2996`.
- Native recursion is budgeted: `rust/engine/ironhorse-vm/src/interp.rs:366-369`, `:409`.
- One computron unit per opcode; check points:
  `rust/engine/ironhorse-vm/src/interp/dispatch.rs:222-228`,
  `:304-305`, `:1015-1020`.
- Heap and side-storage ceilings: `rust/engine/ironhorse-vm/src/value.rs:10-41`,
  `rust/engine/ironhorse-vm/src/side_storage.rs:1-27`.
- Integer hasher seeded per process, not persisted: `rust/engine/ironhorse-vm/src/int_hash.rs:31`,
  `:52-56`.
- Guest can shape slot indices and key ids: `rust/engine/ironhorse-vm/src/value.rs:1244-1260`,
  `:1277-1289`, `rust/engine/ironhorse-vm/src/interp/property/keys.rs:61-69`.
- Store trusted since 2026-09-24: `designs/ironhorse-snapshot-store-seam.md:11-31`.
- Containers still validated, including canonical re-encoding:
  `rust/engine/ironhorse-snapshot/src/image.rs:5434-5460`.

## 7. Open questions

- **Q1. Retained eval bytecode.**
  Is it intended that `code_segments` growth inside a crank is bounded only by compile computrons
  and not by the chunk ceiling (`rust/engine/ironhorse-vm/src/interp/eval.rs:147-154`)?
  Round 2's derived dispatch buffer would double that host memory.
- **Q2. Containers.**
  Does rule 2 cover containers as fully as stores, so that the canonical re-encode
  (`rust/engine/ironhorse-snapshot/src/image.rs:5438`) may leave the production read path?
  ARCHITECTURE currently says "Containers can come from elsewhere, so they are still validated
  completely before adoption" (`rust/engine/ARCHITECTURE.md:236`).
- **Q3. HashDoS residual.**
  Is the int-hash position in section 2.4 acceptable as documented, or should dense
  `SlotIndex`-keyed tables move to direct indexing for this reason as well as for speed?
- **Q4. `Date.now`.**
  I verified `Temporal.Now`'s fixed clock but did not trace what `Date.now` returns
  (`NativeMethod::Date(2)`, installed at `rust/engine/ironhorse-vm/src/interp/boot.rs:2734`); the
  "no guest clock" claim depends on it.
- **Q5. Guest-reachable panics.**
  Is there an inventory of panics a guest can reach outside the resource halts?
  `overflow-checks` turns arithmetic bugs into exactly such panics, and section 2.1 treats them as
  denial of service against the embedder.
- **Q6. Regular expressions.**
  This draft does not assess backtracking cost; `rust/engine/README.md:218-221` cites recursion
  bounds in `ironhorse-regexp` and the `guest_no_abort` fuzz target, but whether every backtracking
  step is metered was not checked.
