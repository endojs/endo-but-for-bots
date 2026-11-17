# Map: VM memory, garbage collection, admission and metering

Reviewed commit `61cd656cb`.

## Scope

| File | Lines |
|---|---:|
| `rust/engine/ironhorse-vm/src/gc.rs` | 552 |
| `rust/engine/ironhorse-vm/src/interp/gc.rs` | 460 |
| `rust/engine/ironhorse-vm/src/interp/gc_tables.rs` | 1,083 |
| `rust/engine/ironhorse-vm/src/interp/roots.rs` | 269 |
| `rust/engine/ironhorse-vm/src/interp/admission.rs` | 341 |
| `rust/engine/ironhorse-vm/src/interp/metering.rs` | 1,727 |
| `rust/engine/ironhorse-vm/src/meter.rs` | 540 |
| `rust/engine/ironhorse-vm/src/cost.rs` | 533 |
| `rust/engine/ironhorse-vm/src/meter_consistency.rs` | 141 |
| `rust/engine/ironhorse-vm/src/bulk.rs` | 1,297 |
| `rust/engine/ironhorse-vm/src/side_storage.rs` | 133 |
| `rust/engine/ironhorse-vm/src/side_tables.rs` | 69 |
| `rust/engine/ironhorse-vm/src/interp/side_ledger.rs` | 161 |
| `rust/engine/ironhorse-vm/src/snapshot_dirty.rs` | 302 |
| `rust/engine/ironhorse-vm/src/value.rs` (arena/Slot/chunk layout) | 3,465 |
| `rust/engine/ironhorse-vm/src/interp/state.rs` (layout only) | 3,384 |
| `rust/engine/ironhorse-meter/src/{lib,default_keys,releases,sha256}.rs` | 359 + 544 + 60 + 254 |
| `rust/engine/benches/` (README 1,713; `baseline.json`, `run.py`, `xs_compare.py`, `code_size.py`, `stack_height.py`, tests) | ~5,100 |
| `rust/engine/WASM-MEMORY.md` | 658 |
| `rust/engine/RECLAMATION.md` | 157 |
| `rust/engine/DETERMINISM-METERING.md` | 130 |

## What was read

**Probes.** Probe directory (all sources and raw outputs):
`../probes/vm-memory-gc-meter/`
(`$P` below).
An earlier reviewer of this region was cut off by a usage limit.
Its probe `zz_audit_vm_memory_1.rs`, `run.sh`, its JS probes and `meter.out` were reused.
Every number cited from them was re-run at this commit, in release, except the 1e8-element
`fill` (90.6 s), quoted from the release `meter.out` and corroborated by re-measured
1M–16M sizes (see "Build note" below).

**Build note.**
`meter.out` was produced by a **release** build: `$P/build1.log` ends in
"Finished `release` profile" and its executable lives under `audit-target/release/deps`.
The decisive cases were re-measured in release anyway (`$P/probe3.out`; `$P/probe2.out`).
All Rust probes ran as `cargo test --release` with
`CARGO_TARGET_DIR=$SCRATCH/audit-target RUST_MIN_STACK=33554432`.
All JS probes ran on `rust/engine/target/release/ironhorse-xst` through `$P/run.sh`, which also
samples peak RSS (`VmHWM`).
The temporary tests `ironhorse-vm/tests/zz_audit_vm_memory_{1,2,3}.rs` were deleted after use;
copies are in `$P`.

- **Full read:** `gc.rs`, `interp/gc.rs`, `interp/gc_tables.rs`, `interp/roots.rs`,
  `side_storage.rs`, `side_tables.rs`, `interp/side_ledger.rs`, `snapshot_dirty.rs`,
  `RECLAMATION.md`, `DETERMINISM-METERING.md`.
- **Close targeted read:** `value.rs` lines 1–1720 (ceilings, `Slot`, `Payload`, `Kind`,
  `SlotArena` alloc/free/mark/sweep/resident accounting) and 1716–2950 (`ChunkArena`: free-block
  index, `alloc`, `slice_mut`, `mark_dirty_range`, `compact_local`, `compact`);
  `interp/admission.rs` (all of it except the meter-escape helpers' callers);
  `meter.rs` 1–330; `cost.rs` (feature-gated recorder and `CostModel`);
  `meter_consistency.rs`; `bulk.rs` 1–420 (`SideRefCounts`, `ArrayData`) and 420–945
  (`CollKey`, `CollectionData` find/push/remove/compact/prune); `ironhorse-meter/src/lib.rs`
  (weights table header, `chunk_cost`, digest).
- **Field-roster read:** every `#[gc_hook]`, `#[gc_slots]`, `#[gc_weak]` attribute in
  `interp/state.rs` (awk-extracted), plus `select_gc_tables`.
- **Outside the region, read only to follow a mechanism:** `interp/natives/buffer.rs`
  (`typed_array_sort`, `typed_array_mutator`, element setters, `alloc_array_buffer`),
  `interp/natives/weak.rs` (register/unregister/cleanup), `interp/function.rs:750–870` (bind),
  `interp/natives/array.rs:4228–4330` (array chunk metering, merge sort),
  `interp/natives/dispatch.rs:4362–4440` (Array fill/reverse), `interp/natives/string.rs:725–760`
  (pad cap), `interp/property/indexed.rs:115–130`, `property_index.rs:1–160`,
  `interp.rs` struct definitions (`FuncInfo`, `BoundData`, `AccessorData`, `PromiseData`,
  `PromiseReaction`, `SavedFrame`, `ErrorInfo`, `RegExpData`), `compartment.rs:1243–1262`,
  `ironhorse-snapshot/src/machine.rs:1555–1640` (who calls the collector),
  `ARCHITECTURE.md:100–200`, `WASM-BLOCKERS.md` B7, `benches/README.md:177–259`,
  `WASM-MEMORY.md` decisions and side-table admission sections.

## What was not read

- `interp/metering.rs` beyond its header and `use` list: it is 1,700 lines of re-exports of
  `ironhorse-meter` weights with calibration provenance; no weight was audited individually.
- `ironhorse-meter/src/default_keys.rs` (the 544-name XS key list) and `sha256.rs` internals.
- `value.rs` lazy-backing paths (`SlotBacking` faults, `evict_page`, `advance_backing`) were
  skimmed only; the store seam belongs to the snapshot-store region.
- `interp/state.rs` beyond the attribute roster (boot initializers, `boundary.rs` quiescence
  predicates).
- `benches/*.py` and `benches/results/*` were not executed; `baseline.json` and the README's
  footprint section were read.
- The store-side partial and generational collectors (`ironhorse-snapshot/src/machine.rs`)
  were read only to confirm they call `Interp::collect_garbage` / `free_pages`.
- `WASM-MEMORY.md` measurements were not reproduced on wasm32; the native counterparts were.

## Architecture as built

**Value and heap records.**
`Slot` (`value.rs:620`) is `{ next: SlotIndex(u32), id: u16, flag: u8, kind: Kind(u8),
value: Payload }`.
`Payload` (`value.rs:565`) is an 8-variant Rust enum whose largest arm is `f64`, so it is
16 bytes (1-byte tag, 7 padding, 8 data) and `Slot` is 24 bytes (measured,
`$P/probe1_ab.out`: `SIZE Slot=24 Payload=16 Kind=1 SlotIndex=4 ChunkOffset=4`).
XS's `txSlot` is 32 bytes on 64-bit.
`Slot` doubles as the JS value representation everywhere outside the arena (the value stack,
`BoundData.args: Vec<Slot>`, `CollEntry`, saved frames, reactions), where `next`/`id` carry
nothing.

**Slot arena** (`SlotArena`, `value.rs:829`, 520 bytes as a struct).
Dense `slots: Vec<Cell<Slot>>` grown by `push` (amortized doubling), a LIFO free list
`free: Vec<u32>`, and four per-slot `Vec<bool>`s: `free_marks` and `marks` here, plus
`watched_slots`/`owner_slots` inside the embedded `PropertyIndex` (`property_index.rs:27–40`).
`alloc` (`value.rs:1226`) refuses at the slot ceiling (`DEFAULT_SLOT_CEILING = 1_000_000`,
`value.rs:14`) with `heap_exhausted()` (a `resume_unwind` caught at the run boundary as
`Halt::HeapExhausted`).
Nothing ever shrinks the record vector, the bitmaps or the free list.
`capacity()` (`value.rs:1358`) is the number of records ever allocated, not `Vec::capacity`.

**Chunk arena** (`ChunkArena`, `value.rs:2066`, 192 bytes).
One `Vec<u8>` of `[u32 length header][payload]` blocks (`CHUNK_HEADER = 4`, `value.rs:1717`),
strings as UTF-16BE, ArrayBuffer bytes, BigInt limbs.
Reusable holes are encoded in-band (`FREE_CHUNK` marker) and indexed best-fit in a
`BTreeMap<span, BTreeSet<addr>>` (`value.rs:1727`, `free_chunk_for` at `:2458`).
Appends use `try_reserve` (amortized doubling, `value.rs:2577`).
`side_reserved` is a ledger of bytes charged for array items, index properties, collection
entries and `Intl.Segmenter` results at declared widths (`side_storage.rs`); the ceiling
(`DEFAULT_CHUNK_CEILING = 256 MiB`, `value.rs:15`) bounds `len + side_reserved + request`.
`slice_mut(off, len)` (`value.rs:2677`) returns the payload prefix `[0, len)` and marks every
64 KiB extent of that prefix dirty (`mark_dirty_range`, `:2348`).

**Side tables.**
`Interp` (6,080 bytes as a struct) holds 46 `HashMap<SlotIndex, _>` tables (std SipHash,
`RandomState`), plus pair-keyed maps: `accessors: HashMap<(SlotIndex, u16), AccessorData>`
(`interp/state.rs:2486`), `private_values` and `private_accessors` keyed by
`(receiver, private-name cell)` (`:1368`, `:1385`).
Function metadata (`FuncInfo`, `interp.rs:843`), bound functions, promises and their reaction
vectors, saved generator/async frames, errors, regexps, collections, arrays (`ArrayData` with
`items: BTreeMap<u32, Slot>`, `bulk.rs:173`) all live there, not in slots.
Each table carries a `Tracked<T>` dirty mask (`snapshot_dirty.rs:72`).
The three "bulk" tables (arrays, index properties, collections) are private to `bulk.rs` and
maintain per-page reference counts (`SideRefCounts`, a `HashMap<u32, u32>`) for the partial
collector, and the side-storage ledger.

**Collection.**
`Interp::collect_garbage` (`interp/gc.rs:110`) is the only exact collector.
It is admitted only at a quiescent boundary (`admit_collection`, `:6`) and is invoked only by
hosts: `Compartment::collect` (`compartment.rs:1243`) and the snapshot crate's `full_collect`
(`ironhorse-snapshot/src/machine.rs:1555`).
`RECLAMATION.md:63`: "No collection runs within a crank."
`collect_full` (`gc.rs:167`) marks from sorted, deduplicated `gc_roots()` with a worklist;
per marked slot it calls `extra_edges` → `visit_owner_slots`, which does one `HashMap::get`
per map-shaped table and a **full scan** of each pair-keyed table (`gc_tables.rs:723–740`).
Then an ephemeron fixpoint (`gc.rs:183–212`): each round rescans every WeakMap's entries
(`gc_tables.rs:824–848`) and, while any symbol-key descriptor is unmarked, the whole slot
arena (`gc_tables.rs:868–896`, "The scan remains O(capacity) per fixpoint round").
Weak state is pruned, the arena is swept in index order, and each swept index runs
`prune_swept` (`gc_tables.rs:109–111`), which for pair-keyed tables is a full `retain`
(`gc_tables.rs:41`, `:45`).
Chunks are compacted **extent-locally** (`compact_local`, `value.rs:2711`): blocks inside one
64 KiB extent are packed when ≥25% dead, crossing blocks stay as anchors or become separate
free markers, the tail is truncated (no `shrink_to_fit`).
The full slide compactor `ChunkArena::compact` (`value.rs:2846`) is called only by tests.
Afterwards code segments and reaction arenas are compacted and the side ledger re-derived.
The collector charges no computrons.
`free_pages` (`interp/gc.rs:316`) is the page-granular reclamation the store-side partial
collector drives; it never compacts chunks.

**Admission and metering.**
The meter (`meter.rs`) is XS's 16.16 fixed point; `tick_*` accrue after the fact,
`charge_and_check` (`meter.rs:276`) accrues and consults the host before work.
Weights live in `ironhorse-meter` (`lib.rs:24–310`, 292 named weights) with a SHA-256 digest
over weights and `DEFAULT_KEYS`.
Temporary host buffers are admitted by `admit_scratch` (`admission.rs:265`): it checks that
`capacity × declared width` would fit under the chunk ceiling **now** but reserves nothing.
Retained side storage is charged only for the four bulk kinds above (`side_ledger.rs:15–34`).

## Candidate findings

### MEM-1 — Allocation never triggers a collection: a crank that churns more garbage than the ceilings halts uncatchably, however small its live set

- **Lens(es):** 3 (skipped feature), 4, 1 (guest-visible halt), 5.
- **Proposed severity:** high.
- **Location:** `rust/engine/RECLAMATION.md:63`; `rust/engine/ironhorse-vm/src/value.rs:1226-1230`
  (slot ceiling), `value.rs:2565-2567` (chunk ceiling); `interp/gc.rs:6-14` (quiescence-only
  admission).
- **Excerpt:**
  ```rust
  pub fn alloc(&mut self, slot: Slot) -> SlotIndex {
      if self.capacity() > self.ceiling
          || (self.free.is_empty() && self.capacity() >= self.ceiling)
      {
          heap_exhausted();
      }
  ```
  `RECLAMATION.md`: "No collection runs within a crank. Allocations can reuse previously
  reclaimed space, but newly unreachable garbage waits until a supported boundary."
- **Mechanism:** The free list only refills at a host-requested quiescent collection.
  Inside one crank every allocation is permanent until the crank ends, so total allocation,
  not live size, is bounded by 1,000,000 slots and 256 MiB.
  XS collects from `fxNewSlot`/`fxNewChunk` when its heap is full.
- **Scenario:** Any loop that allocates temporaries: `for (…) last = {a: i}`, string building
  with `+=`, closures in a loop, `for…of` over a long string.
  The halt is `Halt::HeapExhausted`, uncatchable, and an Endo vat delivery that does this
  fails as a whole.
- **Evidence:** confirmed by probe (release `ironhorse-xst`, bisection; sources `$P/bis_*.js`):

  | Loop body (only the last value is live) | Max iterations that complete | Node 22 |
  |---|---:|---|
  | `last = {}` | 998,896 | 10M fine |
  | `last = { a: i }` | 499,448 | 10M fine |
  | `last = [i, i]` | 998,895 | — |
  | `last = function () { return i; }` | 166,482 (6 slots per closure) | — |
  | `s += 'x'` | 16,377 | 1,000,000 → `1000000` (`$P/concat_node.js`) |
  | `last = 's' + i` | ≥ 2,999,999 (chunk garbage, about 13M would exhaust) | — |
  | `for (const ch of str) re.test(ch)` (`$P/forof_regex.js`) | ~998,486 code points | — |

  `churn.js` (10M `{a:i}`) → `InternalError: ironhorse halted: HeapExhausted` after 0.73 s at
  30 MB RSS.
  test262 relevance: the `regExpUtils.js` `buildString` harness function (`result += …` in
  10,000-code-point chunks) spends almost the whole chunk ceiling on garbage: on the generated
  `\P{Script=Latin}` property-escape test it completes at 265 MB peak RSS
  (`$P/t262b_buildonly.js`), with no headroom; that particular test then dies on the regexp
  state cap (T262-7, another region), as a join-based `buildString` shows
  (`$P/t262b_joinbuild.js` halts at 49 MB).
  `benches/README.md:246-249` already measures "allocation churn … about 2.5x" XS heap
  "because nothing collects within a crank".
- **Recommendation:** Add a deterministic in-crank trigger: when `alloc` finds the free list
  empty at the ceiling (or a chunk append would cross it), collect at the next dispatch-loop
  safepoint where `native_depth == 0`, so no Rust local holds an unrooted `Slot` and the
  existing `gc_roots()` is complete.
  The trigger depends only on counters every replica shares, so it is consensus-safe; it
  must be part of the release (it moves allocation order).
  Halt only if the heap is still full after that collection.
- **Confidence:** confirmed by probe.

### MEM-2 — Collection time is quadratic in guest-controlled table sizes and is not metered

- **Lens(es):** 1 (resource bound bypass), 4.
- **Proposed severity:** high.
- **Location:** `rust/engine/ironhorse-vm/src/interp/gc_tables.rs:723-740` (pair-keyed scan per
  marked slot), `gc_tables.rs:40-47` (pair-keyed `retain` per swept slot),
  `gc_tables.rs:824-848` (WeakMap rescan per ephemeron round), `gc_tables.rs:868-896`
  (whole-arena scan per round), `gc.rs:183-212` (fixpoint loop).
- **Excerpt:**
  ```rust
  // Pair-keyed tables have no per-owner index; preserve their filtered scan.
  for ((owner, _), row) in $vm.$field.iter() {
      if *owner == $idx { gc_slot_row!(gc_run, $vm, row, $visit, true, $row); }
  }
  ...
  $emit! { $vm.$field.retain(|(owner, _), _| *owner != $idx); }   // per swept slot
  ...
  // The scan remains O(capacity) per fixpoint round.
  ```
- **Mechanism:**
  - `extra_edges(idx)` runs once per marked slot and walks all of `accessors`,
    `private_values` and `private_accessors`: O(marked × rows).
  - `swept(idx)` runs once per reclaimed slot and `retain`s the same three tables:
    O(swept × rows).
  - Each ephemeron round rescans every live WeakMap's entries; a chain `k0→k1→…` in one
    WeakMap needs one round per link: O(n²).
  - While any symbol-key descriptor stays unmarked (one dead symbol-keyed property suffices)
    every round also scans the whole slot arena: O(rounds × capacity).
  - `collect_garbage` documents that "the sweep … charges the meter nothing".
    The guest pays linear computrons to build the state; the host pays quadratic time at
    every later collection, and the state stays live.
- **Scenario:** A vat builds 20,000 objects with a shared getter
  (`Object.defineProperty({}, 'x', {get: g})`) for 1.1M computrons (0.37 s).
  Every later collection of that worker takes about 4 s; at 200,000 such objects (well inside
  the 1M-slot ceiling) the quadratic trend gives over six minutes per collection.
  The persistent worker collects on a delivery cadence (`RECLAMATION.md:11`), so this
  stalls the worker indefinitely.
- **Evidence:** confirmed by probe (`zz_audit_vm_memory_1.rs` tests c/i, `$P/c_gc_scaling.out`,
  `$P/dfgi.out`; `zz_audit_vm_memory_2.rs` test c, `$P/probe2.out`):

  | Live state | n | GC time | (×2 n) |
  |---|---:|---:|---|
  | objects with `get x(){}` (own getter) | 8,000 / 16,000 / 32,000 | 0.48 s / 3.05 s / 27.1 s | ×6.3, ×8.9 |
  | shared-getter objects (build: 0.54M / 1.12M computrons) | 10,000 / 20,000 | 0.61–0.77 s / 3.4–3.9 s | ×5.1–5.6 |
  | class instances with 2 private fields | 1k / 2k / 4k / 8k | 4.7 / 14.7 / 54.7 / 281 ms | ~×4 |
  | WeakMap chain | 8k / 16k / 32k | 0.15 s / 0.75 s / 3.7 s | ~×5 |
  | WeakMap chain 4k + 200k live, without / with one dead symbol key | 4,000 | 61–69 ms / 1.0–1.4 s | ×16–20 |
  | for comparison: 100,000 live empty objects | — | 12 ms | — |
- **Recommendation:** Key accessor and private-element rows by owner
  (`HashMap<SlotIndex, SmallVec<…>>`, or keep the accessor pair in the property slot as XS
  does); prune dead keys once after the sweep with the swept bitmap instead of per swept slot;
  give each weak key a pending-values list that is marked when the key is marked (XS-style
  ephemeron lists, O(n) overall); mark a symbol-key descriptor when a marked record with that
  id is traced, instead of rescanning the arena.
  Until then, bound the work (or charge the guest for the tables it creates at a rate that
  covers their collection cost).
- **Confidence:** confirmed by probe.

### MEM-3 — Retained host storage outside every ceiling: bound arguments, disposal records, finalization cells, reactions, frames and function rows grow without charge

- **Lens(es):** 1 (heap ceiling bypass), 4, 6(e) (doc/code disagreement).
- **Proposed severity:** high.
- **Location:** `rust/engine/ironhorse-vm/src/interp/function.rs:763-773` and `:847-854`
  (bound args admitted as scratch, retained in `BoundData`);
  `interp/natives/resource.rs:121`, `:149`, `:176` (`records.push`);
  `interp/natives/weak.rs:194-198` (`cells.push`); `interp/side_ledger.rs:15-34` (the ledger
  covers only arrays, index properties, collections and segments);
  `interp/admission.rs:265-273` (`admit_scratch` reserves nothing);
  `rust/engine/WASM-MEMORY.md:34-36`; `RECLAMATION.md:62`.
- **Excerpt:**
  ```rust
  let bound_args: Vec<Slot> = if argc >= 2 {
      Self::fill_scratch(self.reserve_scratch(argc - 1)?, …)   // admitted as transient scratch
  ...
  self.bound_functions.insert(inst, BoundData { target, this_arg, args: bound_args });
  ```
  `WASM-MEMORY.md`: "The footprint is a linear function of the ceilings, with measured
  constants … 50 per slot of slot ceiling".
- **Mechanism:** `reserve_scratch` only checks that a buffer would fit under the remaining chunk
  ceiling; it is meant for temporaries.
  `bind` keeps that buffer forever.
  `DisposableStack` records, `FinalizationRegistry` cells and promise reaction vectors are
  plain `Vec::push`es with no ledger entry and no pre-flight (an infallible push on wasm32
  traps rather than halting `HostAllocationFailed`).
  Rows for functions, promises, saved frames, errors and regexps are also uncharged, so even
  slot-bounded shapes cost far more host memory per slot than the document's constant.
- **Scenario:** A guest holds hundreds of MB to GB of host memory while using a few thousand
  slots and almost no chunk bytes, past the profile an embedder chose to fit its isolate.
- **Evidence:** confirmed by probe.
  Under the `WASM-MEMORY.md` "128 MB Cloudflare isolate" profile (262,144 slots, 4 MiB of
  chunks), which that document says keeps every phase within 69 MiB
  (`zz_audit_vm_memory_2.rs` test d, `$P/probe2.out`):

  | Program | Outcome | Host heap | Live slots | Chunk bytes | Charged side bytes |
  |---|---|---:|---:|---:|---:|
  | 400 × `f.bind(null, ...a)`, `a` 20,000 ints | completes | 185.5 MiB | 3,116 | 24,390 | 1,064,960 |
  | 4,000,000 × `stack.defer(f)` | completes | 224.3 MiB | 1,112 | 17,190 | 0 |
  | `async f(){ await never }` until the slot ceiling | `HeapExhausted` | 101.8 MiB | 262,144 | 278,226 | 0 |
  | `p.then()` on one pending promise until the ceiling | `HeapExhausted` | 72.0 MiB | 262,144 | 365,236 | 0 |

  Default ceilings, `ironhorse-xst`: `$P/bind_args400.js` (400 binds of 100k args) completes
  at **952 MB peak RSS**; `defer_retain.js` 3M records → 169 MB; `finreg_retain.js` 3M cells →
  99 MB; `then_retain.js` 300k thens → 324 MB.
  The computron charge for bind is proportional (about 16 per bound argument,
  `zz_audit_vm_memory_1.rs` test h); only memory escapes.
- **Recommendation:** Charge every retained Rust-side row against the chunk ledger at declared
  widths, as `side_storage.rs` already does for the bulk tables: bound arguments (convert the
  scratch reservation into a side reservation), disposal records, finalization cells, reaction
  vectors, saved frames, and fixed per-row widths for `FuncInfo`, `PromiseData`, `ErrorInfo`,
  `RegExpData`, accessor and private rows.
  Re-derive them in `side_storage_charge`.
  Correct `WASM-MEMORY.md`'s per-slot constant, which the measured shapes above exceed by up
  to 8×.
- **Confidence:** confirmed by probe.

### MEM-4 — TypedArray natives do unmetered linear and quadratic work: per-element dirty marking from the buffer start, no per-element charge, an O(n²) default sort with 24-byte scratch

- **Lens(es):** 1 (meter bypass; unbounded work before a check point), 4, 2.
- **Proposed severity:** high.
- **Location:** `rust/engine/ironhorse-vm/src/value.rs:2677-2687` (`slice_mut` dirties
  `[start, start+len)`), `value.rs:2348-2364`; `interp/natives/buffer.rs:1691-1695` (fill),
  `:1698-1715` (reverse), `:1306-1398` (sort), and every element store that calls
  `slice_mut(buf.data, base + size)` (`buffer.rs:1958`, `:2090`, `:2135`, `:2303`, `:2441`).
- **Excerpt:**
  ```rust
  for i in start..end {
      let pos = ta.offset as usize + i as usize * size;
      let out = self.chunks.slice_mut(buffer.data, pos + size);   // dirties [0, pos+size)
      out[pos..pos + size].copy_from_slice(&bytes);
  }
  ...
  // Stable insertion sort keeps comparator calls sequenced and fallible
  ```
- **Mechanism:**
  - `slice_mut(off, len)` hands out the payload prefix of length `len` and sets the dirty bit
    of every 64 KiB extent in it; callers pass `pos + size`, so each element write costs
    O(pos / 64 KiB). `fill` over n elements is therefore O(n²/65,536).
  - `fill`, `reverse`, `copyWithin` and same-type `set` charge no per-element computrons and
    contain no meter check point; `reverse` also allocates two `Vec`s per swap.
  - The default `sort` is an insertion sort: O(n²) numeric compares charged only
    `reserve_work_scratch(n)` (0.25 computron per element); its scratch is `Vec<Slot>`
    (24 bytes per element whatever the element width), and BigInt arrays allocate a chunk per
    element.
  - `Array.prototype.fill` charges 5 builtin steps per element (`dispatch.rs:4393-4400`);
    the TypedArray sibling charges none.
- **Scenario:** `new Uint8Array(1e8).fill(7)` runs for 90 s on 1,563 computrons, and an armed
  host cannot interrupt it.
  A reversed 1e6-element `Float64Array.prototype.sort()` is ~5×10¹¹ compares charged about
  250k computrons.
  `new Uint8Array(12e6).sort()` halts `HeapExhausted` (288 MB of `Slot` scratch for a 12 MB
  array) where Node sorts it.
- **Evidence:** confirmed by probe (`zz_audit_vm_memory_2.rs` test b, `$P/probe2.out`;
  `ironhorse-xst` probes):

  | Case | Wall | Computrons |
  |---|---:|---:|
  | `Uint8Array(n).fill(7)`, n = 1M / 4M / 16M | 10–14 ms / 115–158 ms / 2.0–2.3 s | 53 / 99 / 282 (allocation only) |
  | same, n = 1e8 (`meter.out`, release) | 90.6 s | 1,563 |
  | `Uint8Array(n).reverse()`, n = 1M / 4M | 32–41 ms / 204–217 ms | 61 / 107 |
  | reversed `Float64Array(n).sort()` incl. fill loop, n = 5k / 10k / 20k | 55 ms / 191–217 ms / 0.69–0.95 s | 118,803 / 237,554 / 475,055 |
  | 1M writes to byte 0 vs byte 199,999,999 of a 200 MB `Uint8Array` | 1.36 s vs 5.13 s | equal |
  | `new Uint8Array(8e6).sort()` / `(12e6)` | 1.5 s, 202 MB RSS / `HeapExhausted` | — |

  Baseline interpreted code runs at 35 ns per computron (`$P/probe3.out`); `fill` reaches
  7,000,000 ns per computron at 16M.
- **Recommendation:** Add `ChunkArena::slice_mut_range(off, start, len)` that dirties only the
  touched extents and use it at all 17 `slice_mut` call sites.
  Charge `TYPED_ARRAY_ELEMENT_METERING × count` with `charge_and_check` before bulk loops
  (in strides for very long ones).
  Sort numeric elements in a typed `Vec<f64>`/`Vec<i64>`/`Vec<u64>` with Rust's stable
  `sort_by` and a total-order comparator; route the comparator path through the existing
  merge sort (`natives/array.rs:4284`); charge n·log₂n.
- **Confidence:** confirmed by probe.

### MEM-5 — WeakMap/WeakSet `delete` and `FinalizationRegistry.prototype.unregister` are O(n) per call and charged O(1)

- **Lens(es):** 1 (meter bypass), 4.
- **Proposed severity:** high.
- **Location:** `rust/engine/ironhorse-vm/src/bulk.rs:791-808`;
  `interp/natives/weak.rs:207-221`.
- **Excerpt:**
  ```rust
  if self.kind.is_weak() {
      if at < index.keys.len() {
          index.keys.remove(at);
          for position in index.positions.values_mut().chain(…) {
              if *position > at { *position -= 1; }
          }
      }
      self.entries.remove(at);
  ```
  ```rust
  registry.cells.retain(|cell| cell.token.is_null() || cell.token != token);
  ```
- **Mechanism:** A weak entry is removed physically: two `Vec::remove` shifts and a walk of
  every index position, all O(entries), per delete.
  `unregister` walks every cell of the registry with no per-cell charge.
  Map and Set tombstone and compact amortized, so they are linear.
- **Scenario:** A vat that uses a WeakMap as a side table and deletes its entries does
  quadratic work.
  With 1M entries (inside the ceiling at 96 charged bytes each) deleting them all is about
  5×10¹¹ element moves for about 80M computrons.
- **Evidence:** confirmed by probe (`zz_audit_vm_memory_1.rs` test d, `$P/dfgi.out`; `$P/finreg_unregister*.js`):

  | Delete all n keys, front first | n = 10k | 20k | 40k |
  |---|---:|---:|---:|
  | WeakMap: wall / computrons | 358 ms / 712,144 | 1.02 s / 1,473,047 | 5.45 s / 3,141,338 |
  | Map: wall / computrons | 36 ms / 712,150 | 73 ms / 1,473,059 | 148 ms / 3,141,362 |

  ns per computron: WeakMap 503 → 693 → 1,736; Map 51 → 49 → 47.
  5,000 `unregister(tok)` calls on a registry with 1M cells: 9.64 s against 0.99 s for the
  same script with a property store in place of the call.
- **Recommendation:** Weak collections have no observable order, so `swap_remove` the entry and
  repair the one moved index position (O(1)); or reuse the Map tombstone path.
  Index finalization cells by token, or charge per cell visited.
- **Confidence:** confirmed by probe.

### MEM-6 — Per-object overhead lives in SipHash side tables: promises cost ~1.5 KB, closures ~430 B, array items 56 B

- **Lens(es):** 4, 6(c).
- **Proposed severity:** medium.
- **Location:** `rust/engine/ironhorse-vm/src/interp/state.rs` (46 `HashMap<SlotIndex, _>`
  tables, e.g. `:536`, `:566`, `:582`, `:2564`); `bulk.rs:175` (`items: BTreeMap<u32, Slot>`);
  `interp.rs:843-905` (`FuncInfo`, with `name: String` at `:880` beside `name_chunk`);
  `interp.rs:1567-1576` (`ErrorInfo.frames: Vec<String>`); `interp.rs:2313-2336`
  (`SavedFrame` with four `Vec`s).
- **Excerpt:**
  ```rust
  functions: Tracked<std::collections::HashMap<crate::value::SlotIndex, FuncInfo>>,
  ...
  items: std::collections::BTreeMap<u32, Slot>,
  ```
- **Mechanism:** Every exotic or function object keeps its internal state in one or more std
  `HashMap`s keyed by a dense `u32` with SipHash, at hashbrown's 1.14–2.3× bucket slack.
  Arrays keep items in a `BTreeMap` whose sequential-append nodes stay about half full.
  Values outside the arena are full 24-byte `Slot`s.
  The collector does one `HashMap::get` per map-shaped table for every marked slot.
- **Scenario:** Promise- and closure-heavy vat code (the Endo norm) uses 4–30× Node's memory
  and 3–4× XS's estimated footprint, and hits the slot ceiling's real memory far earlier than
  the documented 50 bytes per slot.
- **Evidence:** confirmed by probe (counting global allocator, release; `$P/probe1_ab.out`,
  `$P/probe2.out`; Node heapUsed from `$P/node_units.js`).
  IronHorse figures include a 55.6 B array item where the unit was pushed into an array;
  "net" subtracts it.
  XS estimates count `txSlot`s at 32 B (not measured; no XS binary is available here).

  | Unit | IH heap B (net) | IH slots | Node heapUsed B | XS estimate |
  |---|---:|---:|---:|---|
  | empty object | 89.2 (33.6) | 1 | 65 | 32 |
  | object, 4 properties | 191.8 (136) | 5 | 65 | 160 |
  | short string `'s'+i` | 84.2 (28.6) | 0 | 33 | ~24 |
  | arrow closure over `let` | 489.7 (434) | 6 | 105 | ~200 |
  | IIFE closure (before GC) | 1,294 | 14 | — | — |
  | pending `new Promise` | 1,578 (1,522) | 9 | 57 | ~400 |
  | `p.then()` on a pending promise | 932 | 3 | — | ~380 |
  | suspended async call | 1,571 (1,515) | 4 | — | — |
  | suspended generator | 1,094 (1,039) | 10 | — | — |
  | `f.bind(null)` | 475 (420) | 1 | 121 | — |
  | `new Error('x')` | 373 (318) | 2 | 713 | — |
  | regexp literal | 592 (536) | 2 | 65 | — |
  | class instance, 2 private fields | 203.8 (148) | 1 | 49 | ~96 |
  | Map entry, int keys | 127.1 | 0 | 37 | ~72 |
  | array item, small int (1M) | 55.6 | 0 | 6.8 | 32 |

  Boot is small: `Interp::new` allocates 327 KB, 366 KB after linking a tiny program with
  1,100 live slots.
- **Recommendation:** (a) Replace `BTreeMap<u32, Slot>` with a dense vector of 16-byte values
  plus a hole sentinel and a sparse fallback (55.6 → ~16 B per item, O(1) indexing).
  (b) Give each exotic kind a dense `Vec<Row>` and store the row index in the slot (or one
  per-slot `u32`), replacing SipHash lookups on calls and in the collector; at minimum use an
  identity/Fx hasher for `SlotIndex` keys.
  (c) Drop `FuncInfo.name` (the chunk already holds it), store `ErrorInfo.frames` as one
  chunk, and make `SavedFrame` one boxed slice.
  (d) Use a 16-byte value type for out-of-arena values.
  Report side-table bytes in the footprint instrument (`benches/README.md:229-251` compares
  slot accounting only).
- **Confidence:** confirmed by probe (IronHorse and Node measured; XS column estimated).

### MEM-7 — Memory is never returned: arenas, free list and side-table maps keep their peak capacity after collection

- **Lens(es):** 4, 3.
- **Proposed severity:** medium.
- **Location:** `rust/engine/ironhorse-vm/src/value.rs:2818` (`truncate`, no shrink),
  `value.rs:843-868` (`slots`, `free`, `free_marks`, `marks` grow only),
  `interp/gc.rs:110-133` (no shrink of any side table); `value.rs:2846` (`compact`, which
  would rebuild an exact-size vector, is test-only);
  `interp/natives/buffer.rs:2505-2508` (zero-filled copy).
- **Excerpt:**
  ```rust
  self.bytes_mut().truncate(new_len);
  ```
  ```rust
  let mut bytes = Self::reserved_vec(byte_length as usize)?;
  bytes.resize(byte_length as usize, 0);
  let data = self.chunks.alloc(&bytes);
  ```
- **Mechanism:** Only collection entry lists and segments ever call `shrink_to`
  (`bulk.rs:857`, `side_ledger.rs:77`, `:112`).
  The slot vector cannot shrink below its highest live index, but nothing tries; the chunk
  vector is truncated without `shrink_to`; `HashMap`s keep their bucket arrays after the
  sweep removes rows; the free list holds 4 bytes per free slot forever.
  Separately, an `ArrayBuffer` is built as a zeroed host `Vec` and then copied into the arena
  (2× transient), and arena appends double past the ceiling.
- **Scenario:** A long-lived native worker's RSS equals the peak of any crank it ever ran;
  Endo's ephemeral machine wrapper reuses one machine across evaluations
  (`ARCHITECTURE.md:120-122`), so one large evaluation pins its memory for the next.
- **Evidence:** confirmed by probe (`zz_audit_vm_memory_1.rs` test g, `$P/dfgi.out`;
  `zz_audit_vm_memory_2.rs` test e, `$P/probe2.out`; `$P/ta_write_pos_0.js`):

  | Churn, then `collect_garbage()` | Boot | After run | After GC | Live slots after |
  |---|---:|---:|---:|---:|
  | 400k `{a: i}` | 0.36 MB | 27.6 MB | 31.8 MB | 1,101 |
  | 50k 1 KB strings (chunk length 100.7 MB → 19 KB) | — | 184.8 MB | 184.8 MB | 1,103 |
  | 150k closures | 0.3 MiB | 72.8 MiB | 75.6 MiB | 1,102 |
  | 100k promises | 0.3 MiB | 117.7 MiB | 121.7 MiB | 1,102 |

  Heap grows during the GC itself (+3–4 MB: free list and the swept `HashSet`).
  A 200 MB `Uint8Array` peaks at 397 MB RSS.
- **Recommendation:** After collection, `shrink_to` the chunk vector and every side-table map
  whose length fell below a quarter of its capacity; allocate from the lowest free index (or
  keep the free list as the existing bitmap plus a cursor) so trailing free records can be
  truncated; add `ChunkArena::alloc_zeroed`; cap amortized growth at the ceiling.
- **Confidence:** confirmed by probe.

### MEM-8 — Extent-local compaction never coalesces adjacent dead crossing blocks, and the full compactor is dead code

- **Lens(es):** 4, 2, 3.
- **Proposed severity:** low.
- **Location:** `rust/engine/ironhorse-vm/src/value.rs:2711-2838` (`compact_local`), `value.rs:2846-2943`
  (`compact`, referenced only by `value.rs:3429` and three test files), `gc.rs:233`.
- **Excerpt:**
  ```rust
  } else {
      if marked {
          new_len = end;
      } else {
          edits.push(ChunkEdit::Free { header, span: end - header });
      }
  ```
- **Mechanism:** Each dead block that crosses an extent boundary becomes its own free marker;
  neighbouring markers are never merged, now or at later collections.
  Blocks inside an extent are packed only when ≥25% of the region is dead.
  The free index is best-fit over individual markers.
  Interior holes count against the chunk ceiling (`footprint_fits` uses the logical length).
- **Scenario:** Programs that alternate large strings or buffers of growing size leave runs of
  adjacent holes that no later request can use; the logical length, and the ceiling margin it
  consumes, only shrinks at the tail.
- **Evidence:** confirmed by arena-level probe (`zz_audit_vm_memory_1.rs` test f, `$P/dfgi.out`):
  eight 100 KiB blocks, blocks 1–2 and 5–6 dead, ceiling pinned to the arena length:
  `can_alloc_150K_in_hole=false`, `can_alloc_90K_in_hole=true`; a 20%-dead extent of small
  blocks is not compacted (`small_20pct_dead before=60240 after=60240`).
  Not reproduced from guest code, because guest code cannot trigger a collection.
- **Recommendation:** Merge adjacent free markers when writing them (and when rebuilding the
  index); run the existing full `compact` when the hole total exceeds a threshold, or delete
  it.
- **Confidence:** confirmed at arena level; guest-level impact is medium confidence.

### MEM-9 — The collector's per-row knowledge is written three times by hand: slot walk, chunk walk and root walk must stay in sync

- **Lens(es):** 2, 1 (latent rooting hole).
- **Proposed severity:** low.
- **Location:** `rust/engine/ironhorse-vm/src/interp/gc_tables.rs:153-385` (`gc_chunk!`),
  `gc_tables.rs:416-683` (`gc_slot_row!`), `interp/roots.rs:9-237` (`gc_root!`).
- **Excerpt:** the nine `FromAsyncData` slots appear at `roots.rs:202-216`,
  `gc_tables.rs:623-636` and `gc_tables.rs:220-237`; the `PromiseJob` payloads at
  `roots.rs:169-236` and `gc_tables.rs:324-356`; `CallerState` at `roots.rs:98-112` and
  `gc_tables.rs:357-370`; reaction slots at `gc_tables.rs:207-219` and `:597-604`.
- **Mechanism:** Each Rust row type that stores `Slot`s lists its fields once for marking
  (`each_ref_slot`) and again for compaction (`chunk_ref`), sometimes a third time for roots.
  The registry tests compare token strings, not coverage of struct fields, so a field added to
  a row and to one walk compiles and passes until a chunk offset dangles or a slot is swept
  while referenced.
- **Scenario:** A new `Slot` field on, e.g., `PromiseReaction` is traced but not chunk-walked:
  a string it holds is compacted away and the offset dangles.
- **Evidence:** static (counted walk sites above; 15 row policies × 2 walks).
- **Recommendation:** Give each row type one `for_each_slot_mut(&mut self, f)` and derive
  edges, chunk rewrites and roots from it.
- **Confidence:** high (static).

## Duplication inventory

| Family | Copies (path:line) | Size | Note |
|---|---|---|---|
| Chunk-cost formula `round_up_8(n) + 16` × raw | `ironhorse-meter/src/lib.rs:313-318` (`chunk_cost`); `ironhorse-vm/src/interp/admission.rs:104-112` (`charge_chunk_work`, checked); `interp/property/indexed.rs:124-129`; `interp/natives/array.rs:4234-4240`; `interp/natives/json.rs:1184-1188` (subtracts the header back out) | 5 copies, ~6 lines each | Should all call `chunk_cost` |
| Sorting | `interp/natives/array.rs:4284-4330` (stable merge sort, fallible); `interp/natives/buffer.rs:1333-1393` (stable insertion sort, fallible) | 47 + 62 lines | Same contract, different complexity (MEM-4) |
| Chunk compaction | `value.rs:2711-2838` (`compact_local`, production); `value.rs:2846-2943` (`compact`, tests only) | 128 + 98 lines | MEM-8 |
| Per-row GC walks | `gc_tables.rs:153-385` (chunk), `:416-683` (slots), `roots.rs:9-237` (roots) | ~730 lines | MEM-9 |
| Declared widths | `admission.rs:26-53` (`scratch_element!`); `side_storage.rs:44-61`; `ironhorse-meter/src/lib.rs:63` (`ARRAY_ITEM_BYTES = 32` weight) | 3 tables | Two constants named `ARRAY_ITEM_BYTES` with different meanings |
| Full vs partial prune | `gc_tables.rs:98-135` generates `prune_swept`/`prune_late`/`prune_dead_tables` from one roster | — | Not duplicated (good): one roster, two strengths |
| Typed-array element store | `buffer.rs:1944-1963` (`typed_array_element_set`) and `buffer.rs:2077-2140` (`ta_indexed_element_set`) | 20 + 64 lines | Comment says they "mirror" each other's coercion |

## Skipped features and refusals inventory

| Site | What is refused or skipped | Spec / XS status | Should support? | Effort |
|---|---|---|---|---|
| `RECLAMATION.md:63`, `interp/gc.rs:6-14` | Collection inside a crank | XS collects on allocation pressure | Yes (MEM-1) | High: deterministic safepoint trigger |
| `value.rs:2846` | Full chunk compaction in production | XS compacts chunks every GC | Yes, by threshold (MEM-8) | Low (code exists) |
| `interp/gc.rs:316-318` (doc) | Partial collection never reclaims chunks or exact weak liveness | Design | Documented | — |
| `gc_tables.rs:725` | Per-owner index for pair-keyed tables ("preserve their filtered scan") | — | Yes (MEM-2) | Medium |
| `gc_tables.rs:874` | Symbol-key ephemeron stays O(capacity) per round | — | Yes (MEM-2) | Low |
| `interp/gc.rs:276-278` | Code-segment compaction skipped while a crank is halted | Design | Documented | — |
| `RECLAMATION.md:62` | "Other side tables are still not charged" | Ceilings meant to bound memory | Yes (MEM-3) | Medium |
| `interp/natives/string.rs:741-745` | `padStart`/`padEnd` past 2²⁴ units → `Refused`, though `repeat` of 2×10⁷ units succeeds | ES allows up to 2⁵³−1 | Yes: use the ceiling | Low |
| `interp/natives/buffer.rs:2132-2133` | `Halt::NotImplemented("typed-array-set:bigint")` | Unreachable: BigInt kinds return earlier (`:2084-2094`) | Reclassify as `EngineInvariant` | Trivial |

## Memory and performance opportunities

| Site | Waste | Magnitude | Fix |
|---|---|---|---|
| `value.rs:565-631` `Slot` | `Payload`'s own 8-byte tag+padding duplicates `kind` | 8 of 24 B per slot (33%); ~16% of the 50 B/slot wasm figure | 16-byte slot: `kind` as the tag, 8-byte raw value |
| `value.rs:863-868`, `property_index.rs:31-35` | Four per-slot `Vec<bool>` | 4 B per slot | Bitsets: 0.5 B per slot |
| `value.rs:844` `free: Vec<u32>` | 4 B per free slot, never shrinks | 3.2 MB after 800k reclaimed (`$P/dfgi.out`) | Use `free_marks` + cursor, or segment |
| `bulk.rs:175` array items | `BTreeMap<u32, Slot>` half-full nodes | 55.6 B/item vs 6.8 Node, 32 XS | Dense vector of 16-byte values (MEM-6) |
| 46 SipHash `HashMap<SlotIndex, _>` | Hash + slack per object; ~20 lookups per marked slot in GC | 96 ns per live slot marked (17,104 slots in 1.64 ms) | Dense per-kind rows, or identity hasher |
| `interp.rs:843` `FuncInfo.name: String` | Name kept as a Rust `String`, a chunk and a property | 24 B + allocation per named function | Keep only `name_chunk` |
| `interp.rs:2313` `SavedFrame` | Four `Vec`s per suspended frame | ~1.5 KB per suspended async call | One boxed slice |
| `interp.rs:1567` `ErrorInfo` | `frames: Vec<String>`, message copied as `Vec<u16>` | part of 318 B per Error | One chunk |
| `bulk.rs:476` `CollEntry` | `seq: u64` + two 24-byte `Slot`s + index `Vec` + `HashMap` | 127 B per Map entry vs 37 Node | 16-byte values; derive seq |
| `buffer.rs:2505-2508` | Zeroed temp `Vec`, then copy | 2× transient (397 MB RSS for 200 MB) | `ChunkArena::alloc_zeroed` |
| `value.rs:2577` | Amortized doubling past the ceiling | up to 2× ceiling (WASM-MEMORY: 3.27 B per chunk byte at 160 MiB) | Cap growth at the ceiling |
| `value.rs:2818`, every side map | No shrink after GC | 75–185 MB retained (MEM-7) | `shrink_to` after collection |
| `gc.rs:186` | Fresh `Vec` per popped slot in the mark loop | one allocation per marked slot with edges | Reuse one buffer |
| `interp/gc.rs:121` | `HashSet` of every swept index | ~16 MB temporary for 800k swept | Use the `free_marks` bitmap |
| `buffer.rs:1706-1707` | Two `to_vec` per swap in TypedArray reverse | 2 allocations per element pair | `slice::swap` |
| `gc_tables.rs:723-740`, `:40-47` | Pair-table scans per marked/swept slot | O(n²) (MEM-2) | Owner index |

## Ontology notes

1. **"Slot" names four things.**
   (a) The arena record `Slot` (`value.rs:620`), counted by `slots_reclaimed`/`live_count`.
   (b) The JS value representation outside the arena: `BoundData.args: Vec<Slot>`,
   `CollEntry.kv: Option<(Slot, Slot)>`, the value stack (`STACK_SLOT_COUNT`,
   `interp.rs:328`), where `next`/`id` are dead weight and `flag` is reused as array-item
   attributes (`bulk.rs:213-255`).
   (c) ECMA-262 internal slots (`ProxyData` doc, `interp.rs:685-692`).
   (d) XS's `txSlot` accounting unit (`xs_accounted_byte_size`, `value.rs:1458`).
   The type does not distinguish a heap record from a value, which is why a "value" carries
   GC-edge fields (`each_ref_slot` follows `next`) wherever it is stored.
2. **`capacity` is a homonym inside `SlotArena`.**
   `SlotArena::capacity()` (`value.rs:1358`) is the count of records ever allocated
   (`Vec::len`), while `resident_byte_size` (`value.rs:1481`) reads `slots.capacity()`
   (`Vec::capacity`).
   `RECLAMATION.md` calls the first "slot addresses".
   `ChunkArena::byte_size()` is the logical address extent including holes, not resident
   bytes, while `SlotArena::resident_byte_size()` is resident; and that "resident" figure
   omits the `PropertyIndex` vectors and maps held inside the same struct (`value.rs:832`).
3. **"Charge" means two currencies.**
   Meter charges (`charge_and_check`, `charge_builtin_work`, and `charge_chunk_work`, which
   charges *computrons* for chunk bytes) versus ceiling charges (`side_charge`,
   `reserve_side`, `ScratchElement::CHARGE`, "charged against the chunk ceiling").
   Two constants share the name `ARRAY_ITEM_BYTES`: the meter weight in
   `ironhorse-meter/src/lib.rs:63` (XS's 32-byte item `txSlot`) and the ceiling width
   `side_storage::ARRAY_ITEM_BYTES = width::<(u32, Slot)>()` (`side_storage.rs:45`).
   Both are 32 by coincidence; the resident cost is 55.6.
   `CHUNK_HEADER_BYTES = 16` (`ironhorse-meter/src/lib.rs:130`, XS's modeled header) and
   `value::CHUNK_HEADER = 4` (`value.rs:1717`, the real header) are both "the chunk header".
4. **"Collection" means garbage collection and Map/Set/WeakMap/WeakSet** within the same GC
   module: `gc_chunk!(…, collection)`, `gc_weak!(…, collection)`, `CollectionData`,
   `Interp::collections`, next to `collect_garbage` and `GcAdmissionError`.
5. **Two tags for one classification.**
   `Kind` and the `Payload` discriminant overlap; nothing enforces their agreement
   (`Slot::of(Kind::String, Payload::Integer(_))` is constructible), so code matches both
   (`interp/function.rs:819-820`, `gc_tables.rs:1016`).
   `Kind::Property` is documented as never appearing in a running heap (`value.rs:766-771`):
   an enum variant that is a decode tag, not a kind.
6. **The memory-limit outcome taxonomy is not disjoint.**
   `HeapExhausted` is documented as "the configured ceiling refused" (`value.rs:79-85`) but also
   reports a scratch-length arithmetic overflow (`admission.rs:204`, `:268`) and the regexp
   match-state count (T262-7).
   For the same condition, "a string result is too large": `'x'.padEnd(2e7)` →
   `Refused("String.prototype.pad:result-too-large")`, `'x'.repeat(2e7)` succeeds,
   `'x'.repeat(2e8)` → `HeapExhausted`, `'x'.repeat(2**31)` → catchable `RangeError`
   (`$P/pad_2e7.js`, `repeat_2e7.js`, `repeat_2e8.js`, `repeat_2e31.js`).
   Chunk address-space exhaustion is a panic (`value.rs:2515-2518`).
   An unreachable invariant arm is labelled `NotImplemented` (`buffer.rs:2133`).
7. **"Cost table" has two identities.**
   `COST_TABLE_VERSION` changes for weights *and* charging points; the pinned digest covers
   weights and `DEFAULT_KEYS` only, so `ironhorse-meter-3`, `-4` and `-5` share one digest
   (`ironhorse-meter/src/releases.rs`).
   The crate re-exported as `cost_table` (`ironhorse-vm/src/lib.rs:49`) also hosts the XS
   default-key list and the snapshot SHA-256 (`ironhorse-vm/src/sha256.rs:2` re-exports
   `cost_table::sha256`).
8. **Docs and code disagree.**
   `WASM-MEMORY.md:34-36` ("the footprint is a linear function of the ceilings … 50 per slot")
   versus MEM-3/MEM-6 (up to 407 B per slot of ceiling for suspended async calls, unbounded
   for bound arguments).
   `meter.rs:54-56` documents `STRING_METERING` as "one code unit of string concatenation",
   but concatenation never charges it (only `natives/uri.rs` and `natives/annex_b.rs` use it),
   and `cost.rs:313-318` models `ADD` as `StringLength` work.
   `benches/README.md:229-251` reports "heap footprint" from slot accounting alone, so the
   0.2× XS figure excludes the chunk arena and every side table.

## Leads that did not survive

- HashMap iteration order reaching guest-visible or persisted state through the collector:
  roots are sorted and deduplicated (`interp/gc.rs:29-35`), live chunk offsets are sorted
  (`value.rs:1876-1878`), finalization callbacks run in owner order (`natives/weak.rs:257`),
  reaction arenas use `BTreeSet`.
- A per-machine leak on drop: the 63.6 KB left after dropping an `Interp` is one-time process
  state (1, 10 and 50 machines all leave 63.6 KB; `zz_audit_vm_memory_2.rs` test f).
- Sweep cost on a large empty arena: 1.55 ms for 801,101 records with nothing to reclaim.
- Map/Set delete: tombstones compact amortized; 40k front deletes take 148 ms, linear.
- Meter overflow: `charge_and_check` fails closed on `checked_add` (`meter.rs:276-282`); the
  unchecked `tick_*` adds need 2⁴⁸ computrons.
- `meter.out` build mode: release; key cases re-measured in release (`$P/probe3.out`).
- Map entry ceiling charge (96 B by capacity class) is close to the resident cost (127 B).
- Boot footprint and slot size: 327 KB per new machine and a 24-byte slot are both smaller
  than XS.
- Chunk allocation charged one raw unit per byte (200 MB in 0.36 s for 3,079 computrons): XS
  parity, a memset, and bounded per crank by the ceiling.
- The generated CharacterClassEscapes test (`$P/t262.js`) halting `HeapExhausted` is the regexp
  state cap (T262-7), not garbage: the same test with a join-based `buildString` still halts
  at 25 MB peak.
- Weak semantics at the boundary: `WeakRef` targets are nulled before the sweep, registries
  with cells are roots as in XS, and `KeepDuringJobs` is trivially satisfied because nothing
  collects inside a crank.
- String concatenation, `JSON.stringify` and naive `indexOf` charging far below their work
  (`doubling_concat_25`: 252,588 ns per computron; `indexOf` 1e6×1e3: 6.1 s for 265,555
  computrons, `$P/probe3.out`) are real but belong to the natives-values region (NVAL-1,
  NVAL-3); the concatenation cases are additionally bounded per crank by MEM-1's ceiling.
