# IronHorse: string garbage inside a crank and the chunk ceiling

| | |
|---|---|
| **Created** | 2026-11-01 |
| **Updated** | 2026-11-01 |
| **Author** | kriscendobot (prompted) |
| **Status** | Proposed |
| **Source** | Follow-up named in PR #1618 (test262 ratchet slice 18); architecture review 2026-10-16 findings RGX-1, NVAL-3, NVAL-9, MEM-1 |

## Problem

About 820 test262 rows are `skip:ironhorse-aborted-limit`:
the remainder of `built-ins/RegExp/property-escapes/generated`,
`built-ins/RegExp/unicodeSets/generated`, and
`built-ins/RegExp/CharacterClassEscapes`.
Once PR #1618 lets the matcher handle long greedy runs, these rows get past the matcher
and halt with `HeapExhausted` on the 256 MiB chunk ceiling (`DEFAULT_CHUNK_CEILING`) instead.

The cause is the harness, not the regexp.
`buildString` in `harness/regExpUtils.js` builds its subject with
`result += String.fromCodePoint.apply(null, chunk)` about 110 times.
`Interp::concat_add` (`interp/strings.rs`) decodes both operands, joins them, and appends a
new chunk holding the whole result.
Every earlier `result` becomes garbage, about 250 MiB in total for one test.
`Interp::collect_garbage` refuses collection unless `is_quiescent()` holds
([ironhorse-quiescent-gc](ironhorse-quiescent-gc.md)), so none of that garbage is reclaimed
until the crank ends.
XS collects during the run and completes.

Verified 2026-11-01: with the ceiling raised to 512 MiB (`CONSENSUS_MAX_CHUNK_CEILING`),
`ASCII.js` and `Script_-_Old_Turkic.js` complete on both engines with matching results.
The live data is small: the largest subject is about 1.1M code points, about 2.2 MiB.

The same mechanism affects ordinary guest programs.
NVAL-3 measured an uncatchable halt after about 16,400 single-character appends at the
default ceiling.
MEM-1 shows the same halt for object garbage
(`for (i = 0; i < 499449; i++) last = { a: i }`).

## Options

### (a) Collection at dispatch safepoints inside a crank (recommended)

Admit full collection at an instruction boundary of the dispatch loop when no native
activation is live, and trigger it from chunk pressure.

- **What it fixes.** Every garbage-driven `HeapExhausted` reached from bytecode at native
  depth zero: string append loops, object churn (MEM-1), and these test262 rows.
  The ceiling then bounds the live set plus one instruction's allocation, which is what an
  embedder setting a ceiling expects.
- **What it does not fix.** Garbage produced inside a guest callback under a native
  operation (for example, appending in an `Array.prototype.reduce` callback) still halts,
  because native Rust locals may hold guest values there.
  The quadratic copying of `concat_add` (four copies of the whole result per `+`) remains.
- **Cost.** The collector, its relocation, side-table pruning, and the root declarations for
  registers, frames, and saved continuations already exist and are kept by the quiescent
  design.
  The new work is an admission predicate, a deterministic trigger, a weak-reference rule,
  and tests.
- **Conflict to resolve.** [ironhorse-quiescent-gc](ironhorse-quiescent-gc.md) §
  Halts, pressure, and recovery says allocation must not trigger collection during
  execution.
  Its reason is native locals across callbacks; a native-depth-zero safepoint has none.
  This design amends that contract and needs the maintainer's agreement
  (see Open questions).
  The architecture review's Step 3 recommends the same mechanism.

### (b) Concatenation that does not copy the whole string

Two variants.

- **Growing a uniquely held tail in place.** Not available with the current representation.
  The string's length lives in its chunk header, and a `Slot` holds only a `ChunkOffset`,
  so two strings cannot share a prefix.
  Nothing records whether a string is uniquely held, and extending a chunk another slot
  still references would change that string.
  Making this work needs a length or capacity in the slot, which is a representation
  change at least as large as ropes.
- **Ropes.** A concatenation allocates a small node chunk naming its two operands; readers
  flatten on demand.
  This fixes the test262 rows and NVAL-3's quadratic time, and it does not touch the
  quiescence contract.
  It is invasive: there are 183 `Payload::String` sites and 38 direct payload reads
  (`str_content`, `chunks.payload`) in 13 files, and byte-wise `ChunkSlice` comparison
  assumes flat payloads.
  Chunks become interior nodes, so the collector must trace chunk-to-chunk edges and
  rewrite them on relocation, and the snapshot schema needs a new chunk kind.
  Flattening cannot be cached in place, because readers take `&self` and slots are copied
  by value.
  It fixes only strings; MEM-1's object garbage still halts.

Ropes are worth a separate performance design for NVAL-3.
They are not needed to make these rows pass once (a) lands.

### (c) A larger chunk ceiling for the test262 harness only

Setting the harness to 512 MiB makes the two sampled rows pass today.
It hides the gap: the harness would stop reporting a limit that ordinary guests still hit
at the default profile, and a larger generated test would need a larger ceiling again.
512 MiB is already the consensus maximum, so there is no further room.
Rejected as the fix.
It remains a useful local diagnostic to separate a garbage halt from a live-set halt.

## Recommended design: safepoint collection

### Admission

Add an admission case alongside `is_quiescent()`, used only by the in-crank trigger.
`collect_garbage` and `free_pages` keep their quiescent-only public admission.
The safepoint admits collection when all of the following hold:

- the dispatch loop is between instructions, before decoding the next opcode;
- native depth is zero, so no native operation is executing and no Rust local holds a
  guest value;
- no host halt is pending, the `gc_failed` latch is clear, and no collection is already in
  progress;
- the current activation is not inside a construct whose temporary roots are not declared.
  The builder audits the promise temporary-root ranges and the `finally` paths named in the
  quiescent design and lists any opcode that must not be followed by a safepoint.

Promise jobs drained by the dispatch loop at native depth zero are admitted on the same
terms.
The dispatch loop reloads any cached chunk offsets or decoded operands after a collection,
since compaction moves chunks.

### Trigger

The trigger is a pure function of machine state, so every replica collects at the same
instruction.

- After each safepoint check, collect when the chunk arena's used bytes, including
  `side_reserved`, exceed half the ceiling **and** at least a quarter of the ceiling has
  been allocated since the last collection.
- The second condition is the anti-thrash rule.
  A guest whose live set sits near the ceiling cannot force a collection every few
  instructions; it allocates a quarter of the ceiling of metered allocation between
  collections, or halts.
- The check is a comparison of two counters; it allocates nothing.
- An allocation that crosses the ceiling between safepoints still halts `HeapExhausted`,
  as it does today.
  A restartable-instruction retry is a possible later refinement and is out of scope.

The slot arena gets the same rule against its slot ceiling, since MEM-1 is a slot halt.

### Weak references

An in-crank collection treats every `WeakRef` target, `WeakMap`/`WeakSet` key, and
`FinalizationRegistry` cell as strong.
Weak clearing and cleanup scheduling remain the quiescent collector's work.
This satisfies ECMA-262 §9.10 (Processing Model of WeakRef and FinalizationRegistry Targets)
and its `AddToKeptObjects`/`ClearKeptObjects` operations without tracking a kept set,
because nothing weak is cleared before the job ends.
Guest-observable weak behavior is then identical to today's quiescent-only machine.

### Metering

Collection is meter-neutral: it charges no computrons, and a guest's raw meter receipt is
identical with and without safepoint collection.
The anti-thrash rule bounds unmetered collector work to a constant multiple of metered
allocation: each collection, costing at most about one ceiling's worth of work, follows at
least a quarter-ceiling of metered allocation.

### Persistence and recovery

Collection marks moved extents dirty through the existing `ChunkArena::compact` path; the
next checkpoint writes them.
A crank that later halts rewinds to its last durable checkpoint exactly as today, so a
safepoint collection never needs its own rollback.
A collector failure sets `gc_failed` and halts the crank through the existing path.

## Ownership map

| Boundary | Mechanism | Policy | Durable state | Commit/discard | Value crossing |
|---|---|---|---|---|---|
| Dispatch loop to collector (VM) | VM collector | VM trigger constants (fixed per profile, part of consensus) | none; the heap is volatile until checkpoint | VM: `gc_failed` latch on collector failure | admission decision; `GcStats` |
| VM to embedder (`PersistentMachine`) | embedder checkpoint | embedder: quiescent collection cadence, unchanged | embedder's store | embedder: rewind or persist after the execution outcome | execution outcome; dirty extents |
| Engine to test262 harness | VM | harness sets the default profile, no special ceiling | expectation files | ratchet | row verdicts |

- Persistent state: the embedder's store; the VM owns none of it.
- Commit/discard: the embedder decides after the execution outcome; a safepoint collection
  is not a commit point.
- Restart/replay: the embedder rewinds to the last checkpoint; replay reaches the same
  safepoints because the trigger is deterministic.
- Execution classification: the VM reports the execution outcome; a safepoint collection
  is not visible in it.

Naming check: the new predicate is an execution-level concept and should be named for the
dispatch loop (for example, `at_dispatch_safepoint`), not for cranks.

## Related RegExp review points (RGX-1, 2026-10-16)

### Report a matcher ceiling as a catchable error

`MAX_MATCH_STATES` and `MAX_MATCH_BYTES` bound the matcher's private scratch storage, not the
chunk heap.
When a match exceeds them, `match_regexp_metered` returns `Halt::HeapExhausted`, which guest
`try`/`catch` cannot intercept.
The scratch is dropped when the match returns and the heap is untouched, so nothing requires
a machine halt.

- Throw a guest `RangeError` from the exec path when `outcome.resource_limit` is set.
  Use a fixed message, such as `regular expression match exceeds implementation limit`.
- Apply the same rule to `CompileError::ResourceLimit` from compilation (today the
  `ResourceLimit` arm in `natives/regexp.rs` also halts), throwing `SyntaxError` only where
  ECMA-262 requires one and `RangeError` for an implementation limit.
- This follows the rule NVAL-9 asks for: a per-operation scratch bound that leaves the heap
  intact becomes a catchable error; a ceiling on the shared heap stays a halt.
- Metering is unchanged: the match was charged up to the point it stopped.

The ratchet must keep rows that now throw from being counted as failures of conformance
logic.
`ironhorse-262` classifies `ironhorse-aborted-limit` from the halt; a thrown `RangeError`
with the fixed message needs its own skip class (see Open questions).

### Clamp quantifier bounds above 2^31-1, as XS does

`quantifier_parse_digits` in `ironhorse-regexp/src/compile.rs` returns
`CompileError::ResourceLimit` for a bound above `0x7FFF_FFFF`, which halts the machine.
`built-ins/RegExp/quantifier-integer-limit.js` builds patterns such as
`b{9007199254740991}` that ECMA-262 accepts.
XS's `fxPatternParserDecimal` saturates and clamps the bound to `0x7FFFFFFF`.

- Clamp both bounds to `MAX_QUANTIFIER` instead of refusing.
- Perform the early-error check of ECMA-262 §22.2.1.1 (a `{m,n}` quantifier with `m > n` is a
  SyntaxError) on the unclamped values.
  Today `decimal` saturates at `u32::MAX`, so `{4294967296,4294967295}` compares equal and
  the required SyntaxError is lost.
  Compare digit strings exactly (strip leading zeros, then compare length, then digits).
- Clamping a minimum is not observable: no string can hold 2^31-1 code units (about 4 GiB) within the
  u32 chunk address space, so `b{2147483648}` and `b{2147483647}` both fail to match every
  subject.

## Test plan

- `ironhorse-vm/tests/`: an append loop of 100,000 single characters at the default ceiling
  completes; the MEM-1 loop of 2,000,000 iterations completes; both give guest results and
  raw meter receipts identical to a run at a ceiling large enough to need no collection.
- The same append loop inside a `reduce` callback still halts `HeapExhausted`, documenting
  the native-depth limit.
- Safepoint collection preserves suspended generators, pending promises, closures,
  BigInts, and native-name metadata (reuse the cases from the quiescent design's
  acceptance list).
- `WeakRef.prototype.deref` inside the crank returns its target across a forced safepoint
  collection; the target is cleared only after a quiescent collection.
- A near-ceiling live set: the anti-thrash rule bounds collections to at most
  four per ceiling of allocation, measured with a counter.
- Determinism: two machines running the same crank collect at the same instruction count;
  checkpoints after the crank are byte-identical.
- test262: run the ~820 rows at the default profile; they move from
  `skip:ironhorse-aborted-limit` to `pass`, with XS-oracle agreement, and no other row
  regresses.
- RegExp: `/a*/.exec(s)` past `MAX_MATCH_STATES` with a non-compressible pattern such as
  `(a|aa)+` throws a catchable `RangeError`; `quantifier-integer-limit.js` passes;
  `/a{4294967296,4294967295}/` is a SyntaxError.

## Sequencing

1. Land PR #1618 (matcher run compression); it is still open on 2026-11-01.
2. The RegExp points (catchable limit, quantifier clamp): small and independent of the
   collection decision.
3. Safepoint collection, after the maintainer agrees to amend the quiescent contract.
4. Ropes, if wanted, as a separate NVAL-3 performance design (to be filed).

## Open questions

- Does the maintainer agree to amend [ironhorse-quiescent-gc](ironhorse-quiescent-gc.md) to
  admit a native-depth-zero dispatch safepoint inside a crank, or should the rows wait for
  ropes, which leave the quiescent contract untouched?
- Should the trigger constants (one half and one quarter of the ceiling) be fixed per
  profile, or configurable by the embedder with the ceilings?
  They affect when collection happens, but not results or meter receipts.
- Which skip class should the ratchet use for a row that now throws the matcher's
  `RangeError`: a new `skip:ironhorse-regexp-limit`, or keeping `ironhorse-aborted-limit`
  keyed on the fixed message?
