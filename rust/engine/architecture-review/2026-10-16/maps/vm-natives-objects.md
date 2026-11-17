# Map: VM object built-ins (native dispatcher, Array, Map/Set/Weak*, ArrayBuffer/TypedArray/DataView/Atomics, WeakRef/FinalizationRegistry, DisposableStack, Reflect, Annex B)

Reviewed commit `61cd656cb`.

## Scope

Finding **Location** lines use repo-relative paths. Elsewhere, bare file names such as `dispatch.rs` are relative to `rust/engine/ironhorse-vm/src/interp/natives/`, and `bulk.rs`, `side_storage.rs`, `interp.rs`, `interp/...` are relative to `rust/engine/ironhorse-vm/src/`.

| File | Lines |
|---|---|
| `dispatch.rs` | 7748 |
| `array.rs` | 4713 |
| `collection.rs` | 3152 |
| `buffer.rs` | 2520 |
| `weak.rs` | 277 |
| `annex_b.rs` | 278 |
| `resource.rs` | 269 |
| `reflect.rs` | 247 |
| `mod.rs` | 23 |
| **total** | **19227** |

Neighbours read because the region's behaviour depends on them: `ironhorse-vm/src/bulk.rs` (ArrayData/CollectionData, 1298 lines), `ironhorse-vm/src/side_storage.rs` (134), `interp/side_ledger.rs`, `interp/property/keys.rs:1-140`, `interp/dispatch/property_read.rs:180-225`, `interp/invoke.rs:300-500`, `interp/native_ids.rs` (parts), `interp/boot.rs:740-770,2340-2372`, `interp.rs:955-1140,3295-3400`, `value.rs:132-153`, `interp/gc.rs:100-130`.

## What was read

- `dispatch.rs`: I read the dispatcher closely: `call_native_inner` (12-109) and `call_native_method_inner` (2144-2627). I also read these families closely: the buffer ctor (627-1222), `native_ctor_core` arms for DisposableStack, Array, Map, Set, WeakMap, WeakSet, WeakRef and FinalizationRegistry (1738-1980), `native_method_array_callback` (3491-3879), `native_method_buffer` (3886-4154), `native_method_array` (4161-5180, plus a grep of the rest), and `native_method_collection` (5633-5767). The NotImplemented sites were found by grep.
- `array.rs`: full read of 1540-2380 (dense gates, `*_fast_safe`, generic key/has/get), 2465-2660 (generic push/pop/shift/unshift), 2995-3016, 3189-3215 and 4230-4712 (sort, change-by-copy, `flat_into`). The remaining parts were grep-driven (caps and refusals).
- `collection.rs`: full read of 1-440 (methods and constructor population) and 2040-3152 (forEach, the Set methods, getOrInsert, groupBy, key canonicalization, table resize). The iterator-helper block was read by grep only.
- `buffer.rs`: full read of 1-660 and 773-2520.
- `weak.rs`, `reflect.rs`, `resource.rs`, `annex_b.rs` and `mod.rs`: full read.
- `bulk.rs`: full read.
- `side_storage.rs`: full read.
- test262 expectations (`ironhorse-262/expectations/whole-tree/*`): grep for my built-ins.
- **Probes.** I ran 27 JS probe files and one Rust probe. Their sources are under `../probes/vm-natives-objects/`, and the Rust probe source is saved there as `zz_audit_vm-natives-objects_1.rs`; the temporary test file in the repo was deleted.

## What was not read

- `dispatch.rs`: the Intl families (117-418, 2634-3388), Temporal (419-620, 3388-3490), Promise (1229-1355, 5774-5939), `native_method_iterator` (5455-5633), and the RegExp, String, Object and Function families (5939-7748). Most of `native_ctor_core` (1355-1738, 1980-2140) was also not read. These were not reviewed for correctness; the 1M-cap sites in them were only grepped.
- `array.rs`: `Array.from` / `fromAsync` / array iterator (1-1540) was grep only. The generic reverse, splice, copyWithin, flat, concat, slice, map/filter and readonly bodies (2660-3190 and 3215-4230) were only skimmed.
- `collection.rs`: the iterator helpers (623-2040) were grep only.
- `buffer.rs`: 660-773 (relative index, `typed_array_accessor`, toLocaleString) was skimmed.
- `base64.rs` (Uint8Array base64/hex) is out of the assigned file list. It was only smoke-probed (results correct).
- The array element `[[Set]]` path in `property.rs` was not reviewed (another region). It was measured once: about 2.4 µs per `a[i]=x` on an existing element, against 0.35 µs for a TypedArray write (p13). That is flagged here for the property-model reviewer.

## Architecture as built

**Dispatch.** Native constructors go through `call_native_inner` (`dispatch.rs:12`). It matches `Native`, a Copy enum, into five `#[inline(never)]` families (intl, temporal, buffer, promise, core). Prototype and static methods go through `call_native_method_inner` (`dispatch.rs:2144`). That function is entered from `invoke.rs:340 call_native_method`, which charges `HEAVY_FRAME_COST` against `NATIVE_DEPTH_LIMIT`.

- **Routing.** The method dispatcher is a two-level match. A routing list (2191-2621, about 430 lines, no wildcard, so the compiler checks it is exhaustive) sends each of the ~396 `NativeMethod` variants (`native_ids.rs:55`) to one family function. The family then matches the method again and ends in `_ => unreachable!`.
- **Frame layout.** `stack[base]` is `this`, `stack[base+1]` is the callee, and argument i is at `stack[base+4+i]`. A missing argument reads `undefined`.
- **Per-call work.**
  - `cost.on_builtin(m)` records a histogram entry (a no-op when the feature is off).
  - For any call whose arg0 is a Reference there is a `proxies` HashMap probe. It runs *before* the cheap `is_object_static_on_operand(m)` filter (2180-2184).
  - The result is written with `truncate(base)` plus `push`.
  - In general no argument vector is built. A few methods do collect one into a `Vec`: dense push (4190), the generic push and unshift, `typed_array_static` (`buffer.rs:823`), and change-by-copy (`array.rs:4346`).
- **Instance state.** Exotic state lives in per-kind side tables keyed by the instance's `SlotIndex`: `arrays`, `collections`, `typed_arrays`, `array_buffers`, `data_views`, `weak_refs`, `finalization_registries` and `disposable_stacks` (`state.rs:1705-2099`). All of them are std `HashMap` or `HashSet` with SipHash. A brand check is a `contains_key`. Element-wise loops re-index `self.arrays[&inst]` per element, which costs one SipHash lookup each time.

**Array.** The state is `ArrayData { length: u32, items: BTreeMap<u32, Slot>, attributed: u32 }` (`bulk.rs:173-185`); a `Slot` is 24 B.

- **No contiguous storage.** Every array, dense or sparse, is a B-tree. Element access is O(log n).
- **Memory cost.** Measured host cost is **55.6 B/item**, but the chunk ceiling is charged `ARRAY_ITEM_BYTES = 32` (`side_storage.rs:45`). The probe gives BYTES `array_int_items_262144: host/unit=55.6 side-charged/unit=32.0`.
- **Dense fast paths.** These live in `dispatch.rs:3491-5455` (about 1680 lines). They are gated by `dense_array_this` (`items.len()==length && !has_attributed_items`, `array.rs:1552-1577`) plus the `*_fast_safe` predicates (`array.rs:1579-2042`). They carry XS-calibrated meter constants.
- **Generic MOP paths.** Everything else, including any holey array, takes the generic MOP algorithms in `array.rs:2044-4600`. Reads use the non-minting `array_generic_index_read_key` (2244). Writes use the **minting** `array_generic_index_id` (2056) — see NOBJ-1.
- **Shift, unshift and splice.** These rebuild the whole BTreeMap on every call (`dispatch.rs:4684-4696, 4740-4750, 5001-5046`).
- **Sort.** `array_sort` (`array.rs:4497`) always takes the generic path. It is a stable bottom-up merge sort (4284), and the default comparator re-stringifies both operands on every comparison (4276-4278).

**Map/Set/WeakMap/WeakSet.** These use `CollectionData` (`bulk.rs:523`):

- **Storage.** Entries are an insertion-ordered `Vec<CollEntry{seq,kv}>`. A lazily built `RefCell` index maps `CollKey` to a position, with a `duplicates` side map.
- **Key canonicalization.** Keys are canonicalized by `coll_index_key` (`collection.rs:3068`): Integer and Number values are unified through f64 bits, -0 becomes 0, and NaN is canonicalized. String and BigInt keys are indexed by a process-keyed content hash and confirmed with `strict_equal`. HashMap order is never observable.
- **Delete.** On Map/Set a delete leaves a tombstone, and the list compacts when tombstones outnumber live entries. Weak kinds instead remove the entry physically (`bulk.rs:791-808`), which costs O(n) per delete.
- **Cursors and clear.** Cursors carry sequence numbers. `clear` bumps a generation, so live cursors dead-end (XS purge semantics).
- **Memory cost.** Host cost is 122 B/entry against 96 B charged.
- **Set methods.** All seven Set methods (`collection.rs:2355`) build results in a `Vec<Slot>` with linear `key_list_contains` and `retain`.
- **groupBy.** `Map.groupBy` and `Object.groupBy` (2673) use linear bucket search.
- **getOrInsert.** The upsert proposal methods are present.

**ArrayBuffer and TypedArray.** `ArrayBufferData { data: ChunkOffset, length: u32, max_length: Option<u32> }` (`interp.rs:992`). Detachment is recorded twice, as `detached_buffers` set membership *and* `length=0`. A SharedArrayBuffer is an ArrayBuffer that is also a member of `shared_buffers`.

- **TypedArray state.** `TypedArrayData { kind: u8, buffer, offset, array_length: Option<u32>, resizable_buffer }`. The live length is derived (`buffer.rs:31-58`). `kind` indexes `TYPED_ARRAY_TYPES` (`interp.rs:1021`), with 12 rows including Float16 appended last. Element encode and decode go through `decode_element_le` and `encode_element_le` (`interp.rs:3305,3344`); the encoder returns a heap `Vec<u8>`.
- **One generic implementation.** TypedArray families are generic over `kind`, with no per-type copy-paste.
- **Limits and ops.** Byte length is capped at `0x7FFF_FFFF` (XS). Resize and grow are supported. `transfer` and `resize` always allocate a fresh chunk and copy. Atomics read-modify-write is implemented single-agent; `wait`, `notify` and `waitAsync` halt with `Refused`. Float16Array, `Math.f16round`, DataView `get/setFloat16` and Uint8Array base64/hex are present.
- **TypedArray sort.** Sort is an insertion sort (`buffer.rs:1333-1393`).

**WeakRef and FinalizationRegistry.** `WeakRefData{target}` and `FinalizationRegistryData{callback, cells: Vec<FinalizationCell{target, holdings: Slot, token}>, changed}` (`interp.rs:955`, `weak.rs`).

- The GC is quiescent-only (`gc.rs:110 admit_collection`); it nulls dead targets and tokens.
- Cleanup runs at the job boundary. Registries are visited in sorted index order (`weak.rs:244-276`); cells are removed with `Vec::remove` after a `position` scan.
- Cells are not charged to any ceiling.
- Symbols are refused as targets and tokens; the refusal is pinned to the XS oracle build.

**DisposableStack and AsyncDisposableStack.** The state is `DisposableStackData{disposed, asynchronous, records}`. All methods live in `resource.rs`. `dispose` and `disposeAsync` pop the records and call each one synchronously. The async form settles a promise afterwards and never awaits (NOBJ-8). `disposed` is not a prototype accessor. It is answered by a name special case in the get-property opcode (`dispatch/property_read.rs:197-203`).

**Reflect and Annex B.**

- `reflect.rs` contains thin wrappers over the `mop_*` internal methods.
- `annex_b.rs` implements `__proto__`, `__define/lookupGetter/Setter__` and `escape`/`unescape`.
- Absent: the String HTML methods and the RegExp legacy statics. XS omits these too.

## Candidate findings

### NOBJ-1 — Array write paths intern every array index as a persistent property name; ordinary Array code throws RangeError and permanently exhausts the vat's key space

- **Lens:** 1, 6 (also 5)
- **Proposed severity:** high (arguably critical: the damage persists in snapshots and cannot be undone)
- **Location:** `rust/engine/ironhorse-vm/src/interp/natives/array.rs:2056-2059` (`array_generic_index_id`). Its callers include generic push/pop (2495, 2519), shift/unshift (2568-2637), reverse (2677), splice (2787-2858), copyWithin (2935), fill (3010), `array_generic_create_data_property` (3213: toSorted, flatMap, species map/filter) and sort write-back (4565, 4571). The name table is defined at `rust/engine/ironhorse-vm/src/interp/property/keys.rs:54-82,126-140`.
- **Excerpt:**

  ```rust
  pub(in crate::interp) fn array_generic_index_id(&mut self, k: u64) -> Result<u16, Step> {
      let name = k.to_string();
      self.intern_key(&name)
  ```

  The code itself says (`array.rs:3208`): "Consequence, unfixed: this mints one name per element, so `bigArrayOfArrays.flatMap(x => x)` still walks the `u16` id space into the saturation guard."
- **Mechanism:**
  - Index keys have a non-interned representation, `ReadKey::Index` / `Payload::At(XS_NO_ID, idx)`. The read side was converted to use it (2061-2076, 2224-2252).
  - Every generic *write* still turns the index into a decimal string and interns it into the global u16 name table.
  - That table is persisted (the NAME row) and never shrinks.
  - A holey array (`new Array(n)`) or any array taking a generic path (`sort` always does) mints one id per index.
- **Scenario:**
  - `new Array(70000).fill(0)` throws `RangeError: property key space exhausted`, uncaught, at the top level.
  - `arr.sort(cmp)` or `toSorted` on 70k elements throws, and so does `reverse`, `shift` or `splice` on a holey 70k array.
  - Smaller calls silently and permanently consume the shared key space. After `new Array(40000).fill(0)`, the same machine can create only 24,407 new property names, against 30,000+ for a fresh one. After a 60k sort in crank 1, crank 2 fails after 4,406 new names.
- **Evidence:**
  - `ks/k1..k15.js` (70k elements): sort, toSorted, holey reverse, holey shift and holey splice give `RangeError: property key space exhausted`. map, filter, spread, flat, Array.from, Object.keys, JSON round-trip and split are fine.
  - `p25_fill_keyspace.js` (`try { new Array(70000).fill(0) }`): ironhorse `["70k RangeError"]`, node `["70k ok"]`.
  - `p25b`: ironhorse `["40k ok 40000","names failed after 24407 RangeError"]`. The control `p25c` gives `["30k names ok"]`.
  - `p16_sort_keyspace.js`: `"70000:RangeError property key space exhausted","newkeys RangeError ..."`.
  - Rust probe `d_sort_keyspace_persists_across_cranks`: `KEYS crank2 ... "crank2 made 4406 then RangeError: property key space exhausted"`, against `control (fresh machine) ... "control made 8000"`.
- **Recommendation:**
  - Give the MOP write and delete paths an index key form. Either extend `mop_set` and `mop_delete` to take a `ReadKey`-like key, or add `mop_set_index`.
  - Route every `array_generic_index_id` caller with `k <= u32::MAX-1` through it.
  - Where `create_data_property` keeps the id only for metering parity (3195-3213), charge the same raw units without minting.
  - Add a regression test: `new Array(1e5).fill(0)` and a 1e5-element sort, followed by an assertion that the name count is unchanged.
- **Confidence:** confirmed by probe.

### NOBJ-2 — `%TypedArray%.prototype.sort` is an insertion sort: O(n²), and unmetered for the default comparator

- **Lens:** 1 (metering hole), 4
- **Proposed severity:** high (meter bypass)
- **Location:** `rust/engine/ironhorse-vm/src/interp/natives/buffer.rs:1333-1393`
- **Excerpt:**

  ```rust
  // Stable insertion sort keeps comparator calls sequenced and fallible
  for index in 1..values.len() { ... while destination > 0 { ... let ordering = if custom { self.run_callback(..) } ... else { left.partial_cmp(&right) ...
  ```
- **Mechanism:**
  - The default path does Θ(n²) comparisons with no meter tick in the loop. The only charges are `reserve_work_scratch` and the element writes.
  - The custom-comparator path makes Θ(n²) metered callback calls, so a legitimate 100k-element sort costs about 2.5e9 callback units instead of ~1.7e6.
- **Scenario:** `new Int32Array(1e6).map((_, i) => -i).sort()` costs a few thousand computrons and hours of wall time.
- **Evidence:**
  - Rust probe: `METER ta_sort_default_20k: computrons=5013 wall=1.675s ns/computron=334172.9`, against 89.8 ns/computron for the baseline loop (3700×).
  - xst: 10k takes 0.78 s, 20k 1.95 s, 40k 6.17 s (`p17_ta_sort_*.js`). Node takes milliseconds.
- **Recommendation:**
  - Reuse `array_stable_sort` (`array.rs:4284`, merge sort, fallible comparator) over the decoded values.
  - For the default numeric order, sort with an infallible Rust comparator (`sort_by` is stable) and charge n·log n units.
- **Confidence:** confirmed by probe.

### NOBJ-3 — Set methods and `groupBy` deduplicate through linear lists: O(n·m) unmetered host work

- **Lens:** 1 (metering hole), 4
- **Proposed severity:** high
- **Location:**
  - `rust/engine/ironhorse-vm/src/interp/natives/collection.rs:2323-2325` (`key_list_contains`).
  - The union, intersection, difference and symmetricDifference loops at 2370-2459 (`result.retain(...)` at 2428, 2438 and 2450).
  - groupBy bucket search at 2726-2742 (`buckets.iter().position(...same_value_zero...)`, `reprs.iter().position`).
- **Excerpt:** `fn key_list_contains(&self, keys: &[Slot], key: &Slot) -> bool { keys.iter().any(|k| self.same_value_zero(k, key)) }`
- **Mechanism:** Each produced key scans the whole result vector (or retains over it). XS builds the result as a hashed Set. Nothing charges the scan.
- **Scenario:**
  - `a.union(b)` with 40k and 40k elements takes 13 s.
  - `Map.groupBy(xs, x => x)` with 40k distinct keys takes 4.4 s.
  - Both cost about 20k–230k computrons.
- **Evidence:**
  - Rust probe: `set_union_20k: computrons=20353 wall=4.200s ns/computron=206347.5` (2300× baseline).
  - `set_difference_20k ... ns/computron=4555.5`.
  - `groupBy_distinct_20k ... ns/computron=6945.2`.
  - xst union: 10k 0.65 s, 20k 2.56 s, 40k 13.04 s. groupBy: 10k 0.41 s, 20k 1.22 s, 40k 4.43 s.
- **Recommendation:** Build each result directly as a `CollectionData`, which gives O(1) `find` and `remove_entry` tombstones, and then wrap it. For groupBy, index buckets by `CollKey`, or by interned key and symbol id for `Object.groupBy`.
- **Confidence:** confirmed by probe.

### NOBJ-4 — Per-operation O(n) host work charged O(1): dense `splice` rebuild, WeakMap/WeakSet delete, FinalizationRegistry unregister and cleanup, `Array.prototype.toString` scan

- **Lens:** 1 (metering hole), 4
- **Proposed severity:** medium
- **Location:**
  - **(a) Dense splice.** `rust/engine/ironhorse-vm/src/interp/natives/dispatch.rs:5001-5046` copies the entire array into `cur`, then runs `clear_items` and re-inserts every element, even when the tail length is 0. The meter charges only `deletions*10 + tail_len*10` (4981-4999).
  - **(b) Weak delete.** `rust/engine/ironhorse-vm/src/bulk.rs:791-808` does `index.keys.remove(at)`, rewrites every cached position, then `entries.remove(at)`.
  - **(c) Registry unregister and cleanup.** `rust/engine/ironhorse-vm/src/interp/natives/weak.rs:215-220` runs `cells.retain` with no meter tick. `rust/engine/ironhorse-vm/src/interp/natives/weak.rs:265-270` does `position` plus `Vec::remove` per dead cell.
  - **(d) Array toString fallback.** `rust/engine/ironhorse-vm/src/interp/natives/array.rs:2448-2454` scans every function in the heap (`self.functions.iter().find_map(... ObjectToString)`) on each `Array.prototype.toString` call whose `join` is not callable.
- **Excerpt (a):**

  ```rust
  let cur: Vec<Slot> = Self::fill_scratch(self.reserve_scratch(length as usize)?, (0..length).map(|i| self.arrays[&inst].items().get(&i)...));
  ...
  a.clear_items(...); for (i, s) in rebuilt.into_iter().enumerate() { a.insert_item(i as u32, ...) }
  ```
- **Scenario:**
  - (a) Using `splice(len-1, 1)` as a pop, or inserting near the end of a large array, costs O(n) per call.
  - (b) A cache that deletes WeakMap keys in insertion order is quadratic.
  - (c) A registry with many registered cells, plus repeated `unregister(tok)`, is quadratic.
- **Evidence (Rust probe, ns/computron; baseline is 89.8):**
  - `array_splice_end_10k: computrons=389523 wall=14.366s → 36879.9` (410×).
  - `weakmap_delete_20k: computrons=625052 wall=10.334s → 16533.2`, against `map_delete_20k ... 0.135s → 215.9`.
  - `fr_unregister_200kx5k: computrons=106273 wall=2.850s → 26815.2`.
  - xst (`p26_tostring_*.js`): 60k closures × 20k `Array.prototype.toString.call({join:1})` take 5.73 s, against 0.42 s for `Object.prototype.toString`.
  - xst splice-at-end: 5k 2.92 s, 10k 16.05 s, 20k 74.16 s. Pop on 20k takes 0.11 s.
- **Recommendation:**
  - (a) Splice in place: remove the deleted range, shift only the tail keys, and drop the full-array snapshot.
  - (b) Tombstone weak entries too. They have no cursors, so they can compact when tombstones exceed live entries, as Map does.
  - (c) Index cells by token in a side map, and keep a dead-cell queue so the scan only visits dead cells.
  - (d) Cache the intrinsic `%Object.prototype.toString%` SlotIndex at boot. The same applies to `collection.rs:248`.
  - Where work stays proportional, charge per element visited.
- **Confidence:** confirmed by probe.

### NOBJ-5 — Default `Array.prototype.sort` re-runs `ToString` and copies both operands on every comparison

- **Lens:** 1 (metering hole), 4
- **Proposed severity:** medium
- **Location:** `rust/engine/ironhorse-vm/src/interp/natives/array.rs:4276-4278`, called from `array_stable_sort` 4302-4303.
- **Excerpt:** `let x_string = self.to_string_units(code, x)?; let y_string = self.to_string_units(code, y)?; Ok(x_string.cmp(&y_string))`
- **Mechanism:**
  - The sort makes about 2·n·log n full UTF-16 copies (strings) or number-to-string conversions.
  - The only charge is `length * BUILTIN_METERING` up front (4548).
  - The copies are also not admitted against the ceiling.
- **Scenario:** 2,000 references to one 100 KB string cost 1,021 computrons and 4.2 s, with RSS reaching 485 MB in xst for 5,000 copies.
- **Evidence:**
  - Rust probe: `array_sort_default_longstr: computrons=1021 wall=4.230s ns/computron=4142927.6`.
  - `array_sort_default_num_30k ... 1134.9` (12×).
  - xst `p15_sort_long_strings.js`: 27.61 s and maxrss 485 MB. Node takes 0.15 s.
- **Recommendation:**
  - Precompute each element's string once, as the SortIndexedProperties list of `(string, value)` pairs, and compare those.
  - Charge string-proportional work per comparison, or once per element.
- **Confidence:** confirmed by probe.

### NOBJ-6 — FinalizationRegistry cells are charged to no ceiling, so the registry grows host memory without bound

- **Lens:** 1 (resource bound bypass), 4
- **Proposed severity:** high
- **Location:** `rust/engine/ironhorse-vm/src/interp/natives/weak.rs:190-205` (`registry.cells.push(FinalizationCell{..})`). Compare `rust/engine/ironhorse-vm/src/interp/side_ledger.rs:16-34`, whose `side_storage_charge` sums arrays, index_props, collections and segments only.
- **Excerpt:** `registry.cells.push(FinalizationCell { target, holdings, token }); self.meter.tick_slot_alloc(); self.meter.tick_slot_alloc();`
- **Mechanism:**
  - Each `register` appends a 32 B cell (plus `Vec` doubling) that the chunk ceiling never sees.
  - The same live target can be registered without limit, so no new slots are needed.
  - Cells persist across cranks and in snapshots, and are freed only when the target dies.
- **Scenario:** `const t = {}; for (;;) fr.register(t, 0)` across cranks grows host RSS and snapshot size with the heap ceiling never firing. Only the per-crank meter limits the rate.
- **Evidence:**
  - Rust probe: `BYTES fr_cells_262144: host/unit=32.0 side-charged/unit=0.0`.
  - xst `p07`: 1M registers reach 37 MB RSS, 4M reach 128.8 MB, against a 10.8 MB baseline.
- **Recommendation:**
  - Add cells to `side_storage_charge`, charged by capacity class at a declared `FinalizationCell` width.
  - Charge the class on push and release it on unregister or cleanup.
  - The same audit applies to `disposable_stacks.records` (`resource.rs:121,149,176`), which is also uncharged.
- **Confidence:** confirmed by probe.

### NOBJ-7 — `ArrayBuffer.prototype.transfer` and `resize` copy into a fresh chunk each time; a loop with constant live memory hits HeapExhausted

- **Lens:** 1, 4
- **Proposed severity:** medium
- **Location:**
  - `rust/engine/ironhorse-vm/src/interp/natives/buffer.rs:378-431` (transfer: `alloc_array_buffer` plus a copy through a temporary `reserved_vec`, then `detach_array_buffer`).
  - `rust/engine/ironhorse-vm/src/interp/natives/buffer.rs:438-460` (`reallocate_array_buffer`: a new chunk per resize; "the old one is left for the collector").
  - `alloc_array_buffer` (2498-2519) builds a zeroed host `Vec`, then copies it into the arena.
- **Excerpt:** `let data = self.chunks.alloc(&bytes); ... record.data = data; record.length = new_length;`
- **Mechanism:**
  - Collection is quiescent-only, so the chunk of each superseded buffer stays counted until the crank ends.
  - Ownership-transfer loops (`buf = buf.transfer()`) and resize churn therefore exhaust the 256 MB ceiling.
  - Each operation also does two host copies.
- **Evidence:**
  - `p27_transfer_churn.js` (4 MB buffer, 200 transfers): ironhorse `HeapExhausted`, node `done 200 4194304`.
  - `p27_resize_churn.js` gives the same result.
  - Rust probe: `ab_resize_churn_64x4MB: ... completed=false halt=HeapExhausted`.
- **Recommendation:**
  - Make `transfer` with `newLength <= capacity` move the `ChunkOffset` to the new buffer record (zero-copy), which is what the spec intends.
  - Make shrinking `resize` keep the chunk.
  - Give the arena an `alloc_zeroed` and a copy-within or copy-between primitive, to remove the temporary vectors. Eight `.to_vec()` sites are listed under Duplication.
- **Confidence:** confirmed by probe.

### NOBJ-8 — `AsyncDisposableStack.prototype.disposeAsync` neither awaits disposers nor propagates their rejections

- **Lens:** 1 (also 5, 6d)
- **Proposed severity:** high (a wrong result on the feature's main path: errors from async cleanup are silently lost)
- **Location:** `rust/engine/ironhorse-vm/src/interp/natives/resource.rs:213-267`
- **Excerpt:**

  ```rust
  while let Some(record) = records.pop() { ... if let Err(error) = self.run_callback_catching_throw(code, record.method, this_arg, &args)? { ... } }
  if is_async { let promise = self.new_promise_instance(); self.settle_promise(code, promise, pending_error..., pending_error.is_some())?;
  ```
- **Mechanism:**
  - Spec DisposeResources (async) does `Await(result)` after each disposer, so ordering is sequential and a rejection becomes the completion.
  - Here every disposer is called synchronously, and its returned promise is ignored.
  - Only *synchronous* throws are collected, and the returned promise settles immediately.
- **Evidence:** Rust probe `c_async_dispose_awaits`, with the second program reading `R`:

  ```text
  {"log":["b-start","a-start","sync-after","b-end","settled","a-end"],"settled":"fulfilled"}
  ```

  The spec expects `["b-start","sync-after","b-end","a-start","a-end","settled"]` with `settled: "rejected:boom"`.

  test262 failures: `built-ins/AsyncDisposableStack/prototype/disposeAsync/explicit-await-for-null.js` and `explicit-await-for-undefined.js` ("Actual [dispose, job 1, job 2] and expected [job 1, dispose, job 2 …]", 4 cases). `rejects-with-error-as-is-if-only-one-error-during-disposal.js` is skipped as `async:unhandled-rejection`.
- **Recommendation:**
  - Run disposal as an async job chain: an internal async state machine, or the same resumable mechanism `Array.fromAsync` uses (`array.rs:660-1310`).
  - Await each result, fold rejections into SuppressedError, and settle at the end.
  - Check whether `await using` shares this path.
- **Confidence:** confirmed by probe.

### NOBJ-9 — `DisposableStack` / `AsyncDisposableStack` `disposed` is a phantom name special case, not a prototype accessor

- **Lens:** 1, 6 (d, e)
- **Proposed severity:** medium
- **Location:** `rust/engine/ironhorse-vm/src/interp/dispatch/property_read.rs:197-203`. The prototype is built without a `disposed` getter (`rust/engine/ironhorse-vm/src/interp/natives/resource.rs`, `rust/engine/ironhorse-vm/src/interp/native_ids.rs`).
- **Excerpt:**

  ```rust
  Payload::Reference(inst) if self.symbol_ids.get("disposed") == Some(&id) && (obj.kind == Kind::Reference && self.disposable_stacks.contains_key(&inst)) => { Slot::boolean(self.disposable_stacks[&inst].disposed) }
  ```
- **Mechanism:** Only the `obj.disposed` opcode path answers. The MOP (`Reflect.get`, computed keys, `in`, descriptors) sees nothing, and the special case even overrides an own shadowing property or a subclass getter.
- **Evidence:** `p23_ds3.js` gives

  ```text
  {"dot":false,"inOp":false,"shadowed":false,"shadowReflect":"shadow","subclass":false,"plain":7}
  ```

  `Reflect.get` and `s['dispo'+'sed']` give undefined, which is omitted from the JSON. test262 has 16 fails under `built-ins/{,Async}DisposableStack/prototype/disposed/*` ("cannot coerce undefined to object").
- **Recommendation:** Install real `get disposed` accessors (a `NativeMethod` getter) on both prototypes and delete the opcode special case.
- **Confidence:** confirmed by probe.

### NOBJ-10 — A hard-coded 1,000,000-step cap on iterator loops: uncatchable `StepLimit` halts in ten built-ins, and silent truncation in `groupBy`

- **Lens:** 3, 6 (b)
- **Proposed severity:** medium
- **Location:** The `for _ in 0..1_000_000` loops end in `Err(Step::Host(Halt::StepLimit(self.n_dispatched)))` at:
  - `rust/engine/ironhorse-vm/src/interp/natives/array.rs:435/491` (Array.from)
  - `rust/engine/ironhorse-vm/src/interp/natives/collection.rs:550/613` (Map/Set constructors)
  - `rust/engine/ironhorse-vm/src/interp/natives/collection.rs:1324/1328`, `1352/1373`, `1431/1464`, `1580/1627` and `1843/1947` (iterator helpers, toArray/reduce/…)
  - `rust/engine/ironhorse-vm/src/interp/natives/buffer.rs:905/938` (TypedArray.from)
  - outside the region, `rust/engine/ironhorse-vm/src/interp/natives/promise.rs:1741` and `rust/engine/ironhorse-vm/src/interp/natives/intl.rs:883`

  `collection.rs:2784` (groupBy) instead just exits the loop and returns a partial result.
- **Excerpt:** `// A defensive bound against a pathological non-terminating guest iterator; the tested iterables are short. for _ in 0..1_000_000 {`
- **Mechanism:**
  - `Halt::StepLimit` is the dispatch-count ceiling for un-metered callers. Here it is reused to mean "the iterator yielded more than 1M values". Under a meter the cap is redundant.
  - The same condition gets two different outcomes: a halt, or a wrong result.
  - groupBy does not close the iterator either.
- **Evidence:** `cap/c1..c7.js` over a 1,000,005-element array's `.values()`:
  - Set constructor, Array.from, Uint8Array.from, `.toArray()` and `.reduce` give `InternalError: ironhorse halted: StepLimit(17000144)`.
  - Object.groupBy returns `1000000`; node returns 1000005.
  - Spread works.
  - `p12_groupby_trunc.js`: ironhorse `[1000000,1000000,false]`, node `[1000005,1000005,false]`.
- **Recommendation:**
  - Delete the caps and rely on the meter and the ceilings, as spread already does.
  - Admit growth of the collected `Vec`s (`buffer.rs:904` `values` is unadmitted).
  - If a cap is policy, make it one named constant with one catchable outcome.
- **Confidence:** confirmed by probe.

### NOBJ-11 — 2^24 length caps make `Refused` halts on plain sparse Arrays, and `sort` reserves O(length) memory before reading

- **Lens:** 3, 6 (b)
- **Proposed severity:** medium
- **Location:**
  - `rust/engine/ironhorse-vm/src/interp/natives/array.rs:4539-4549` (sort and toSorted: `ARRAY_SORT_CAP`, then `reserve_scratch(length)`).
  - `rust/engine/ironhorse-vm/src/interp/natives/array.rs:4427-4440` (with, toReversed, toSpliced).
  - The generic caps at 2397, 2558, 2671, 2781, 2924, 3005, 3357, 3519 and 3658.
- **Excerpt:** `if length > ARRAY_SORT_CAP { return Err(Step::Host(Halt::Refused(... "Array.prototype.sort:oversized-array-like" ...` and `let mut values = self.reserve_scratch(length as usize)?;`
- **Mechanism:**
  - The caps were meant for adversarial array-likes but apply to real Arrays whose `length` is large and whose items are few.
  - The sort reserves `length × 24 B` up front, before anything is known to be present.
- **Evidence:**
  - `p14_sort_sparse.js` (`a.length = 2**25; a[0]=2; a[1]=1; a[5]=0; a.sort()`): ironhorse `Refused("Array.prototype.sort:oversized-array-like")`, node `[33554432,0,1,2,false]`.
  - `p15_sort_sparse_cap.js` with `2**24`: `HeapExhausted` after 0.02 s.
  - `p14_reverse_sparse.js` and `p14_ta_sort_obj.js` (`with`): `Refused`.
- **Recommendation:**
  - For a real Array, iterate the present keys of `items()` (and `index_props`), not `0..length`.
  - Grow `values` incrementally under admission.
  - Keep a cap only for proxies and array-likes, and make it catchable (RangeError) or meter-bounded.
- **Confidence:** confirmed by probe.

### NOBJ-12 — `%TypedArray%.prototype.toSorted`, `toReversed` and `with` are missing (ES2023)

- **Lens:** 3, 5
- **Proposed severity:** medium
- **Location:** There is no `NativeMethod` for them. The TypedArray prototype roster is at `rust/engine/ironhorse-vm/src/interp/boot.rs:742-768`, and the routing list at `rust/engine/ironhorse-vm/src/interp/natives/dispatch.rs:2271-2317`. The Array versions exist at `rust/engine/ironhorse-vm/src/interp/natives/dispatch.rs:4816-4921` and `rust/engine/ironhorse-vm/src/interp/natives/array.rs:4338`.
- **Evidence:**
  - `p20_ta_proto.js`: `"missing":["toReversed","toSorted","with"]`.
  - `p19`: `"ta_toSorted":"THROW TypeError: call: not a function"`.
  - test262: 76 fails (`built-ins/TypedArray/prototype/with` 42, `toSorted` 18, `toReversed` 16).
- **Recommendation:**
  - Implement them via `typed_array_species_create`-free `TypedArrayCreateSameType` (the spec uses the intrinsic constructor, not species), the existing element codecs, and the merge sort from NOBJ-2.
  - The effort is small: about 150 lines.
- **Confidence:** confirmed by probe and test262.

### NOBJ-13 — Symbols as WeakMap keys, WeakSet values, WeakRef targets and registry tokens are refused, and the refusal is classified two ways

- **Lens:** 3, 6 (b)
- **Proposed severity:** medium
- **Location:**
  - The method paths throw a catchable TypeError: `rust/engine/ironhorse-vm/src/interp/natives/collection.rs:92-94,121-123`, `2577-2579` and `rust/engine/ironhorse-vm/src/interp/natives/weak.rs:22-27`.
  - The constructor path halts: `rust/engine/ironhorse-vm/src/interp/natives/collection.rs:316-330`.
- **Excerpt:** `if key.kind == Kind::Symbol { return Err(Step::Host(Halt::Refused("collection-constructor:weak-symbol-oracle-version"))); }`
- **Mechanism:**
  - The pinned XS build lacks `mxKeysGarbageCollection`. ES2023 CanBeHeldWeakly admits non-registered symbols.
  - The same condition is a catchable TypeError on `.set`, `.add`, `new WeakRef` and `register`, but an uncatchable host halt in `new WeakMap([[sym, v]])` and `new WeakSet([sym])`.
  - test262 classifies the method cases as `shared-positive-test-failure` and the constructor cases as `refused:collection-constructor:weak-symbol-oracle-version`.
- **Evidence:**
  - `p19`: `"weakmap_symbol_set":"THROW TypeError: key: not an object"` and `"weakref_symbol":"THROW TypeError: target: not an object"`. Node gives `"ok"` for both.
  - The expectations list 12 `refused:` skips and about 30 `shared-positive-test-failure` skips across `built-ins/{WeakMap,WeakSet,WeakRef,FinalizationRegistry}/**/*symbol*`.
- **Recommendation:**
  - At minimum, make the constructor path throw the same TypeError.
  - To support the feature, admit `Kind::Symbol` for non-registered symbols (`Symbol.keyFor(s) === undefined`). The GC then has to treat symbol descriptor slots as weakly holdable. This is medium effort in the GC (another region).
- **Confidence:** confirmed by probe.

### NOBJ-14 — `Atomics.wait`, `notify` and `waitAsync` always halt with `Refused`, including outcomes the spec defines without blocking

- **Lens:** 3
- **Proposed severity:** low
- **Location:** `rust/engine/ironhorse-vm/src/interp/natives/buffer.rs:2231-2234`
- **Excerpt:** `if op >= 10 { return Err(Step::Host(Halt::Refused("atomics:wait-notify"))); }`
- **Mechanism:**
  - The refusal comes before any validation, so these spec-defined outcomes all become an uncatchable halt:
    - `notify` on a non-shared Int32Array returns 0.
    - `wait` on non-shared memory throws TypeError, and so does validation of a bad view.
    - `wait` with a mismatched value returns `"not-equal"`.
  - In a single-agent engine none of these needs blocking.
- **Evidence:** `p19` (notify case): ironhorse `InternalError: ironhorse halted: Refused("atomics:wait-notify")`, node `0`.
- **Recommendation:**
  - Implement validation and the non-blocking results. That covers `notify` → 0, `wait` → TypeError for non-shared memory or `"not-equal"`/`"timed-out"` when the timeout is 0, and `waitAsync` → `{async:false, value}`.
  - Refuse only a wait that would genuinely block.
- **Confidence:** confirmed by probe.

### NOBJ-15 — Array element storage is a `BTreeMap` per array: 55.6 B per item against 32 B charged, O(log n) access, and per-call rebuilds

- **Lens:** 4 (also 1: the ceiling is under-charged by 1.74×)
- **Proposed severity:** medium
- **Location:** `rust/engine/ironhorse-vm/src/bulk.rs:173-185` (`items: BTreeMap<u32, Slot>`); `rust/engine/ironhorse-vm/src/side_storage.rs:45` (`ARRAY_ITEM_BYTES = width::<(u32, Slot)>()`, 32). The comment at `rust/engine/ironhorse-vm/src/bulk.rs:151-157` already says "55.6 bytes per item".
- **Excerpt:** `/// ... a million sequential inserts into a BTreeMap<u32, Slot> allocate one node every six inserts, 55.6 bytes per item`
- **Mechanism:**
  - Dense arrays, which are the overwhelmingly common case, pay B-tree node overhead and pointer chasing.
  - Every dense method re-indexes the B-tree per element, and also the `arrays` HashMap with SipHash.
  - shift, unshift and splice rebuild the whole tree (NOBJ-4).
  - The ceiling charge uses the record width, not the node layout. The real host footprint is therefore 1.74× what the 256 MB ceiling admits: about 445 MB host for arrays at the ceiling.
- **Evidence:**
  - Rust probe: `BYTES array_int_items_262144: host/unit=55.6 side-charged/unit=32.0`.
  - xst push 100k→400k gives +16.6 MB per 300k items. Shift of 10k items takes 7.4 s, and 20k takes 33 s (proportionally metered at about 100 ns/computron, so this is perf, not a hole).
- **Recommendation:**
  - Use a dense `Vec<Slot>` (with a hole sentinel) for arrays whose holes are rare, and fall back to the BTreeMap when sparse. XS uses a contiguous item chunk.
  - Alternatively, declare the B-tree's measured per-item cost (56 B) as the charged width.
- **Confidence:** confirmed by probe.

### NOBJ-16 — `Set.prototype.intersection` re-checks membership in `this`, which the spec does not do

- **Lens:** 1
- **Proposed severity:** low
- **Location:** `rust/engine/ironhorse-vm/src/interp/natives/collection.rs:2396-2401`
- **Excerpt:** `if self.truthy(&in_other) && self.collection_find(inst, &k).is_some() && !self.key_list_contains(&result, &k)`
- **Mechanism:** Spec 24.2.4.9 step 5 appends `e` whenever `otherRec.has(e)` is true. It notes that `has` may mutate `O`, but it does not re-check membership. If `has` deletes `e` from `this`, the element is dropped here.
- **Evidence:** `p19` `set_intersection_mut`: node `"1,2,3"`, ironhorse `"2,3"`.
- **Recommendation:** Remove the `collection_find` conjunct. There is no matching test262 case (all Set tests pass), so add a local regression.
- **Confidence:** confirmed by probe.

### NOBJ-17 — Map/Set iterators and `forEach` dead-end after `clear()` (XS purge), while `delete` follows spec tombstones

- **Lens:** 1, 6 (b, d)
- **Proposed severity:** low
- **Location:** `rust/engine/ironhorse-vm/src/bulk.rs:863-881` (the `clear_entries` generation bump) and `rust/engine/ironhorse-vm/src/interp/natives/collection.rs:2127-2136` (the forEach generation check). Compare `rust/engine/ironhorse-vm/src/bulk.rs:742-750` ("a deliberate spec-over-XS choice" for delete).
- **Mechanism:** The spec's `clear` empties the entries in place, so a live iterator then reaches entries appended afterwards. The engine follows the spec for delete but XS for clear, which mixes two models of one list.
- **Evidence:** `p19` `set_iter_clear` (`for (k of s) { if (k===1) { s.clear(); s.add(9); } }`): node `"1,9"`, ironhorse `"1"`.
- **Recommendation:** Pick one model. With seq-number cursors already in place, clearing can be implemented as "tombstone all and compact", with a low-water seq, and no generation.
- **Confidence:** confirmed by probe.

## Duplication inventory

| Family | Copies / size | Sites |
|---|---|---|
| Array methods implemented twice: a dense fast path and a generic MOP path | 32 methods; about 1680 dense lines against about 2550 generic lines, plus about 460 lines of `*_fast_safe` gates | dense: `dispatch.rs:3491-3879` and `4161-5455`; generic: `array.rs:2044-4600`; gates: `array.rs:1579-2042` |
| Dense-path fallback stanza (`let result = self.array_generic_*(…)?; self.stack.truncate(base); self.push(result); return Ok(NativeResult::Pushed);`) | 33 copies × 5 lines | `dispatch.rs:3509-3829` and `4176-5240` |
| Argument read idiom `self.stack.get(base + 4 + i).copied().unwrap_or_else(Slot::undefined)` | about 155 occurrences in the region; 12 identical `let arg = \|…\|` closures across `natives/` (10 in the region, plus `date.rs:13` and `base64.rs:353`) | e.g. `dispatch.rs:129,431,639,1241,1367`; `buffer.rs:1633,2215`; `weak.rs:130`; `reflect.rs:210`; `resource.rs:75` |
| TypedArray readonly algorithms re-implementing the Array generic ones | about 215 against about 335 lines | `buffer.rs:1406-1620` and `array.rs:3895-4230` |
| TypedArray element coercion (ToNumber/ToBigInt plus the `4..=6 "integer" / 7..=9 "unsigned"` messages) | 3 copies (about 60, 60 and 20 lines) | `buffer.rs:1873-1938`, `2077-2140`, `2252-2269` |
| "BigInt kind ? `get_bigint` : `get`" | 9 copies, although `ta_element_value` (`buffer.rs:641`) exists | `buffer.rs:649,1325,1768,2058,2154`; `dispatch.rs:1117`; `array.rs:1484,3552`; `render.rs:136` |
| Byte copy through a temporary `.to_vec()` then `slice_mut` | 8 copies | `buffer.rs:291,364,421,605,1206,1666,1706-1707,1753` |
| 1M-step iterator loop ending in `StepLimit` | 11 copies (NOBJ-10) | `array.rs:435`; `collection.rs:550,1324,1352,1431,1580,1843,2784`; `buffer.rs:905`; `promise.rs:1741`; `intl.rs:883` |
| Hand-rolled IteratorStep (call next, require object, get done, get value) | 5 or more copies | `collection.rs:2275-2294` and `2785-2791`; `buffer.rs:905-936`; `array.rs:435-491`; `collection.rs:550-613` |
| 2^24 "oversized" caps | 13 separate constants | `array.rs:2397,2398,2558,2671,2781,2924,3005,3357,3519,3658,4427,4539`; `string.rs:148,741`; `regexp.rs:1664` |
| New Map/Set instance metering stanza (4 × `tick_slot_alloc` + table chunk + insert) | 3 copies | `dispatch.rs:1906-1914`; `collection.rs:2331-2341,2816-2826` |
| Collection brand plus wrong-kind metering plus read-only check | 3 copies | `dispatch.rs:5703-5723,5734-5752`; `collection.rs:2085-2101` |
| `functions.iter().find(method == X)` to recover a boot method | 2 copies, each O(heap functions) | `array.rs:2448-2454`; `collection.rs:248-254` |
| Intrinsic proto lookup `intrinsics.get(name).and_then(ctor_prototype)` | 4 or more copies | `dispatch.rs:1214-1218,1750-1754`; `invoke.rs:319-323`; `buffer.rs:866-870`; `resource.rs:196-200` |

Map/Set/WeakMap/WeakSet share one `CollectionData` and one `call_collection`, so that family is not copy-pasted. The 12 TypedArray element types are table-driven, and Float16 shares the codecs.

## Skipped features and refusals inventory

| Site | Refused or skipped | Spec status | Should support? | Effort |
|---|---|---|---|---|
| `buffer.rs:2231-2234` | `Atomics.wait/notify/waitAsync` → `Halt::Refused` before validation | ES2017/2024 | Yes, for non-blocking outcomes (NOBJ-14) | S |
| `collection.rs:316-330`; method sites | Symbol weak keys and targets (ES2023 `symbols-as-weakmap-keys`) | ES2023 | Yes; at least make the outcome consistent (NOBJ-13) | M (GC) |
| TypedArray prototype roster | `toSorted`, `toReversed`, `with` missing (76 test262 fails) | ES2023 | Yes (NOBJ-12) | S |
| `property_read.rs:197` | `disposed` accessor missing; phantom special case instead (16 test262 fails) | ES2026 (explicit resource management) | Yes (NOBJ-9) | S |
| `resource.rs:213-267` | Async disposal does not await | ES2026 | Yes (NOBJ-8) | M |
| 11 sites (NOBJ-10) | More than 1M iterator steps → `StepLimit` halt or truncation | — | Remove the cap | S |
| `array.rs:2397-4549` (13 caps) | Generic algorithms on length > 2^24 → `Refused` halt, including sparse real Arrays (NOBJ-11) | — | Iterate present keys; make the cap catchable | S–M |
| `alloc_array_buffer` (`buffer.rs:2502`) | An allocation over the ceiling → uncatchable `HeapExhausted`, not a RangeError | Spec: RangeError if the block cannot be created | XS-faithful (xsnap aborts); consider a RangeError when the request alone exceeds the ceiling | S |
| test262 expectations | Immutable ArrayBuffer (`immutable`, `sliceToImmutable`, `transferToImmutable`) skipped as `shared-test262-failure` | Stage 3/4 proposal | Later | M |
| `dispatch.rs:4583`, `5317`, `5391` | `NotImplemented("concat:sparse-arg" / "join:reference-element" / "toString:reference-element")` | — | These are dead code behind guards; delete or turn into `EngineInvariant` | XS |
| `buffer.rs:1063`, `array.rs:3139`, `3480` | `NotImplemented("…species:symbol")` when a well-known symbol is missing | — | Unreachable after boot; should be `EngineInvariant` | XS |
| `annex_b.rs` scope | String HTML methods and RegExp legacy statics absent | Annex B / proposal | XS omits them too; test262 annexB entries are listed in expectations | M |
| `DisposableStack.prototype.use(5)` with `Number.prototype[Symbol.dispose]` → accepted (`resource.rs:89`, boxes via `array_to_object`) | Spec: TypeError for a non-object | ES2026 | Yes (one-line check) | XS |
| Async `use` falls back to `@@dispose` when `@@asyncDispose` is *non-callable* (`resource.rs:98-104`) | Spec falls back only when it is *undefined*; otherwise GetMethod throws | ES2026 | XS-faithful divergence; follow the spec | XS |

## Memory and performance opportunities

| Site | Waste | Magnitude | Fix |
|---|---|---|---|
| `bulk.rs:175` ArrayData BTreeMap | B-tree per array | 55.6 B/item measured, against about 32 B for XS slots and 24 B for a `Vec<Slot>`; O(log n) access | Dense `Vec` with a sparse fallback (NOBJ-15) |
| `dispatch.rs:4684-4696, 4740-4750` shift/unshift | Rebuild the whole BTreeMap and re-count refs per call | about 1 µs per element moved (10k shifts take 7.4 s) | Contiguous storage, or a key-offset field |
| `array.rs:1655-1676, 1698-1704, 1712-1747, 1827-1831` `*_fast_safe` flag scans | O(n log n) scans for `XS_DONT_SET`/`DONT_DELETE`, although `dense_array_this` already proved `attributed == 0` | One full B-tree walk per shift, unshift, splice, fill or copyWithin | Drop them; `has_attributed_items()` is the invariant |
| `array.rs:1617-1632` `array_new_index_writes_fast_safe` | `index.to_string()` String allocation, a `symbol_ids` hash lookup and a prototype walk **per pushed element** | One heap allocation per `push` | Check an "any index-named property on the chain" bit, or check once per call |
| `dispatch.rs:4190` dense push | `Vec<Slot>` of the arguments per call | One allocation per `push` | Iterate the stack slice |
| `interp.rs:3344` `encode_element_le -> Option<Vec<u8>>`; `buffer.rs:2405` DataView get `.to_vec()`; `buffer.rs:1905` | A heap `Vec` per TypedArray store, DataView get and DataView set | One allocation per element write | Return `([u8; 8], usize)` |
| Every element loop over `self.arrays[&inst]`, `self.array_buffers[&ta.buffer]`, `detached_buffers.contains` | SipHash lookups per element | 2–3 hashes per element access | Hoist the table reference out of loops; use FxHash or a dense `SlotIndex`-indexed table |
| `buffer.rs:2506-2508`, `449-452` | A zeroed host `Vec`, then a copy into the arena | 2× peak memory and 2× memset per buffer allocation or resize | Add `ChunkArena::alloc_zeroed` |
| `array.rs:4293` `values.clone()` in merge sort | Unadmitted second copy of up to n slots | Up to about 256 MB of uncharged host memory at the cap | Admit it, or reuse the scratch |
| `dispatch.rs:2180-2184` | `proxies.contains_key` before the cheap `is_object_static_on_operand` | One hash per native call with an object arg0 | Swap the conjunct order |
| `collection.rs:2049-2068` `collection_method_brand` | Linear scan of `proto_methods` per `forEach`, `keys`, `values`, `entries` and `clear` (and so per `for-of` over a Map or Set) | O(#intrinsic methods) per call | Split the `NativeMethod` variants per brand (Map/Set) |
| `CollectionData` | Host 122 B/entry against 96 B charged | 1.27× under-charge | Declare the measured width |
| FinalizationRegistry cells | 32 B/cell uncharged (NOBJ-6) | Unbounded | Charge them |

## Ontology notes

- **One halt used for an unrelated meaning (6a).** `Halt::StepLimit` is documented as the dispatch-count ceiling for un-metered callers (`interp.rs` `run_bounded`). It is also raised for "an iterator yielded more than 1M values" at 11 sites, and that condition is classified as a silent truncation in `groupBy` (NOBJ-10).
- **Oversized input, five outcomes (6b).** The same condition, input too large for a built-in, is classified five ways:
  - `Refused("…:oversized-array-like")` at 13 caps
  - `HeapExhausted` from `reserve_scratch`
  - `StepLimit` from the iteration caps
  - catchable `RangeError` from key-space exhaustion and from the TypedArray byte length
  - catchable `TypeError("unsafe integer")` from generic push
- **Same feature, inconsistent labels (6b).** The weak-symbol refusal is a catchable TypeError on method paths and `Halt::Refused` on constructor paths. test262 labels it `shared-positive-test-failure` for the method tests and `refused:…` for the constructor tests (NOBJ-13). The `NotImplemented` labels at `dispatch.rs:4583,5317,5391` mark unreachable states that `EngineInvariant` exists to name.
- **One list, two models (6b, 6d).** Map and Set deletion follows the spec's emptied-entry model, but `clear` follows XS's purge model (NOBJ-17).
- **Array index has two representations (6c).** "Array index as property key" is `ReadKey::Index` / `Payload::At(XS_NO_ID, i)` on reads, and an interned decimal-string `u16` on writes (`array_generic_index_id`). This split is the root of NOBJ-1.
- **TypedArray kind is a bare `u8` (6c).** About 22 sites encode classes with magic numbers: `kind <= 1` means the BigInt content type, `2|3|10|11` non-integer, `4..=6` signed, `7..=9` unsigned. `TypedArrayType` (`interp.rs:1012`) has no content-type or integer field. `Native::TypedArray(idx)` persists this position, which is why Float16 is appended out of XS order.
- **Positional op codes (6c, 6e).** `NativeMethod::TypedArrayReadonly(u8)`, `Atomic(u8)`, collection iterator kinds `5/6/7` and helper ids `8..=12` are positional codes. They are defined by list position in `boot.rs:742-768` and `2353-2367` and consumed by magic-number match arms (`buffer.rs:1430-1617`, `2207-2301`; `dispatch.rs:5724-5728`).
  - The doc at `native_ids.rs:500-502` lists 10 TypedArray operations, but there are 13 (`at`, `findLast` and `findLastIndex` were appended).
  - The persistence hazard is noted only in a code comment (`boot.rs:752-754`).
- **One method id, two brands (6a).** `CollForEach`, `CollKeys`, `CollValues`, `CollEntries` and `CollClear` each stand for both the Map and the Set method. The brand is recovered from function identity by scanning `proto_methods`.
- **One state stored twice (6a).** "Detached" is both membership in `detached_buffers` and `length = 0`. "Shared" is a set membership on an otherwise ordinary `ArrayBufferData`.
- **Many verbs for charging (6a).** Charging has about 15 verbs that blur three different budgets: the meter, the chunk ceiling and the host allocator.
  - The verbs: `tick_raw`, `tick_slot_alloc`, `tick_chunk_new`, `charge_and_check`, `charge_builtin_work`, `charge_chunk_work`, `admit_transient`, `admit_scratch`, `reserve_scratch`, `reserve_work_scratch`, `extend_prepaid_scratch`, `extend_admitted_copy`, `extend_reserved_units`, `reserve_side`/`try_reserve_side` and `preflight_host_growth`.
  - Some retained host storage belongs to none of the budgets: FinalizationRegistry cells and DisposableStack records.
- **Declared width versus real layout (6e).** `side_storage.rs:14-20` says each kind is charged "the audited 64-bit layout of the record that holds it". For arrays that record is `(u32, Slot)` at 32 B, while the structure that actually holds it is a B-tree node at 55.6 B per item; `bulk.rs:151-157` says so.
- **Doc says contiguous, code is not (6e).** `ArrayData` is described as matching "XS's item-chunk order", but XS's item chunk is contiguous and this storage is not.
- **Phantom spec property (6d).** `disposed` is a name-keyed opcode special case, not a spec accessor (NOBJ-9).
- **Non-standard prototype member (6d).** `ArrayBuffer.prototype.concat`, an XS extension, is visible on a standard prototype (`p20`: `ArrayBufferProto` lists `concat`).

## Leads that did not survive

- **GC rooting of Rust-local vectors** (filter's `kept`, the Set-method results, `typed_array_from_source` snapshots): safe, because collection is quiescent-only (`gc.rs:110` `admit_collection` → `NotQuiescent` mid-crank).
- **HashMap-order nondeterminism**: none found.
  - Finalization cleanup sorts registries by index (`weak.rs:257`).
  - The `functions.iter().find` sites match a unique boot method (no compartment copies `ObjectToString`; `realm.rs:150-164` copies only eval, Function and Compartment).
  - The `CollKey` content hash is process-random but only picks the lookup start.
- **Collection brand recovery under `Reflect.apply`, `.call`, `bind`, Proxy, spread, `Array.from` and the Map/Set constructors**: all correct (p24).
- **Array edge cases**: 44 cases match node (p01), including 2^53 array-likes, holes, sort stability, comparator throw, toSorted/toSpliced/with, `flat(Infinity)`, copyWithin, Array.from closing, species, isConcatSpreadable, proxy trap order, and length 2^32. The only difference is the error text for push overflow.
- **Map/Set semantics**: correct for SameValueZero, -0 and NaN, integer-vs-double keys, BigInt and string keys, delete and re-add during iteration, forEach additions, union/difference/symmetricDifference/isSubsetOf, size<0 → RangeError, and groupBy basic results (p19).
- **Buffers**: correct for resizable buffers and out-of-bounds views, `transfer` and `transferToFixedLength` semantics, SAB grow plus Atomics.add, `TypedArray.set` with overlapping buffers (same and different type), the default sort order of -0/0/NaN, `TypedArray.from` over a Set, and subarray species (p19).
- **Float16**: `Math.f16round` boundaries (65504, 65520→Infinity, 2^-25→0, 1.5·2^-25→2^-24, ties to even, denormal min→0) and `Float16Array` stores are correct.
- **Cyclic `[a].join()`**: halts with `ReentryLimit` instead of node's `"1-"`. This is the engine-wide policy (plain recursion halts with `StackOverflow`, p03) and is XS/xsnap-faithful. It belongs to the stack region.
- **Map delete**: amortized O(1) (216 ns/computron).
- **Shift and unshift**: metered proportionally (100 ns/computron against a 90 baseline). This is a perf issue only (NOBJ-15), not a metering hole.
- **`NotImplemented("concat:sparse-arg")`**: unreachable, since the guard requires dense operands (`dispatch.rs:4514-4536`).
- **WeakRef keep-alive during a job**: guaranteed by quiescent-only collection.
- **Uint8Array base64/hex**: smoke results correct (`"1,2,3|0102ff|AQID"`).
