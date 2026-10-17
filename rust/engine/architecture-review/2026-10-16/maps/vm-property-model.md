# Map: VM property model and metaobject protocol

Reviewed commit `61cd656cb`.

## Scope

All paths are under `rust/engine/ironhorse-vm/src/`.

| File | Lines |
|---|---|
| `interp/property.rs` | 2416 |
| `interp/property/descriptors.rs` | 268 |
| `interp/property/indexed.rs` | 1184 |
| `interp/property/integrity.rs` | 396 |
| `interp/property/keys.rs` | 784 |
| `interp/property/object.rs` | 604 |
| `interp/property/ordinary.rs` | 1160 |
| `interp/property/proxy.rs` | 1354 |
| `interp/property/read_index.rs` | 506 |
| `property_index.rs` | 977 |
| `interp/symbol_keys.rs` | 89 |
| `symbols.rs` | 125 |
| `interp/strings.rs` | 217 |
| `interp/text.rs` | 371 |
| **total** | **10451** |

Neighbours I read to follow the mechanisms: `value.rs` (Slot, SlotArena,
`find_property`), `bulk.rs` (`ArrayData`), `interp/link.rs`
(`install_pending_intrinsics`, `missing_environment_global_bindings`),
`interp/environment.rs` (raw own-property writers), `interp/function.rs`
(`slot_is_callable`, `prototype_of`, `instance_put_raw`), `interp/invoke.rs`
(Proxy call path), `interp/boot.rs` (global object), the iterator-result
writers in `interp/natives/array.rs`, and `ARCHITECTURE.md`.

The previous reviewer of this region was cut off. I reused its JS probes
(`../probes/prop/`, including `kx/`, `del/`, `cg/`, `mop1-4`) and
its Rust probe (`probes/vm-property-model/zz_audit_vm-property-model_1.rs`),
re-ran everything I cite, and wrote new probes under
`../probes/vm-property-model/` (`js/` and two Rust probes).
`$SCRATCH` is `$SCRATCH`.

## What was read

- Read in full: `interp/property/ordinary.rs`, `interp/property/indexed.rs`,
  `interp/property/keys.rs`, `interp/property/read_index.rs` (lines 1-400),
  `property_index.rs` (lines 1-330, the implementation; the tests skimmed),
  `interp/symbol_keys.rs`, `symbols.rs`, `interp/strings.rs`.
- Read in full: `interp/property.rs` lines 1-1350 and 1700-2416
  (`property_at_get`, the `*_read` dispatchers, `mop_define_own_property_read`,
  `property_at_set`, prototype/extensible/own-property/define/has dispatch,
  `exotic_own_descriptor`, `mop_delete_inner`, `mop_own_keys_inner`,
  `ordered_own_key_ids`).
- Read in full: `interp/property/proxy.rs` lines 1-660 and 814-1360 (every
  trap's invariant checks, `proxy_call_step`, `proxy_construct_refused`).
- Targeted: `interp/property/descriptors.rs` 1-120, `interp/property/object.rs`
  455-520 (proxy reflective natives), `interp/property/integrity.rs` 1-140 and
  the metering lines of the rest, `interp/text.rs` (function list only).
- Grep-driven across the VM: every `find_property`, `own_property_slots`,
  `instance_prototype`, `set_own_unmetered*`, `to_property_id`,
  `array_generic_index_id`, `install_pending_intrinsics` call site; each
  non-trivial one opened and classified (see PROP-8 and "Leads that did not
  survive").
- Profiles: the previous reviewer's callgrind outputs (`probes/prop/cg/`) were
  re-annotated; one new callgrind profile (`js/cg.keys`).

## What was not read

- `interp/property.rs` 1380-1700 (`mop_get_with_proxy_metering_inner`, the
  `get_legs` loop and its metering classes) and 1900-2080 (`set_legs`,
  `typed_array_set_leg`): skimmed for shape only. Metering-constant
  correctness against XS was not checked anywhere.
- `interp/property/proxy.rs` 656-814 (the `get` forwarding/metering legs).
- `interp/property/integrity.rs` beyond `do_harden` and the metering lines;
  `interp/property/object.rs` outside 455-520; `descriptors.rs` after line 120.
- `interp/text.rs` bodies (case conversion, normalization, CESU-8 decode).
- Module namespace exotic objects: they live in `module.rs` (out of region)
  and `ironhorse-xst` runs scripts only, so they were not probed.
- Snapshot encoding of property chains, `index_props`, `accessors` and the
  name table; `interp/link.rs` beyond the two functions named above.
- The `property_index.rs` unit tests (lines 330-977) were skimmed only.

## Architecture as built

**Records.** Every heap record is a 24-byte `Slot { next: SlotIndex(u32), id:
u16, flag: u8, kind: Kind, value: Payload(16 bytes) }`
(`value.rs:620-630`). An object is a `Kind::Instance` slot whose `value` is
`Reference(prototype)` and whose `next` heads its named-property chain
(`value.rs:466-475`). Instance flag bits carry `XS_DONT_PATCH_FLAG`
(non-extensible), `XS_DONT_SET_FLAG` (array `length` non-writable,
`indexed.rs:139-158`) and `XS_DONT_MARSHALL_FLAG` (hardened mark). XS uses
32-byte slots on 64-bit (ARCHITECTURE.md:60).

**Named properties.** Each own named property is one slot keyed by its `id`,
holding the value inline; attribute bits live in `flag`. New properties are
PREPENDED (`ordinary.rs:296-300`), so chains are newest-first and
`own_property_slots` reverses them (`ordinary.rs:72-89`); XS appends. A
property slot takes the kind of its value, so `Kind::Property` never appears in
a live heap (`value.rs:767-772`). Accessors keep only flag bits in the slot;
the getter/setter pair lives in `accessors: HashMap<(SlotIndex, u16),
AccessorData>` (`interp/state.rs:2486`). A function's `length`/`name` are not
slots at all: they are synthesized from `FuncInfo`
(`ordinary.rs:114-140`, again in `property.rs:1750-1775`) with a
`deleted_fn_meta` tombstone set, and `prototype` comes from the
`ctor_prototype` side table (`property.rs:1765-1777`).

**Indexed properties** have five homes, by receiver shape:

- Arrays and `arguments`: `arrays: HashMap<SlotIndex, ArrayData>` with
  `length: u32` and `items: BTreeMap<u32, Slot>` (`bulk.rs:171-185`).
  Attributes are in item flags; mapped arguments hold `Kind::Closure` cells.
- Ordinary objects (`is_ordinary_object`, `ordinary.rs:56-65`): the
  `index_props` side table, again an `ArrayData` whose `length` is a
  high-water mark (`indexed.rs:620-700`).
- TypedArrays: the buffer, by canonical numeric index.
- String wrappers: the wrapped string's units.
- Everything else, and any index that needs an accessor: a NAMED slot under
  the index's interned decimal name (`indexed.rs:540-575`).

A deleted index-named slot on an ordinary object becomes an internal
`XS_NO_ID` tombstone in the chain (`ordinary.rs:1095-1125`).

**Lookup.** `SlotArena::find_property` (`value.rs:1340-1360`) scans 8 nodes,
then calls the derived `PropertyIndex::find` (`property_index.rs:101-205`). It
scans 32 more nodes, then walks the chain. A hit past the prefix indexes the
chain down to the hit once `deep_hits` reaches a threshold that doubles to
256. A miss (`Walk::End`, `property_index.rs:152-158`) rebuilds the whole
chain's index unconditionally. The index state per owner is
`HashMap<u16, SlotIndex>` plus a node list. Per node there is a `Watched {id,
next, owners: HashSet<SlotIndex>}` entry in a global map. Two `Vec<bool>`
bitmaps (`watched_slots`, `owner_slots`) grow to the highest slot index seen.
Invalidation runs through `SlotArena::get_mut` (`will_mutate`,
`value.rs:1308`), into the `pending` set, and then `synchronize` on the next
find. `free` (`value.rs:1285`) drops every owner that watches the freed node.
The index is not persisted, not a GC root, and not metered.

**Keys.** A key is a `u16`:

- String names count up from 1. They are stored in `symbol_names:
  Vec<SymbolName>` and again in `symbol_ids: HashMap<SymbolName, u16>`
  (`SymbolName` is a CESU-8 `Vec<u8>`). This table is positional and
  persisted ("The table IS the persisted id→name map", `keys.rs:120-125`).
- Symbol keys count down from `next_symbol_key_id` through
  `SymbolKeys {forward, reverse}` (`symbol_keys.rs:11-14`, `keys.rs:183-205`).
- Guest-driven minting must leave `PROPERTY_KEY_RESERVE = 1024` ids
  (`interp.rs:352`). Otherwise it throws a catchable `RangeError` "property
  key space exhausted" (`keys.rs:54-72`). Reserved paths saturate into a
  poison latch instead (`keys.rs:126-140`).

Computed keys are `Payload::At(id, index)`, where `id == XS_NO_ID` means an
array index. Read-side operations use `ReadKey { Id(u16), Index(u32) }` so an
index can be answered without minting a name (`read_index.rs`,
`keys.rs:559-561`). An index's two spellings must be reconciled by
`refresh_read_key`/`stable_read_key` after any guest code runs
(`keys.rs:575-604`).

**MOP dispatch.** Each internal method has an id-keyed and a `ReadKey`-keyed
entry. The `[[Get]]`/`[[Set]]` dispatchers are `mop_get`/`mop_set`; the others
are `mop_has`, `mop_delete`, `mop_get_own_property`,
`mop_define_own_property`, `mop_own_keys`, `mop_get_prototype`,
`mop_set_prototype`, `mop_is_extensible` and `mop_prevent_extensions`
(`property.rs:900-2160`). Each checks for a Proxy, then a TypedArray, an array,
a String wrapper and function exotics, and finally the ordinary path. There
are also hand-inlined variants:

- the stack-depth "legs" loops: `get_from`, `get_legs`, `set_from` and
  `set_legs`;
- the opcode in-place walks `get_property_in_place` and
  `set_property_in_place` (`ordinary.rs:662-855`);
- the per-index twins in `read_index.rs`.

Proxies are `proxies: HashMap<SlotIndex, ProxyData {target, handler,
revoked}>`, and their instance slot has a null prototype (`proxy.rs:26-53`).
Traps are looked up per call, and forwarding loops charge one light frame per
layer.

**Lazy intrinsics.** Boot members are installed when a name is first
interned. Every computed string-key resolution calls
`install_pending_intrinsics` (`keys.rs:539, 676, 755`). That call also rebuilds
`missing_environment_global_bindings` over every intrinsic name, allocating a
`SymbolName` per name (`link.rs:313-335`, `link.rs:1502-1537`).

**Strings.** Values are UTF-16BE chunks; names are CESU-8 `SymbolName`s. Each
computed key does `str_units` (a `Vec<u16>` allocation), then
`SymbolName::from_units` (a second allocation), then a hash lookup through
`SymbolIds::get(impl Into<SymbolName>)`, which clones once more
(`symbols.rs:22-27`). Each key `Object.keys` returns is a freshly allocated
chunk (`keys.rs:759-783`).

**Measured memory per property.** Counting allocator, debug build, N=20000
(`zz_audit_vm-property-model_2.rs`, output in `rust_probe_2.log`):

| Shape | Bytes/property |
|---|---|
| Small objects (8 named props, chain ≤ 8, no index) | 48.8 (incl. object + holder array amortized) |
| Large object, names already interned (slot + PropertyIndex) | 234.3 |
| Large object incl. first interning of its names | 307.5 (→ ~73 B per name) |
| Ordinary index store `o[i] = i` | 57.4 |
| Array `push` | 57.5 |
| Object literal with 8 getters | 603.4 (mostly the 8 function objects) |
| XS reference (64-bit) | 32 per property slot; 32 per array item |

## Candidate findings

### PROP-1 — Integer indices and non-property strings consume the permanent 16-bit key space through many paths

- **Lens(es):** 1 (resource bound), 3, 6c.
- **Proposed severity:** high.
- **Location:**
  - `rust/engine/ironhorse-vm/src/interp/property/keys.rs:713-721` (`to_property_id`)
  - `rust/engine/ironhorse-vm/src/interp/property.rs:327`, `:524`, `:576`, `:725`
  - `rust/engine/ironhorse-vm/src/interp/natives/array.rs:2056-2059` (`array_generic_index_id`, 29 call sites in `natives/array.rs`, `natives/regexp.rs` and `natives/string.rs`)
  - `rust/engine/ironhorse-vm/src/interp/property/proxy.rs:1116-1125` (`to_read_key` on every ownKeys-trap result)
  - `rust/engine/ironhorse-vm/src/interp/dispatch/super_property.rs:110`
  - `rust/engine/ironhorse-vm/src/interp/dispatch/property_write.rs:451`
- **Excerpt:**
  ```rust
  if let Payload::At(id, index) = key.value {
      return Ok(if id == crate::value::XS_NO_ID {
          self.intern_key(index.to_string())?
  ...
  pub(in crate::interp) fn array_generic_index_id(&mut self, k: u64) -> Result<u16, Step> {
      let name = k.to_string();
      self.intern_key(&name)
  ```
- **Mechanism:** The design says reads mint nothing and that XS never interns
  an index (`keys.rs:546-558`). Several write, reflective and generic paths
  still turn every integer index into a permanent name id:
  - `to_property_id`, used by `Reflect.set`, `Reflect.defineProperty`,
    `Object.defineProperty`, `Object.defineProperties`, `Object.create` and
    `Object.getOwnPropertyDescriptors` (13 call sites). It interns a canonical
    numeric string without checking `string_to_index`.
  - Every generic `Array.prototype` method on an array-like
    (`array_generic_index_id`).
  - `p[i] = v` on any Proxy, even one with no traps.
  - Sloppy `(5)[i] = v` and `super[i] = v`.
  - Index expandos on Map, Set, RegExp, ArrayBuffer, DataView and wrapper
    objects (`is_ordinary_object` excludes them).
  - Arbitrary strings returned by an `ownKeys` trap, which `to_read_key` interns
    only to compare them.

  These names go into the same table as real property names. That table is
  positional, persisted and never reclaimed (PROP-2), so one such call
  permanently shrinks the namespace for the rest of the worker's life.
- **Scenario:** A worker runs `Array.prototype.fill.call({length: 40000}, 1)`
  or `Object.getOwnPropertyDescriptors(new Uint8Array(40000))` once. From then
  on, `JSON.parse` of a document with 30,000 distinct keys throws `RangeError`
  forever, including after snapshot and restore. At 64k elements the operation
  itself fails: `Object.getOwnPropertyDescriptors(bigArray)`,
  `Array.prototype.sort.call(arrayLike)`, and `Reflect.set` in a 70k loop all
  throw.
- **Evidence:** Re-ran `probes/prop/kx/*.js`.
  - `RangeError: property key space exhausted` from: `copyWithin_arraylike`,
    `defineProperties`, `defineProperty_loop` (n=64406), `fill_arraylike`,
    `fromEntries`, `gopds_array`, `objectCreate`, `primitive_set_sloppy`,
    `proxy_gopds`, `proxy_set` (n=64409), `proxy_set_trap`,
    `reflect_defineProperty`, `reflect_set`, `reverse_arraylike`,
    `sort_arraylike`, `splice_arraylike`, `super_index_set2`, `ta_keys_gopds`,
    `unshift_arraylike`.
  - Fine: plain `o[i]` reads and writes, `Object.keys`/`entries`, spread,
    `JSON.stringify`, `harden`/`freeze`.
  - New probes in `probes/vm-property-model/js/`:
    ```js
    // idx_mint_then_names.js
    step('fill', function () { Array.prototype.fill.call({length: 40000}, 1); });
    step('names', function () { var o = {}; for (var i = 0; i < 30000; i++) o['n' + i] = i; });
    ```
    ```
    idx_mint_then_names.js        ih: fill:ok | names:RangeError property key space exhausted   node: fill:ok | names:ok
    idx_gopds_then_names.js       ih: gopds:ok | json:RangeError property key space exhausted   node: gopds:ok | json:ok
    idx_reflect_set_then_names.js ih: reflect.set:ok | sym:RangeError property key space exhausted node: ... | sym:ok
    ownkeys_trap_mint.js          ih: ownKeys:40000 | names threw RangeError property key space exhausted  node: ... | names:ok
    ```
- **Recommendation:**
  - Give `to_property_id` the same `string_to_index` split that
    `to_read_key` has, and return a `ReadKey`.
  - Route generic array methods through `array_index_read_key`, plus an
    `index_set` that writes by index.
  - Answer proxy `set`/`defineProperty` by index (the `read_key_slot` spelling
    already exists).
  - Compare ownKeys-trap keys by their string or symbol value, not by interned
    id.
  - Extend `indexes_by_index` to every spec-ordinary object.
  - Then the only index names left would be accessor promotions.
- **Confidence:** confirmed by probe.

### PROP-2 — The lifetime key budget is never reclaimed, even for collected symbols, and ordinary long-lived workloads exhaust it permanently

- **Lens(es):** 1 (resource bound), 6e.
- **Proposed severity:** high (documented limit; see note).
- **Location:**
  - `rust/engine/ironhorse-vm/src/interp/property/keys.rs:126-140` (`append_name_key`)
  - `rust/engine/ironhorse-vm/src/interp/property/keys.rs:183-205` (`intern_symbol_key_reserved`)
  - `rust/engine/ironhorse-vm/src/interp/state.rs:2455` (`#[gc_weak(symbol_keys)]`)
  - `rust/engine/ARCHITECTURE.md:349-353`
- **Excerpt:**
  ```rust
  let id = self.next_symbol_key_id;
  self.snapshot_dirt.mark(SnapshotSection::Symbols.mask());
  self.next_symbol_key_id -= 1;
  self.symbol_key_ids.insert(desc, id);
  ```
- **Mechanism:** String names are appended to a positional, persisted table and
  never removed. Symbol-key ids come from a counter that only decreases. GC
  does prune the `descriptor → id` entry of a dead symbol (`gc_weak`), but the
  id is never reused. The same ~64.4k budget is also consumed by every
  identifier in every `eval` or `Function` body, every evaluated
  tagged-template site (`link.rs:1346`), and every distinct key that
  `JSON.parse` ever sees. Once it is exhausted:
  - Any novel name throws `RangeError`. That includes `JSON.parse` of any
    object with a new key and `o[Symbol()]` with any new symbol.
  - The state is persisted, so restart does not help.

  ARCHITECTURE.md says only that "Guest-created string and symbol keys raise a
  catchable RangeError" and that this is "not reclamation". It does not say
  that garbage symbols, eval identifiers and indices (PROP-1) count against
  the budget, or that the outcome is permanent.
- **Scenario:** A persistent worker does any of these:
  - creates a `Symbol()` per request as a brand or private key;
  - `eval`s generated code with fresh identifiers;
  - parses JSON maps keyed by user or account IDs.

  After 64k distinct names over its whole lifetime, every later request that
  touches a new key fails, forever.
- **Evidence:**
  ```
  keys4_symbols.js  (o = {}; o[Symbol()] = 1, 70k garbage objects/symbols)  ih: caught at 64411: RangeError  node: done 70000
  keys1_string_keys.js (o['k'+i])                                         ih: caught at 64412 (9.8 s)        node: done
  eval_names.js ((0,eval)('var v'+i+'=1; delete globalThis.v'+i))         ih: caught at 64413: RangeError    node: done 70000
  tmpl_sites.js ((0,eval)('tag`x`'))                                      ih: caught at 64408: RangeError
  keys5_recovery.js (after exhaustion)  ih: 64403 RangeError | newprop 1 | known 1 | error ok x | json threw RangeError property key space exhausted
  json70k.js (JSON.parse of 70k distinct keys, fresh machine)             ih: RangeError: property key space exhausted
  ```
- **Recommendation:**
  - Reuse the ids of collected symbols: keep a free list fed by the existing
    `gc_weak` prune, and persist it.
  - Make the name table collectable. Mark names referenced from live property
    slots, `At` stack values, code atoms and closures during GC, and tombstone
    the rest; the snapshot NAME row can carry holes.
  - Or widen `id` to `u32` in the property record. `Slot` has room: the `u16`
    `id` plus `flag`/`kind` pad to 8 bytes with `next`.
  - At minimum, document every source that draws on the budget, and its
    permanence, in ARCHITECTURE.md.
- **Note:** The limit is a documented design choice. Severity hinges on
  whether long-lived persistent vats are in scope; for them it is a permanent
  denial of service from ordinary code.
- **Confidence:** confirmed by probe.

### PROP-3 — The derived PropertyIndex is rebuilt in full after every delete, making delete-heavy objects O(N) per operation at ~0.3 µs per node, unmetered; it also costs ~210 B per property

- **Lens(es):** 1 (metering: work not charged), 4.
- **Proposed severity:** high (meter amplification ~3000x and growing with N);
  medium if wall-time bounds per computron are out of scope.
- **Location:**
  - `rust/engine/ironhorse-vm/src/property_index.rs:66-82` (`free` drops every dependent owner)
  - `rust/engine/ironhorse-vm/src/property_index.rs:152-158` (`Walk::End` rebuilds with no throttle)
  - `rust/engine/ironhorse-vm/src/property_index.rs:14-18` (`Watched` with a per-node `HashSet`)
  - `rust/engine/ironhorse-vm/src/interp/property/ordinary.rs:1056-1137` (`delete_own_property`, a linear walk)
- **Excerpt:**
  ```rust
  Walk::End => {
      self.drop_owner(owner);
      let chain = collect(head, None, SlotIndex::NULL, &read);
      self.publish(owner, &chain, false);
  ```
- **Mechanism:**
  1. `delete o[k]` walks the newest-first chain linearly. The oldest key is
     at the end, so the walk is O(N).
  2. It then frees the node. `PropertyIndex::free` drops the whole owner
     index: it iterates all N nodes and removes them from the global
     `watched` hash map.
  3. The next miss on that object, such as the create in `o[k] = v`, takes
     `Walk::End`. That re-collects the chain and republishes N entries, each
     with its own heap-allocated `HashSet<SlotIndex>`.

  Any object with more than 40 named properties gets a full index on its
  first miss. The index costs ~210 B per property, on top of the 24-byte slot.
  None of this work is charged to the meter: `find_property` and the index are
  unmetered, and `delete` "meters only its dispatch" (`ordinary.rs:1053-1055`).
- **Scenario:** An LRU cache or queue kept in a plain object of 8k-32k keys,
  doing `delete o[oldest]; o[k] = v`. Each operation costs 2.6-3.5 ms of host
  time for ~10 computrons, where ordinary code costs ~0.09 µs per computron.
  A crank budget sized for ordinary code can therefore run ~3000x longer than
  intended. XS also walks linearly (~1-2 ns/node), so the index makes this
  case ~250x worse than XS.
- **Evidence:** Release `ironhorse-xst`; probes are `probes/prop/del/*.js` and
  `queue_N.js` builds N keys via `JSON.parse`, then runs
  `for (i < N/2) { delete o[ks[i]]; o[ks[i]] = i; }`.

  | N | build | queue (N/2 ops) | del_fifo | del_lifo | read_all ×4 | node queue |
  |---|---|---|---|---|---|---|
  | 8000 | 120 ms | 10378 ms (2.6 ms/op) | 340 ms | 194 ms | 578 ms | 50 ms |
  | 16000 | 219 ms | 25683 ms (3.2 ms/op) | 622 ms | 487 ms | 904 ms | 70 ms |
  | 32000 | 500 ms | 56613 ms (3.5 ms/op) | 2191 ms | 825 ms | 1989 ms | 61 ms |

  The previous reviewer's callgrind profile `probes/prop/cg/cg.queue` (4000-key
  object, 200 delete+set) attributes 46% of all instructions to
  `PropertyIndex::publish`, 36% to `SlotArena::free`, and 44% to SipHash
  `hash_one`.

  Computrons per op (`zz_audit_vm-property-model_3.rs`, debug, output in
  `rust_probe_3.log`): `queue op (delete+set, N=8000): 10.3 computrons/op`,
  against 14 computrons per iteration of a plain `o.alpha` read loop.

  Memory (`rust_probe_2.log`): `second object (slot chain only), bytes/prop:
  234.3`, against `small objects (8 props, no index), bytes/prop: 48.8`.
- **Recommendation:**
  - On free of a watched node, unlink just that name from the owner's map
    instead of dropping the owner.
  - Replace per-node `Watched` and `HashSet` entries with a per-owner
    generation stamp held in the instance record, or an owner→table map
    validated by `(head, length)`. A compact open-addressed `u16 → u32` table
    costs 6-8 B per entry.
  - Throttle `Walk::End` rebuilds like `Walk::Found`.
  - Charge chain walks beyond the 8-node prefix, or charge deletes by chain
    position, so host time stays proportional to computrons.
  - Shapes or inline caches are not justified by these measurements: hits
    are already O(1), and the costs are churn and per-op overhead (PROP-4).
- **Confidence:** confirmed by probe.

### PROP-4 — Every computed string-key operation runs the lazy-intrinsic catch-up, ~10 µs per `o[k]`, ~12.5 µs per `Object.keys` key, ~140 µs per novel key

- **Lens(es):** 4, 1 (meter calibration).
- **Proposed severity:** medium. This is the largest single performance item
  in the region.
- **Location:**
  - `rust/engine/ironhorse-vm/src/interp/property/keys.rs:539` (`resolve_at_key`), `:676` (`to_read_key`), `:755` (`to_property_id`)
  - `rust/engine/ironhorse-vm/src/interp/link.rs:1502-1537` (`install_pending_intrinsics`)
  - `rust/engine/ironhorse-vm/src/interp/link.rs:313-335` (`missing_environment_global_bindings`)
  - `rust/engine/ironhorse-vm/src/interp/link.rs:576`, `:680`, `:699`, `:818` (roster `.clone()` per install)
- **Excerpt:**
  ```rust
  let id = self.intern_key(&s)?;
  ...
  self.install_pending_intrinsics();
  Some(Slot::of(Kind::At, Payload::At(id, 0)))
  ...
  let mut missing: Vec<_> = self.intrinsics.keys().filter_map(|name| {
      self.symbol_ids.get(*name)  // SymbolName::from(&str) allocation per intrinsic
  ```
- **Mechanism:**
  - On every computed string key, `install_pending_intrinsics` runs
    `missing_environment_global_bindings`. That function walks every
    intrinsic name and allocates a `SymbolName` for each `symbol_ids` probe,
    even when nothing is pending. The computed-key paths are `o[k]`, `k in o`,
    `delete o[k]`, `hasOwnProperty`, `Reflect.*` and `Object.keys`/`entries`
    through `to_read_key`.
  - When the key is novel, it also clones the `proto_methods`, `proto_data`,
    `proto_accessors` and `proto_value_data` rosters and re-scans them.
  - `intern_implicit_key` (`keys.rs:110-116`) shows the cheap guard
    (`id > installed_names_len`), but the three hot callers do not use it.
- **Scenario:** Any program that uses objects as dictionaries runs about 10x
  slower than with static property names: `for (k in o) total += o[k]`,
  `Object.keys(o).forEach(...)`, or building objects from data with `o[key] =
  v`. Creating 64k keys takes 9.8 s.
- **Evidence:** Release xst; probes in `probes/vm-property-model/js/`.
  ```
  fn_empty.js       (100k empty iterations)          84 ms
  fn_static.js      (s += o.alpha, 100k)            101 ms   node 46 ms
  fn_computed.js    (s += o[k],    100k)           1054 ms   node 53 ms
  fn_in.js          (k in o,       100k)           1212 ms
  fn_hasown.js      (h.call(o,k),  100k)           1155 ms
  fn_reflect_get.js (Reflect.get,  100k)           1016 ms
  fn_map.js         (m.get(k),     100k)             84 ms
  keys_time_0.js / keys_time_20.js  (20 x Object.keys of 20k keys)  156 ms / 5158 ms  (node 152 ms)
  scale_strkeys_{4000,8000,16000,32000}.js (o['k'+i]=i)  650 / 1154 / 1880 / 4500 ms
  big_named_60k_build.js 7996 ms; big_named_60k_read.js 11161 ms (=> 13 us per read); node ~100 ms
  ```
  The previous reviewer's `cg.computed_read` profile (10k `o[k]`) attributes
  89% of instructions to `install_pending_intrinsics`, and 61% to
  `SymbolName::from(&str)`. My `cg.keys` profile (5 × `Object.keys` of 5000
  keys) attributes 85.8% to `install_pending_intrinsics` via `to_read_key`.

  Computrons: `computed o[k] minus static o.alpha: 2.0 computrons/op` and
  `Object.keys per key: 0.3 computrons/key`. So Object.keys runs at ~40 µs of
  host time per computron, ~450x ordinary code.
- **Recommendation:**
  - Guard all three call sites the way `intern_implicit_key` does: install
    only when `symbol_names.len() > installed_names_len`.
  - Make the missing-global catch-up incremental: a dirty flag set when a
    binding is deleted or a name is interned.
  - Iterate the rosters by reference instead of `.clone()`.
- **Confidence:** confirmed by probe.

### PROP-5 — Proxy `[[Call]]` is recomputed per call instead of fixed at ProxyCreate: a non-callable target's `apply` trap runs, and a revoked callable proxy stops being callable

- **Lens(es):** 1.
- **Proposed severity:** medium.
- **Location:**
  - `rust/engine/ironhorse-vm/src/interp/property/proxy.rs:1224-1248` (`proxy_call_step`, no callability gate)
  - `rust/engine/ironhorse-vm/src/interp/invoke.rs:576`
  - `rust/engine/ironhorse-vm/src/interp/function.rs:664-676` (`slot_is_callable`)
  - contrast `rust/engine/ironhorse-vm/src/interp/property/proxy.rs:1279-1291` (`proxy_construct_refused`)
- **Excerpt:**
  ```rust
  let (target, handler) = self.proxy_target_handler(proxy, "apply")?;
  let target_slot = Slot::of(Kind::Reference, Payload::Reference(target));
  let trap = match self.proxy_trap(code, handler, "apply")? {
  ...
  Some(data) if !data.revoked => r = data.target,
  _ => return false,
  ```
- **Mechanism:**
  - ProxyCreate gives a proxy `[[Call]]` only if its target is callable, and
    revocation does not remove it (ECMA-262 10.5.14).
  - `[[Construct]]` has a pre-trap gate (`proxy_construct_refused`), but the
    call opcode path has none, so `p()` invokes the `apply` trap of a proxy
    over `{}`.
  - Conversely, `slot_is_callable` stops at a revoked layer. A revoked proxy
    over a function therefore has `typeof` "object", and `IsCallable` returns
    false for it. A promise reaction, for example, would then treat it as
    absent and pass the value through instead of rejecting with a TypeError.
- **Scenario:** A membrane or handler that defines `apply` for every shadow
  target makes plain-object proxies callable while `typeof` says "object".
  Code that tests `typeof x === 'function'` sees revoked function proxies as
  non-functions.
- **Evidence:**
  ```
  misc1.js       ih: {"apply_on_nonfn":"called:1", ...}       node: {"apply_on_nonfn":"TypeError", ...}
  proxy_call_nonfn.js (prev. reviewer) ih: call:trap ran | typeof:object | new threw TypeError | Reflect.apply threw TypeError
                                       node: call threw TypeError | ...
  mop5.js        ih: revoked_typeof "object"                   node: "function"
  ```
  The Promise consequence is static reasoning: xst does not report errors
  thrown in jobs (`job_throw.js` exits 0). No test262 test was found for
  either case: `built-ins/Proxy/create-target-is-not-callable.js` passes
  because it calls `p.call()`.
- **Recommendation:** Record `callable` and `constructor` bits in `ProxyData` at
  `make_proxy` (as XS does with `XS_CAN_CALL_FLAG`/`XS_CAN_CONSTRUCT_FLAG`).
  Read them in `slot_is_callable`, `typeof`, and a gate before
  `proxy_call_step`.
- **Confidence:** confirmed by probe (call and typeof); high (Promise
  consequence).

### PROP-6 — `%Object.prototype%` is not an immutable prototype exotic object

- **Lens(es):** 1, 6d.
- **Proposed severity:** medium.
- **Location:** `rust/engine/ironhorse-vm/src/interp/property.rs:965-1000`
  (`mop_set_prototype_inner`).
- **Excerpt:**
  ```rust
  if !self.instance_extensible(inst) { return Ok(false); }
  if self.prototype_chain_would_cycle(inst, new_proto) { return Ok(false); }
  let slot = self.slots.get_mut(inst);
  slot.value = if new_proto.is_null() { Payload::None } else { Payload::Reference(new_proto) };
  ```
- **Mechanism:** There is no SetImmutablePrototype check
  (ECMA-262 10.4.7) for `%Object.prototype%`. Before lockdown,
  `Object.prototype` is extensible, so any value that does not create a cycle
  is accepted. The test262 tests
  `built-ins/Object/prototype/setPrototypeOf-with-different-values.js` and
  `-with-same-value.js` pass only because every value they try (`{}`,
  `Array.prototype`, `Object.prototype`) closes a cycle.
- **Scenario:** Before `lockdown()`, `Object.setPrototypeOf(Object.prototype,
  evil)` succeeds, and `evil`'s properties become visible on every object
  (`({}).injected`).
- **Evidence:** `immutable_proto2.js`:
  ```
  ih:   frozen:false,ext:true | reflect:true  | proto is n:true  | ({}).injected=from n | reset ok
  node: frozen:false,ext:true | reflect:false | proto is n:false | ({}).injected=undefined | reset ok
  ```
- **Recommendation:** In `mop_set_prototype_inner`, when `inst ==
  self.object_proto` (and any realm or compartment `Object.prototype`), return
  `SameValue(current, V)`. Add a test262-style case that uses
  `Object.create(null)`.
- **Confidence:** confirmed by probe.

### PROP-7 — The global object's `[[Prototype]]` is `null` ("lands with the intrinsics seam")

- **Lens(es):** 3, 5, 6d.
- **Proposed severity:** medium.
- **Location:** `rust/engine/ironhorse-vm/src/interp/boot.rs:62-66`.
- **Excerpt:**
  ```rust
  // The global object is a real arena instance with a null
  // prototype (the intrinsic %Object.prototype% wiring lands with
  // the intrinsics seam); its allocation predates metering, so it
  let global_obj = slots.alloc(Slot::instance(crate::value::SlotIndex::NULL));
  ```
- **Mechanism:** SetRealmGlobalObject creates the default global with
  `OrdinaryObjectCreate(%Object.prototype%)`, and XS does the same. Here the
  wiring was never done. As a result:
  - `globalThis.hasOwnProperty` is undefined;
  - `String(globalThis)` throws;
  - `globalThis instanceof Object` is false;
  - in sloppy global code, `this.hasOwnProperty(...)` throws.
- **Scenario:** Library feature-detection such as
  `globalThis.hasOwnProperty('x')` fails, and so do test262 files written in
  that style.
- **Evidence:** `global_proto.js`:
  ```
  ih:   proto:null   | typeof globalThis.hasOwnProperty:undefined | String(globalThis) threw TypeError | instanceof Object:false
  node: proto:object | typeof globalThis.hasOwnProperty:function  | String(globalThis):[object global] | instanceof Object:true
  ```
  These test262 files fail in a harness run (`probes/prop/t262.sh`):
  - `built-ins/Object/getPrototypeOf/15.2.3.2-2-30.js`: "TypeError: cannot
    coerce null to object";
  - `built-ins/Object/defineProperty/15.2.3.6-4-625gs.js` and
    `language/global-code/script-decl-lex.js`: "TypeError: call: not a
    function".

  55 test262 files call `this.<Object.prototype method>(` at line start; not
  all are global scope.
- **Recommendation:** Link the global object's prototype to `%Object.prototype%`
  once intrinsics exist, in boot and in each compartment global. Check whether
  snapshot or boot-image fixtures encode a null prototype.
- **Confidence:** confirmed by probe; medium on XS parity (from memory of
  `fxBuildGlobal`).

### PROP-8 — Built-in iterators reuse one result object and rewrite its non-writable, non-configurable `value`/`done` through a raw slot write (MOP bypass; cross-region)

- **Lens(es):** 1, 6d.
- **Proposed severity:** medium.
- **Location:**
  - `rust/engine/ironhorse-vm/src/interp/natives/array.rs:1369-1375` (`new_reused_iterator_result`), `:1541-1543`
  - `rust/engine/ironhorse-vm/src/interp/natives/collection.rs:824-825`, `:929-930`, `:2040-2041`, `:2968-2969`
  - `rust/engine/ironhorse-vm/src/interp/enumerate.rs:331-332`
  - the writer `rust/engine/ironhorse-vm/src/interp/environment.rs:334-356` (`set_own_unmetered`)
- **Excerpt:**
  ```rust
  let fixed = XS_DONT_DELETE_FLAG | XS_DONT_SET_FLAG;
  self.set_own_unmetered_with_flag(result, value_id, Slot::undefined(), fixed);
  ...
  self.set_own_unmetered(result, vid, Slot::of(new_value.kind, new_value.value));
  ```
- **Mechanism:** CreateIterResultObject must return a fresh `{value, done}`
  with writable, enumerable, configurable data properties on every `next()`.
  Instead, Array, Map, Set, String and the `Object.entries` array iterators
  hand back one object per iterator and overwrite its fields with
  `set_own_unmetered`. That raw writer bypasses `[[DefineOwnProperty]]`,
  ignores `XS_DONT_SET_FLAG`, and would leave accessor flags stale. It is the
  XS (`fxNewIteratorInstance`) behaviour, preserved.
- **Scenario:** A peekable iterator or lookahead parser keeps `peeked =
  it.next()` and then calls `it.next()` again; `peeked.value` changes under
  it. Collecting results (`for (r = it.next(); !r.done; r = it.next())
  arr.push(r)`) yields an array of the same final `{value: undefined}`.
- **Evidence:** `iter_reuse.js` and `iter_reuse2.js`:
  ```
  ih:   same:true | a.value:2 | desc:{"value":2,"writable":false,"enumerable":true,"configurable":false} | map same:true
  node: same:false | a.value:1 | desc:{"value":1,"writable":true,"enumerable":true,"configurable":true} | map same:false
  ih:   gen same:false a.value:1 | str same:true c.value:b | regexp same:false | entries same:true h.value:y,2 | collected:,
  node: gen same:false a.value:1 | str same:false c.value:a | regexp same:false | entries same:false h.value:x,1 | collected:10,20
  ```
  Generators and the RegExp String Iterator are correct.
- **Recommendation:** Allocate a fresh result per `next()`. The metering is
  already per call. If parity with XS is intentional, list it in the design's
  oracle-divergence section and mark the affected test262 tests. Retire
  `set_own_unmetered` for guest-reachable objects.
- **Confidence:** confirmed by probe.

### PROP-9 — Proxy `getOwnPropertyDescriptor` trap: `IsExtensible(target)` runs after `ToPropertyDescriptor(trapResult)`

- **Lens(es):** 1.
- **Proposed severity:** low.
- **Location:** `rust/engine/ironhorse-vm/src/interp/property/proxy.rs:465-467`.
- **Excerpt:**
  ```rust
  let result_desc = self.descriptor_from_object(code, obj)?;
  let result_desc = complete_descriptor(result_desc);
  let extensible = self.mop_is_extensible(code, target)?;
  ```
- **Mechanism:** In ECMA-262 10.5.5, step 12 (`IsExtensible`) precedes step 13
  (`ToPropertyDescriptor`). Both can run guest code: a target proxy's
  `isExtensible` trap, and descriptor getters. The order is therefore
  observable.
- **Scenario:** Logging traps record a different order; a throwing
  `isExtensible` hides a getter's throw, and vice versa.
- **Evidence:** `mop5.js`:
  ```
  ih:   gopd_trap_order "get enumerable,get configurable,get value,get writable,isExtensible"
  node: gopd_trap_order "isExtensible,get enumerable,get configurable,get value,get writable"
  ```
- **Recommendation:** Swap the two lines.
- **Confidence:** confirmed by probe.

### PROP-10 — Key and name lookups allocate on every call (by-value `Into<SymbolName>`, `String` round-trips), and the hash maps use SipHash

- **Lens(es):** 4.
- **Proposed severity:** low (medium in aggregate with PROP-4).
- **Location:**
  - `rust/engine/ironhorse-vm/src/symbols.rs:22-27`
  - `rust/engine/ironhorse-vm/src/interp/property/keys.rs:373-391` (`scalar_key_text` returns `String`)
  - `rust/engine/ironhorse-vm/src/interp/property/keys.rs:559-561` (`index.to_string()` per lookup)
  - `rust/engine/ironhorse-vm/src/interp/property/indexed.rs:1083-1110` (`array_own_descriptor`, two `String`s per call)
  - `rust/engine/ironhorse-vm/src/interp/property.rs:1704-1779` (`exotic_own_descriptor`)
  - `rust/engine/ironhorse-vm/src/interp/property.rs:2399-2415` (`sort_by_key` recomputes `key_id_index` per comparison)
- **Excerpt:**
  ```rust
  pub fn get(&self, name: impl Into<SymbolName>) -> Option<&u16> {
      self.0.get(&name.into())
  }
  ```
- **Mechanism:**
  - `SymbolIds::get` clones even a `&SymbolName` (`From<&SymbolName>` is
    `s.clone()`).
  - `scalar_key_text` materializes a `String` just to test `== "length"` or
    parse an index.
  - `exotic_own_descriptor` runs for every prototype level of a property read
    whose own lookup misses. On an array receiver that costs two `String`
    allocations. For a function it costs one more, plus a `SymbolName` for
    `"prototype"`.
  - `ordered_own_key_ids` re-derives the sort key `O(n log n)` times, with an
    allocation each time.
  - All of this hashes through the default SipHash.
- **Scenario:** `a.indexOf` in a loop costs ~18k instructions per iteration;
  `exotic_own_descriptor` alone accounts for 3.4k of them.
- **Evidence:** The previous reviewer's `cg.arr_method` (100k ×
  `a.indexOf === undefined`): 1.81 G Ir total; `exotic_own_descriptor` 341.6 M
  (18.9%); `hash_one` 301.6 M (16.7%).
- **Recommendation:**
  - Implement `Borrow<[u8]>` for `SymbolName` and look names up by slice.
  - Cache per-id facts (is-index, index value, is-`length`) in a parallel
    `Vec` indexed by id.
  - Compare ids against the existing `length_id`/`name_id`/`prototype_key_id`
    caches.
  - Use `sort_by_cached_key`.
  - Switch to FxHash or AHash with a fixed seed. Iteration order is not used
    for results, but check each map before switching.
- **Confidence:** high (profile plus static reading).

### PROP-11 — The ordinary `[[Get]]`/`[[Set]]` walks and the per-index twins are hand-copied ("keep the two in step")

- **Lens(es):** 2.
- **Proposed severity:** low.
- **Location:** See the duplication inventory. Representative sites:
  - `rust/engine/ironhorse-vm/src/interp/property/ordinary.rs:525-583`, `:594-645`, `:684-760` (three `[[Get]]` walks)
  - `rust/engine/ironhorse-vm/src/interp/property/ordinary.rs:794-854`, `:856-910`, `:922-967`, and `rust/engine/ironhorse-vm/src/interp/property/indexed.rs:771-830` (four `[[Set]]` walks)
- **Excerpt:** "Kept apart from `ordinary_get`, which every `[[Get]]` runs, so
  that its frame and the inlining around it stay as they were: keep the two in
  step." (`ordinary.rs:588-593`)
- **Mechanism:** Stack-depth and in-place-call refactors forked the walks
  instead of parameterizing them. The by-index read path (`read_index.rs`, 506
  lines) mirrors get/has/own-descriptor/delete and the proxy `has` trap.
- **Scenario:** A fix applied to one copy and not the others gives divergent
  semantics by syntax. The in-place `[[Set]]` walk (`ordinary.rs:806-854`)
  already differs from `ordinary_set` in its comment-stated preconditions:
  "`dispatch_set_property` sent apart".
- **Evidence:** Static. About 600 lines across the copies.
- **Recommendation:** One generic walk, parameterized by a `Key` trait (Id or
  Index) and a continuation enum (`Value`, `Delegate(proto)`,
  `EnterGetter`). `#[inline(always)]` wrappers can keep frame size.
- **Confidence:** high.

### PROP-12 — One concept, "array-index property", has two key types and five storages whose identity depends on global interning history

- **Lens(es):** 6c, 6b, 2.
- **Proposed severity:** low. No live inconsistency was found, but the bug
  history in comments is long.
- **Location:**
  - `rust/engine/ironhorse-vm/src/interp/property/keys.rs:563-600` (`refresh_read_key`/`stable_read_key`)
  - `rust/engine/ironhorse-vm/src/interp/property/ordinary.rs:56-65` (`is_ordinary_object`)
  - `rust/engine/ironhorse-vm/src/interp/property/indexed.rs:594-603` (`indexes_by_index`)
- **Excerpt:**
  ```rust
  /// Re-resolve a [`ReadKey`] that was captured earlier in the same
  /// operation, in case the guest has since NAMED that index.
  ```
- **Mechanism:** Index 5 is either `ReadKey::Index(5)` or `ReadKey::Id(id of
  "5")`, depending on whether anything has ever interned "5". Every comparison
  must canonicalize after guest code runs. The property itself may live in an
  array item, the index store, a TypedArray buffer, a String wrapper unit, or
  a named slot. `ordinary_get_own_descriptor` bridges named and stored forms
  by re-parsing the id's text on every miss (`ordinary.rs:150-156`).

  `is_ordinary_object` is a homonym of the ECMA term. It excludes
  spec-ordinary Map, Set, RegExp, ArrayBuffer, DataView and Boolean/Number
  wrappers, so index expandos on those mint names (PROP-1). Meanwhile
  `ordinary_get` performs exotic TypedArray and side-table reads on parents.
- **Scenario:** Every new feature that touches keys must handle both
  spellings. The comments record past bugs:
  - `'0' in o` depending on history (`property.rs:1176-1188`);
  - `harden` leaving a named copy writable (`indexed.rs:866-877`);
  - `Object.freeze` missing store items on functions (`property.rs:2298-2303`).
- **Evidence:** `dualkey.js`: 13 mixed index/accessor/proxy/freeze/super/with
  cases, run with and without a prior `Reflect.set` that interns the index
  names. All match node except implementation-defined function own-keys.
- **Recommendation:**
  - Make an index key a distinct variant end-to-end (`PropertyKey::{Index(u32),
    Name(u16), Symbol(u16)}`) and never intern index spellings.
  - Store all index properties of non-array objects in the index store,
    accessors included. The accessor side table could be keyed by
    `(inst, PropertyKey)`.
  - Rename `is_ordinary_object` to what it tests.
- **Confidence:** high (static design analysis).

## Duplication inventory

| Family | Copies (path:line) | Size | Note |
|---|---|---|---|
| Ordinary `[[Get]]` prototype walk | `interp/property/ordinary.rs:525` `ordinary_get`; `:594` `ordinary_get_walk`; `:684` `get_in_place_walk`; prefix again in `interp/property.rs:1445` `mop_get_with_proxy_metering_inner` | 3 × ~55-75 lines | "keep the two in step" comments |
| Ordinary `[[Set]]` walk | `interp/property/ordinary.rs:794` `set_in_place_walk`; `:856` `ordinary_set`; `:922` `ordinary_set_walk`; by-index `interp/property/indexed.rs:771` `index_set_walk_held` | 4 × ~45-60 lines | TypedArray-parent test (`scalar_key_text` + `canonical_numeric_index_string`) repeated 3 times verbatim |
| By-index twins of MOP methods | `interp/property/read_index.rs:60` (get levels) vs `interp/property.rs` `mop_get`; `:234` (has levels) vs `interp/property.rs:1300`; `:279` (own descriptor) vs `interp/property.rs:1067`; `:341` (delete) vs `interp/property.rs:2084`; `:442` (proxy has trapped) vs `interp/property/proxy.rs:625` | ~500 lines | `ReadKey` dispatchers `interp/property.rs:210-345` |
| Own-property presence vs descriptor | `interp/property.rs:1096-1193` `object_own_property_present` (~100 lines) duplicates the shape dispatch of `mop_get_own_property_inner` (`:1067`) + `exotic_own_descriptor` (`:1704`); `interp/property/read_index.rs:183` again for indices | 3 | presence-only fast path |
| Function `length`/`name` synthesis | `interp/property/ordinary.rs:114-140` `function_meta_own_descriptor`; `interp/property.rs:1750-1775` in `exotic_own_descriptor` | 2 × ~25 lines | first tests `length_id`, second re-derives "length" by text |
| Descriptor-to-flag application | `interp/property/indexed.rs:425-445`, `:488-508`, `:1002-1022`; `interp/property/ordinary.rs:369-385` | 4 × ~20 lines | one `apply_descriptor_flags(flag, &desc)` helper |
| Item-flag to descriptor | `interp/property/indexed.rs:394-401`, `:728-740` (`index_prop_descriptor`), `:1099-1107`; `interp/property/read_index.rs:309-316` | 4 | |
| Raw "prepend a property slot" | `interp/property/ordinary.rs:296-300`; `interp/property/descriptors.rs:16-24`, `:39-45`; `interp/environment.rs:9-20`, `:343-354`, `:370-386`, `:403-420`; `interp/function.rs:567-574` | 8 | none updates `global_props`/`tick_property_create` uniformly |
| Key interning entry points | `interp/property/keys.rs:22`, `:75`, `:84`, `:97`, `:111`, `:126`, `:166`, `:183`, `:214` | 9 functions | admitted / reserved / unmetered / implicit variants |
| ToPropertyKey + intern | `interp/property/keys.rs:405` `property_key_id`, `:447` `resolve_at_key`, `:634` `to_read_key`, `:713` `to_property_id` | 4 | differ in index handling and `gate_default`; root of PROP-1 |
| Index → name | `interp/property/keys.rs:559` `index_read_key_id`; `:618` `read_key_intern`; `interp/property/indexed.rs:564` `array_index_promotion_id`; `interp/natives/array.rs:2056` `array_generic_index_id`; `:2069` `array_index_read_key`; inline `symbol_ids.get(index.to_string())` at `interp/property.rs:643`, `interp/render.rs:80` | 7 | |
| Proxy trap invariant blocks | id and index variants of has / getOwnPropertyDescriptor / delete share code via `ReadKey`, except `has` (`interp/property/proxy.rs:625` vs `interp/property/read_index.rs:442`) | 2 | |

## Skipped features and refusals inventory

| Site | What is refused or skipped | Spec status | Should support? | Effort |
|---|---|---|---|---|
| `interp/boot.rs:62-66` | Global object `[[Prototype]]` left null; "%Object.prototype% wiring lands with the intrinsics seam" | ES default is `%Object.prototype%` (SetRealmGlobalObject) | yes (PROP-7) | small (plus snapshot-fixture audit) |
| `interp/property.rs:965-1000` | Immutable-prototype exotic behaviour of `%Object.prototype%` | required since ES2016 | yes (PROP-6) | trivial |
| `interp/natives/array.rs:1369` and siblings | Fresh iterator result objects (XS parity) | CreateIterResultObject | yes (PROP-8) | small |
| `interp/property/keys.rs:54-72` | Novel key past ~64.4k lifetime names → `RangeError` | no spec limit | partially: reclaim (PROP-2) | large |
| `interp/property/proxy.rs:105-111` | ownKeys trap result that is a primitive other than null/undefined: ECMA requires an object (kept; XS boxes) | ECMA-conformant | n/a | — |
| `interp/property/indexed.rs:272-283` | `checked_array_length` returns `None` for fractional or out-of-range lengths ("out of the covered set") | callers raise RangeError (verified `arrlen.js`) | already correct | — |
| `interp/dispatch.rs:3488`, `interp/dispatch/super_property.rs:14` | `super` with no home object → `Halt::NotImplemented` | unreachable from valid code (early error) | reclassify as `EngineInvariant` | trivial |
| `interp/property/descriptors.rs:35-38` | `define_descriptor_field_slot` silently drops the field on a key-interning error | n/a | should propagate | trivial |

## Memory and performance opportunities

| Site | Waste | Magnitude | Fix |
|---|---|---|---|
| `property_index.rs` (`Owner`, `Watched`, per-node `HashSet`) | Derived index for every object with more than 40 named props | ~210 B/property measured (slot is 24 B; XS slot 32 B) | Per-owner compact table plus generation stamp (PROP-3) |
| `property_index.rs:66-82`, `:152-158` | Full drop and rebuild after each delete; unthrottled miss rebuild | 2.6-3.5 ms per delete+insert at 8k-32k keys | Incremental unlink, throttle (PROP-3) |
| `interp/property/keys.rs:539/676/755` → `interp/link.rs:313` | Lazy-intrinsic catch-up per computed key | ~10 µs/op, ~12.5 µs per `Object.keys` key, ~140 µs per novel key | Guard by `installed_names_len`, dirty flag (PROP-4) |
| `symbols.rs:22-27` | `SymbolName` clone/alloc per lookup | 61% of instructions in the computed-read profile (with PROP-4) | `Borrow<[u8]>` lookups (PROP-10) |
| `interp/property/indexed.rs:1083-1110`, `interp/property.rs:1704` | Two `String` allocations per array own-descriptor probe | 3.4k Ir per `a.method` read | Id-fact cache (PROP-10) |
| `bulk.rs:171-185` (`BTreeMap<u32, Slot>`) | Array items and ordinary index store | 57.5 B/elem measured vs XS 32 B (64-bit) | Dense `Vec<Slot>` with a holes bitmap for dense arrays; BTreeMap only when sparse |
| `interp/state.rs:2486` (`accessors` HashMap keyed `(SlotIndex, u16)`) | Getter/setter pair outside the property slot | est. 56-byte entry + hashbrown overhead ≈ 64-130 B per accessor; XS keeps the pair in the slot | `Payload::Accessor(SlotIndex, SlotIndex)` (fits the 16-byte payload) or a pair slot |
| `interp/property/keys.rs:126-150` (`symbol_names` + `symbol_ids`) | Each name stored twice (two heap `Vec<u8>`s) | ~73 B per interned name measured | Store once (arena or `Rc<[u8]>`) and index the map by offset |
| `interp/property/keys.rs:759-783` (`property_key_slot`) | Fresh chunk per key per `Object.keys`/`ownKeys`/`for-in` | one string chunk per key per call; XS shares the key string | Cache an interned key-string chunk per id, rooted by the name table |
| `property_index.rs:29-35` (`watched_slots`, `owner_slots`) | `Vec<bool>` sized to the highest slot index ever indexed, never shrunk | 2 B per arena slot at worst | Bitset, shrink on collect |
| `interp/strings.rs:101-105` | Empty string allocates a new zero-length chunk each time while the comment says "interned" | one header per `""` result, unmetered | Return the static `""` chunk |
| `interp/property.rs:2399-2415` | `sort_by_key` recomputes `key_id_index` (alloc + hash) per comparison | O(n log n) allocations per own-keys call | `sort_by_cached_key` or the id-fact cache |

Measurements behind this table: `rust_probe_2.log`, `rust_probe_3.log`, the
JS timings in PROP-3 and PROP-4, `big_idx_100k.js` (100k index keys built and
read 4× in 625 ms, node 38 ms), and `big_named_60k_json_read.js`
(`JSON.parse` of 60k keys plus `Object.keys` in 875 ms; `JSON.parse` itself
does not pay PROP-4).

## Ontology notes

- **"symbol" is a homonym.** `symbols.rs`, `symbol_ids` and `symbol_names`
  hold the XS compiler's "symbols atom": every identifier or property-name
  STRING. `symbol_key_ids`, `is_symbol_key_id`, `symbol_keys.rs` and
  `Kind::Symbol` mean ECMAScript Symbol values. A reader of
  `keys.rs:367-371` has to know that `is_symbol_key_id` is about the second
  kind and `symbol_ids` about the first.
- **Bare `u16` stands for six referents.** `Slot.id` (`value.rs:623`) is a
  property key id (string name or symbol), a closure binding name, a frame's
  argument count ("Doubles as the argument count on frame slots"), the
  internal environment marker `u16::MAX` with flag bit 0
  (`value.rs:791-793`), `XS_NO_ID` as "anonymous function" (`value.rs:155-159`),
  and inside `Payload::At` an "array index" marker. String-name and Symbol
  ids share the type and are told apart by range and a side-table probe.
- **Index keys** have two representations (`ReadKey::Index`, an interned `Id`)
  and five storages (PROP-12). "Ordinary object" in code
  (`is_ordinary_object`) is not ECMA's ordinary object.
- **`Kind::Property` is documented twice, inconsistently.** `value.rs:476-482`
  presents it as the property-slot kind. `value.rs:767-772` says it "never
  appears in a running heap — it survives as a decode tag and in synthetic test
  fixtures". The taxonomy has a variant the heap does not use, and the doc on
  the variant describes a design that is gone.
- **Refusal vocabulary.**
  - `Halt::NotImplemented` is used for an unreachable invariant
    (`super_at:no-home`), while sibling invariant breaks in this region use
    `EngineInvariant` (`keys.rs:654-662`, `property.rs:34`).
  - Key exhaustion is a catchable `RangeError` on admitted paths but a
    "poison latch" on reserved paths (`keys.rs:126-140`, `:189-194`): the same
    condition, two classes.
- **"intern / mint / name / key / atom".** Each pair is used interchangeably
  for the same act: "mint" vs "intern"; "name" vs "key" vs "id". `ReadKey`
  is a key used for writes too (`mop_define_own_property_read`,
  `read_key_intern`).
- **ECMA model divergences, guest-observable:**
  - the global object's `[[Prototype]]` (PROP-7);
  - `%Object.prototype%` immutability (PROP-6);
  - Proxy `[[Call]]`/`[[Construct]]` presence as a creation-time property
    (PROP-5);
  - iterator result identity (PROP-8);
  - lazily materialized intrinsic properties. These are claimed unobservable;
    `pending_surfaces` is derived and not persisted, while the floor
    `installed_names_len` is persisted (`keys.rs:102-108`).
- **Docs vs code:**
  - ARCHITECTURE.md:349-353 lists only "guest-created string and symbol keys"
    as drawing on the namespace. Indices (PROP-1), eval identifiers and
    collected symbols also draw on it.
  - `property_index.rs:1` says "Only long chains are indexed"; in fact any
    chain past 40 nodes is fully indexed on the first miss.
  - `strings.rs:101-105` says "interned" but allocates.

## Leads that did not survive

- **PropertyIndex and replica divergence:** its maps use `RandomState`, but
  iteration order only affects which owners are dropped first. Lookups return
  the same node as a linear scan; the index is not persisted and not metered.
  No divergence.
- **Stale `accessors` entries after slot reuse:** the table is pruned by
  owner liveness (`interp/state.rs:2478`, `gc_hook(early, owner_pair)`).
- **Dual index/name storage inconsistencies:** 26 `dualkey.js` cases, with and
  without pre-interned names, match node.
- **ValidateAndApplyPropertyDescriptor edge cases match node:**
  non-configurable enumerable change, same or different getter, NaN and -0,
  data↔accessor conversion defaults, generic-on-accessor, set-only keeping
  get (`mop5.js`).
- **Array exotic length semantics match node:** shrink stopping at a
  non-configurable element, strict TypeError, partial shrink with
  `writable:false`, RangeError on bad lengths, `valueOf` called twice, index
  4294967295, non-writable `length` with push or index define (`mop5.js`,
  `arrlen.js`).
- **String exotic matches node:** own-key order including out-of-range index
  expandos, same-value define, "-0", strict delete and assignment.
- **TypedArray matches node:** `"-0"`, `"1.5"`, `"Infinity"`, `"NaN"` are
  numeric (no prototype read); `"0.0"` and `"1e2"` are ordinary;
  out-of-bounds set through a child receiver; define/delete rules;
  detached-buffer keys.
- **Arguments exotic** mapping and unmapping (assign, delete,
  define-value/non-writable/accessor, strict) matches node.
- **Proxy invariants** for defineProperty, has, get, set, deleteProperty
  (including the ES2020 non-extensible check), getPrototypeOf,
  setPrototypeOf, isExtensible, preventExtensions and ownKeys are correct by
  reading and probe. Freeze and isFrozen trap order matches node.
- **Divergences from node where IronHorse is correct:**
  - `Object.isFrozen(Object.preventExtensions([]))`: IronHorse `false`
    (spec, since `length` is writable); node `true`.
  - `Object.seal(new Uint8Array(2))`: IronHorse throws, per ES2024 TypedArray
    `[[DefineOwnProperty]]`.
  - `Object.preventExtensions` of a length-tracking TA: IronHorse throws
    (ES2024 `IsTypedArrayFixedLength`).
- **Divergences that are implementation-defined:**
  - for-in over a Proxy: trap order differs from node; IronHorse follows the
    spec's informative EnumerateObjectProperties.
  - Function own-key order (`caller` after `prototype`, no `arguments`).
- **`find_property`/`instance_prototype` fast paths in natives are guarded:**
  species (`natives/array.rs:1845-1945`), RegExp `exec`
  (`natives/regexp.rs:228-280`), `prototype_of`, `render`, `rawJSON`, `super`
  home. All 15 `bypass1.js` cases match node: Proxy `newTarget` `prototype`
  get, `instanceof`/`isPrototypeOf` through `getPrototypeOf` traps, for-in
  with a proxy in the chain, `@@toStringTag` getter or proxy, Error toString
  getters, accessor `constructor`, `exec` override in the chain, `with`
  `@@unscopables` getter, global accessor variables.
- **Guest-reachable poison latch:** not found. All exhaustion probes (names,
  JSON, symbols, eval names, template sites) produced a catchable
  `RangeError`.
- **`keys_alloc.js` HeapExhausted:** not property-specific. The control
  `keys_alloc_ctrl.js`, which allocates the same strings without
  `Object.keys`, also exhausts, so this is a GC-within-script question for the
  memory region.
- **The O(N) chain walk itself (lookups):** hits and misses are O(1) once
  indexed; `big_idx_100k.js` and the read-only loops scale linearly. The cost
  is churn (PROP-3) and per-op overhead (PROP-4), not lookup complexity.

## Probe index

All probes are under `../probes/vm-property-model/` unless they
are marked "prev".

- `js/run.sh` runs a script under ironhorse-xst (release) and node 22, and
  prints exit, time and the first error line.
- Keyspace:
  - `js/keys1_string_keys.js`, `js/keys2_json.js`, `js/keys3_map.js`,
    `js/keys4_symbols.js`, `js/keys5_recovery.js` (copied from prev
    `probes/prop/`);
  - `js/idx_*_then_names.js`, `js/ownkeys_trap_mint.js`, `js/eval_names.js`,
    `js/tmpl_sites.js`;
  - prev `probes/prop/kx/*.js`.
- PROP-4: `js/fn_*.js`, `js/computed_*`, `js/static_*`, `js/keys_time_*.js`,
  `js/big_*.js`, `js/keys_cg.js` with `js/cg.keys` (callgrind); prev
  `probes/prop/cg/`.
- PROP-3: prev `probes/prop/del/*.js`.
- MOP: `js/mop5.js` (outputs `mop5.ih.json`, `mop5.node.json`),
  `js/dualkey.js`, `js/bypass1.js`, `js/misc1.js`, `js/arrlen.js`,
  `js/immutable_proto2.js`, `js/global_proto.js`, `js/iter_reuse*.js`,
  `js/revoked_callable.js`; prev `probes/prop/mop1-4.js`.
- Rust:
  - `zz_audit_vm-property-model_2.rs` (memory per property; a variant of prev
    `_1` with N=20000 plus an accessor case; output in `rust_probe_2.log`);
  - `zz_audit_vm-property-model_3.rs` (computrons per op; output in
    `rust_probe_3.log`).

  Both ran as `rust/engine/ironhorse-vm/tests/zz_audit_vm-property-model_{2,3}.rs`
  with `CARGO_TARGET_DIR=$SCRATCH/audit-target`. The temporary test files
  have been deleted, and `git status` is clean.
