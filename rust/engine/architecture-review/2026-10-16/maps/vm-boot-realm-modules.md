# Map: VM boot, realm, linking, modules, compartments and public API

Reviewed commit `61cd656cb`.

## Scope

All paths are relative to `rust/engine/`.

| File | Lines |
|---|---|
| `ironhorse-vm/src/interp/boot.rs` | 2,995 |
| `ironhorse-vm/src/interp/boot/tests.rs` | 296 (skimmed) |
| `ironhorse-vm/src/interp/realm.rs` | 1,305 |
| `ironhorse-vm/src/interp/link.rs` | 1,703 |
| `ironhorse-vm/src/module.rs` | 1,350 |
| `ironhorse-vm/src/module_snapshot.rs` | 237 |
| `ironhorse-vm/src/compartment.rs` | 2,090 |
| `ironhorse-vm/src/interp/natives/compartment.rs` | 501 |
| `ironhorse-vm/src/interp/intrinsic_order.rs` | 1,547 |
| `ironhorse-vm/src/interp/native_ids.rs` | 1,464 |
| `ironhorse-vm/src/interp/host.rs` | 336 |
| `ironhorse-vm/src/lib.rs` | 304 |
| `ironhorse-vm/src/source_scan.rs` | 381 |
| `ironhorse-vm/src/halt_labels.rs` | 409 |
| `ironhorse-vm/src/diagnostics.rs` | 15 |
| `ironhorse-runtime/src/lib.rs` (+ `tests/runtime_compile_meter.rs` 498) | 197 |
| `ironhorse-text/src/lib.rs` | 206 |
| `ironhorse-unicode/src/lib.rs` (+ `tests/identifiers.rs` 51) | 177 |

I also read code outside the region where the lazy-intrinsic mechanism lives or is triggered:

- `interp/property/keys.rs` (lines 1–260 and 470–800).
- `interp/property/ordinary.rs` (lines 212–300).
- `interp/property.rs` (lines 1030–1060 and 2150–2175).
- `interp/enumerate.rs` (lines 1–160).
- `interp/shared_persist.rs` (lines 200–260 and 805–830).
- `interp/restore.rs` (lines 40–75).
- `interp/suspend.rs` (lines 1140–1167).
- `interp/dispatch.rs` (lines 4805–4945, the module opcodes).
- `symbols.rs` (lines 20–40).
- `interp/state.rs` (field declarations for `functions`, `pending_surfaces` and `intrinsic_key_ranks`).
- `designs/ironhorse-intrinsic-fault-in.md`.

## What was read

- **`link.rs`**: read in full.
  This covers `bind_program_symbols`, `link_intrinsics`, `intern_intrinsic_dependencies`, `install_global_intrinsic_binding`, `missing_environment_global_bindings`, `install_named_intrinsic_bindings`, the relink paths (`relink_program_symbols`, `relink_crank` and template sites), `install_pending_intrinsics`, `intrinsic_surface_holders`, `materialize_intrinsic_own_surface` and `materialize_runtime_global`.
- **`realm.rs`**: read in full.
  This covers lockdown, `new_shared_realm_machine_configured`, environments and `create_environment`.
- **`compartment.rs`**: lines 1–1260 read closely (the `Compartment` and `Machine` API, `execute`, restore and claim).
  The rest (job and rejection APIs and tests) was skimmed by grep.
- **`natives/compartment.rs`**: lines 1–200 and 320–340 read closely.
- **`intrinsic_order.rs`**: lines 1180–1547 (the key-order machinery and tests) read in full.
  The tables were counted with a script: 150 holders, about 900 keys and about 75 globals.
- **`boot.rs`**: lines 1–420 read closely (`Interp::new`, `derive_boot_fingerprint` and the start of `create_intrinsics`), plus `create_species_accessors`.
  The other creators were read only through a function and loop index made with grep.
- **`native_ids.rs`**: lines 1–60 and 1280–1464 (`display_name`, `arity`, `intrinsics()`).
- **`module.rs`**: lines 1–300 and 615–735.
  I grepped the rest for refusals and indexing panics.
- **`module_snapshot.rs`**: lines 1–60.
- **`host.rs`**: the code bodies were read in full, with doc comments skipped.
- **`lib.rs`**: read in full.
- **`halt_labels.rs`**: lines 1–200.
- **`diagnostics.rs`**: read in full.
- **`source_scan.rs`**: lines 1–80.
- **`ironhorse-runtime`, `ironhorse-text` and `ironhorse-unicode`**: each `src/lib.rs` read in full.
  The `ironhorse-unicode` table lengths were checked with a script.
- **Harness evidence**:
  - `ironhorse-262/src/bin/ironhorse_xst.rs`;
  - `ironhorse-262/corpora-modules/*.js` (heads only);
  - the `ironhorse-262/expectations/whole-tree/*module-code*`, `*import*`, `*export*` and `*dynamic-import*` files, tallied by outcome;
  - `ironhorse-262/tests/implicit_member_reach.rs`;
  - `ironhorse-snapshot/tests/name_floor_carry.rs`;
  - `ironhorse-snapshot/tests/common/twin.rs`.

## What was not read

- **`boot.rs`, lines 420–2995**: the individual `create_*` builders.
  I indexed these by grep only, so I did not check the property attributes or arities of individual built-ins here.
- **`boot/tests.rs`**: skimmed only (it is the interpreter field inventory).
- **The `INTRINSIC_KEY_ORDER` and `GLOBAL_KEY_ORDER` contents**: not checked against XS key by key.
- **`native_ids.rs`, lines 60–1280**: the `NativeMethod` variants, beyond grep.
- **`module.rs`, lines 300–615 and 735–1350**: instantiate, `ResolveExport`, the namespace object and the unit tests.
  I read these only by grep for panics.
- **`compartment.rs`, lines 1260–2090**: the job and rejection APIs and the in-file tests.
- **`halt_labels.rs`, lines 200–409** (the engine-invariant list), and `source_scan.rs` past line 80.
- **`ironhorse-runtime/tests/runtime_compile_meter.rs`**.
- **The restore and persistence code beyond the lines cited.**
  I did not audit every snapshot row of the module graph or the environments.
- **Unicode-version currency of `ironhorse-unicode`'s tables**: not compared against Node.

## Architecture as built

**Boot.**
`Interp::new()` (`boot.rs:60-106`) allocates the global object, eight static `typeof` strings and then every intrinsic object and native function (`create_intrinsics`, `boot.rs:335`).
It records each prototype's members in four rosters rather than installing them:

- `proto_methods`: `(holder, &'static str, function)`;
- `proto_data`;
- `proto_value_data`;
- `proto_accessors`.

It then sets:

- `pending_surfaces`, a `HashSet` of every roster holder except the global object (`boot.rs:89`), which is not persisted (`state.rs:2873-2882`);
- `intrinsic_key_ranks`, a clone of a process-wide `OnceLock` map from each holder to its `&'static` rank table (`intrinsic_order.rs:1280-1289`);
- the six lockdown stand-ins and the `lockdown_complete` slot.

It finally fixes `boot_slot_count`.
Measured: 557 µs, 797 live slots and 15.5 KB of chunks (Probe R1).

`derive_boot_fingerprint` (`boot.rs:115-326`) is computed once per process.
It hashes:

- `Debug` renderings of every boot slot;
- the sorted functions;
- the rosters;
- `INTRINSIC_KEY_ORDER`, resolved to holders;
- about 70 named boot fields, each listed by hand.

**Linking: name-triggered lazy installation.**
A member of an intrinsic exists once its *name* is in the realm name table (`symbol_names`/`symbol_ids`) at or below the persisted floor `installed_names_len` (`NFLR`).

- `link_intrinsics` (`link.rs:143-185`):
  1. derives the id caches (`bind_program_symbols`);
  2. interns `toString`, `valueOf`, `join`, `name` and `message`;
  3. installs every standard global binding in XS order (`install_standard_globals`, `intrinsic_order.rs:1395`);
  4. runs `install_named_intrinsic_bindings` with `full = true`.
- `install_named_intrinsic_bindings` (`link.rs:384-1196`) does three things for each name in a suffix of the table:
  - it binds globals;
  - it applies roughly a dozen hand-written "dependency" gates, which intern implicit names such as `next`, `done`, `value`, `then`, `constructor` and `toISOString` when trigger names such as set methods, iterator helpers, `from`, `Map` or `groupBy` are present (`link.rs:189-231` and `425-562`);
  - it walks all four rosters (each cloned first), installing every member whose name id passes `keep`. Each member is placed at its XS rank by `place_intrinsic_key` (`intrinsic_order.rs:1347`).
- The `full`-only tail installs about 45 `@@toStringTag` strings, three `@@species` accessors, `%ThrowTypeError%` freezing, and the `@@iterator`/`@@asyncIterator`/`@@dispose` aliases.

Later installation happens only where code calls `install_pending_intrinsics` (`link.rs:1502-1537`).
That function:

1. runs the create-only pass over `symbol_names[floor..]` when the table has grown past the floor;
2. always calls `missing_environment_global_bindings`.

Call sites:

- `relink_crank` (`link.rs:1400`, `1461`);
- the eval bridge (`eval.rs:140`);
- every computed string key (`keys.rs:539`, `676`, `755`);
- `iterable.rs:166`, `array.rs:3046` and `promise.rs:1479`, `1616` and `1824`;
- `intern_implicit_key` (`keys.rs:111-117`, used for `toJSON` and `toISOString`);
- `materialize_intrinsic_own_surface` (`link.rs:1578-1653`).

`materialize_intrinsic_own_surface` interns every member name of one holder, then runs the global pass.
It is called by:

- `mop_own_keys_inner` (`property.rs:2166`), for *every* `[[OwnPropertyKeys]]`, including on plain objects;
- `mop_prevent_extensions_inner` (`property.rs:1050`), which covers `freeze`, `harden` and `lockdown`;
- `force_locked_down_constructor` (`realm.rs:650`);
- `ordinary_define_own_property` (`ordinary.rs:260-265`), but only while `pending_surfaces` still contains the holder.

Names interned without any pass:

- JSON.parse keys (`json.rs:1768`);
- RegExp group names (`regexp.rs:1125`, `1230`, `1821`);
- `groupBy` keys (`collection.rs:2880`);
- every native `intern_static_key("…")` read.

There are about 30 distinct names, for example `constructor`, `exec`, `flags`, `has`, `keys` and `resolve`.

**Relinking.**

- An aligned crank only re-runs `install_pending_intrinsics`.
- A non-aligned crank clones the whole name table and does a linear `position` lookup per crank name (`link.rs:1404-1418`).
- A growing crank re-derives all caches with `bind_program_symbols`, which clones the table again and rebuilds `symbol_ids` (`link.rs:20-71`).
- Eval units are relinked through hashed `intern_program_symbol`.
- Tagged-template sites mint a permanent `\0ironhorse-template-site:N` name per site per compilation (`link.rs:1322-1355`).

**Realm, environments and Machine.**

- One `Realm` (`realm.rs:24-41`) holds the `Intrinsics` flags and roots and the default global.
- Each `CompartmentEnvironment` (`realm.rs:45-98`) holds:
  - the global object;
  - `global_props`, a `HashMap<u16, SlotIndex>`;
  - `binding_names` (a `BTreeSet`, which is the deletion history);
  - `global_lexicals`;
  - the `global_names` filter;
  - the compiler handles.
- Inactive environments are kept in `inactive_environments`, keyed by the global object's `SlotIndex`.
- `create_environment` (`realm.rs:932-973`) allocates a global and installs every standard global (about 75).
  Measured: 76 slots and 92 µs per compartment (Probe R1).

`Machine::new` goes through `new_shared_realm_machine_configured` (`realm.rs:725-892`), which:

1. boots;
2. links the union of `DEFAULT_KEYS`, intrinsic names and all roster member names (installing the whole surface);
3. enumerates every instance slot as a root;
4. poisons the function-family constructors;
5. hardens every root.

Measured: 90 ms, 3,173 live slots and 523 KB RSS per Machine (Probe R1).
A shared-machine restore builds `Interp::new()` plus two more full shared machines only to compare root lists (`shared_persist.rs:216` and `816`).

**Compartments.**
There are two implementations of "Compartment":

- **Host side** (`compartment.rs`): a `Compartment` handle with a counter-based `CompartmentId`, the endowment maps, a host-side `ModuleGraph`, and the `name` and hook flags. The environment is created lazily at first `execute`.
- **Guest side** (`natives/compartment.rs:51-180`): `new Compartment(opts)` reads `globals`, `globalLexicals`, `modules` (validated, then discarded) and `name` (read, then discarded). It creates an environment and per-environment copies of `eval`, `Function` and `Compartment` (`compartment_evaluator`, `realm.rs:150-177`).

`Compartment.prototype` has only `globalThis`, `evaluate`, `constructor` and `@@toStringTag` (Probe J5).

**Modules.**

- The bytecode path (`dispatch.rs:4841-4945`) runs a single self-contained module body.
- It refuses the following with `Halt::NotImplemented`:
  - imports and re-exports (`module:static-linking`);
  - dynamic `import()`;
  - `import.meta`;
  - top-level await;
  - a missing execute body.
- It pushes `undefined` where XS returns the module instance.
- `module.rs` is a separate host-side `BodyOp` model of CyclicModuleRecord (link, evaluate, the namespace and `ModuleSource`), which the interpreter never consults.
  It is persisted through `module_snapshot.rs`, for primitive values only.

**Public API** (`lib.rs`).

- `#![forbid(unsafe_code)]`.
- It exports `Interp` with public `link_intrinsics`, `relink_crank`, `install_test262_host` and `run`.
- It exports the raw `Slot`, `Payload`, `SlotArena` and `ChunkArena`.
- It exports `Machine` and `Compartment`, whose `define_global(&str, Slot)` refuses heap-backed slots only at evaluation, as `NotImplemented`.
- `#[doc(hidden)]`: `diagnostics`, `source_scan` (a filesystem walker using `expect`) and `SIDE_TABLES`.
- `HostValue`/`HostCallContext` (`host.rs`) give scope-branded access to primitives and string units only.
- `halt_labels.rs` holds the allowlists of `NotImplemented`, `Refused`, helper and invariant labels, pinned by `tests/halt_label_registry.rs` through `source_scan.rs`.

**Small crates.**

- `ironhorse-runtime` adapts `ironhorse-compile` to `SourceCompiler`, with panic containment and an error-kind mapping.
- `ironhorse-text::SymbolName` is a canonical XS CESU-8 `Vec<u8>`.
- `ironhorse-unicode` holds XS's delta tables, scanned linearly; the even lengths 1,372 and 1,598 were verified, and a full-domain hash test exists.

## Candidate findings

### BOOT-1 — A resumed machine diverges from its live twin, because `pending_surfaces` is not persisted but decides whether the install pass runs

- **Lens(es):** 1 (nondeterminism, replica divergence), 6 (two definitions of "this intrinsic's surface is complete").
- **Proposed severity:** critical.
- **Location:**
  - `ironhorse-vm/src/interp/property/ordinary.rs:260-265`;
  - `ironhorse-vm/src/interp/state.rs:2873-2882`;
  - `ironhorse-vm/src/interp/boot.rs:89`;
  - `ironhorse-vm/src/interp/link.rs:1651-1652`.
- **Excerpt:**
  ```rust
  if self.pending_surfaces.contains(&inst)
      && !self.installing_intrinsics
      && self.find_property(inst, id).is_none()
  {
      self.materialize_intrinsic_own_surface(inst);
  }
  ```
  and the field documentation: "Derived at boot and never persisted: a restored machine starts with every holder pending, and completing a complete surface again changes nothing."
- **Mechanism:**
  - The doc comment's premise is false. `materialize_intrinsic_own_surface` ends with `install_pending_intrinsics()`, a *machine-wide* pass that installs every pending name on *every* holder.
  - A live machine that completed holder H earlier has removed H from `pending_surfaces`. Its resumed twin has H pending again.
  - When a guest later adds a new key to H, only the twin runs the global pass.
  - The live machine leaves runtime-interned names (for example from `JSON.parse`) uninstalled. The twin installs them.
  - `link.rs:1579-1582` documents exactly this hazard for `materialize_intrinsic_own_surface` itself ("a resumed machine would install, and charge, where its live twin did not"), but the caller still branches on the unpersisted set.
- **Scenario:**
  1. Crank 1: `Object.getOwnPropertyNames(Boolean.prototype)`.
  2. Snapshot.
  3. Crank 2:
     ```js
     var parsed = JSON.parse('{"to' + 'Fixed":1,"x":2}');
     Object.setPrototypeOf(Number.prototype, parsed);
     Boolean.prototype.zz = 1;
     var seen = []; for (var k in Object(1)) seen.push(k);
     seen.join()
     ```
  The live machine and the resumed machine return different strings and charge different computrons.
  In a consensus deployment, a validator that restarted from a snapshot diverges from one that did not.
- **Evidence:** Probe R2 (`ironhorse-snapshot`, eager resume through `begin_store_session`/`resume_from_store`):
  ```
  AUDIT assign live    = (true, "Return", "toFixed,x", 212)
  AUDIT assign resumed = (true, "Return", "x", 177)
  AUDIT assign agree   = false
  AUDIT define live    = (true, "Return", "x", 199)   # computed key 'zz' runs the pass on both
  AUDIT define resumed = (true, "Return", "x", 199)
  AUDIT control live   = (true, "Return", "x", 165)   # no holder completed before snapshot
  AUDIT control resumed= (true, "Return", "x", 165)
  ```
- **Recommendation:**
  - Persist the completion state, using the per-holder bitset that `designs/ironhorse-intrinsic-fault-in.md` proposes.
  - Or derive "complete" from persisted data. For example, holder H is complete iff every roster name of H is at or below `NFLR`.
  - Until then, make the define path either always or never run the global pass, independently of `pending_surfaces`.
  - Add this crank pair to `name_floor_carry.rs`. Its existing `reflecting_on_a_completed_surface…` row covers only the reflection path, not the define path.
- **Confidence:** confirmed by probe.

### BOOT-2 — A lazily installed intrinsic member is observably absent on paths that use a runtime-interned name without an install pass

- **Lens(es):** 1 (wrong results), 6 (property existence is defined by name-table membership, not by the ECMA-262 CreateIntrinsics model), 5.
- **Proposed severity:** high.
- **Location:**
  - `ironhorse-vm/src/interp/enumerate.rs:66-72` and `95-153` (`for_in_level_keys` → `own_enumeration_keys`, raw slot walk);
  - `ironhorse-vm/src/interp/natives/regexp.rs:1819-1823` (GetSubstitution `$<name>`);
  - interning without a pass at `natives/json.rs:1768`, `natives/regexp.rs:1125`/`1230` and `natives/collection.rs:2880`.
- **Excerpt:**
  ```rust
  let name = SymbolName::from_units(&replacement[i + 2..end]);
  let id = self.intern_key(&name)?;
  let (object_inst, object) = named_captures.unwrap();
  let capture = self.mop_get(code, object_inst, id, object)?;
  ```
- **Mechanism:**
  - A member is installed only when some install pass covers a name above the floor.
  - Passes run at relinks, eval, computed-key conversion and about ten hand-picked native sites.
  - Two classes of observation bypass them.
  - **(a) Fresh name, direct read.** A native interns a fresh name and immediately `mop_get`s with it.
  - **(b) Name interned earlier, no key conversion.**
    - The name was interned earlier by a path without a pass.
    - It is then observed without any key conversion.
    - for-in builds each prototype level's keys from the raw slot chain (`own_enumeration_keys`), not through `[[OwnPropertyKeys]]`.
    - So a pending non-enumerable member on an intermediate level fails to shadow an enumerable key further up.
  - The same property can read as absent and then present within one crank.
- **Scenario:** two cases follow, with Node's answer for comparison.
  - **for-in shadow (Probe J1, `p2_forin_shadow_proto.js`):**
    ```js
    var parsed = JSON.parse('{"to' + 'Fixed":1, "x":2}');
    Object.setPrototypeOf(Number.prototype, parsed);
    var seen = []; for (var k in Object(1)) seen.push(k);
    ```
    Ironhorse gives `["toFixed","x"]`; Node gives `["x"]`.
  - **[[Get]] miss (Probe J2, `p3_get_hole_replace.js`):**
    ```js
    var re = /a/;
    re.exec = function () { var r = ["a"]; r.index = 0; r.groups = Object(1); return r; };
    var out = "a".replace(re, "[$<to" + "Fixed>]");
    var again = typeof Number.prototype["to" + "Fixed"];
    ```
    Ironhorse gives `{"out":"[]","afterComputedRead":"function"}`; Node gives `{"out":"[function toFixed() ","afterComputedRead":"function"}`.
- **Evidence:** the two probe outputs above, run on `target/release/ironhorse-xst` and on Node 22.
  Leads that came out clean (iterator close, RegExp `flags`/`exec`, await, `splice` species) are listed below.
  Today's natives happen to fast-path those reads.
- **Recommendation:**
  - Adopt the fault-in design, with two amendments the design omits:
    - for-in level enumeration (`own_enumeration_keys`) is a whole-key-set observer and must complete the holder, like `[[OwnPropertyKeys]]`;
    - every native `intern_*`-then-`mop_get` site must go through the MOP miss check, not `find_property`.
  - Add the two probes as rows of `ironhorse-262/tests/implicit_member_reach.rs`, which today covers only name-triggered paths.
- **Confidence:** confirmed by probe.

### BOOT-3 — Every novel runtime string key runs a full roster install pass: about 286 µs of unmetered host work per key, growing with the live function count

- **Lens(es):** 1 (metering hole), 4.
- **Proposed severity:** high.
- **Location:**
  - `ironhorse-vm/src/interp/property/keys.rs:530-539`, `659-676` and `748-756`;
  - `ironhorse-vm/src/interp/link.rs:1502-1511`;
  - `ironhorse-vm/src/interp/link.rs:566-568`, `576`, `680`, `699` and `818` (roster clones and walks);
  - `ironhorse-vm/src/symbols.rs:25-27`.
- **Excerpt:**
  ```rust
  let id = self.intern_key(&s)?;
  // ... Complete the same create-only lazy install ...
  self.install_pending_intrinsics();
  ```
  ```rust
  let typed_array_ctor = self.functions.iter().find_map(|(&function, info)| {
      (info.native == Some(Native::TypedArrayBase)).then_some(function)
  });
  ...
  let methods = self.proto_methods.clone();
  for &(proto, mname, mfunc) in &methods { ... self.symbol_ids.get(mname) ... }
  ```
- **Mechanism:**
  - Each new name (the floor is behind by one) runs `install_named_intrinsic_bindings` over the whole roster, not just over the holders that own that name.
  - That walk includes:
    - four `Vec` clones of the rosters;
    - a `SymbolIds::get(&str)` per roster entry, each of which allocates a `Vec<u16>` and a `Vec<u8>` (`impl Into<SymbolName>`) and then SipHashes;
    - about 40 gate lookups;
    - a scan of the entire `functions` map, which includes every guest closure.
  - The meter charges only the one slot allocation for the novel name.
- **Scenario:**
  - A program builds a dictionary keyed by data: `o["k"+i] = v` over 20,000 ids.
  - It takes 5.7 s, against 31 ms for 20,000 index keys and 15 ms on Node.
  - It is charged *fewer* computrons than the index-key loop.
  - With 50,000 live closures it rises to 6.4 s.
  - The computron-per-second rate falls about 200×, so any time-based crank budget derived from computrons is off by two orders of magnitude.
- **Evidence:** Probe R1 (release):
  ```
  AUDIT index_keys_20k             seconds=0.031 computrons=522703
  AUDIT novel_computed_keys_20k    seconds=5.713 computrons=470300
  AUDIT json_parse_keys_20k        seconds=0.136 computrons=837566   # same 20k names, no pass
  AUDIT fns_50k_then_index_keys_20k seconds=0.322 computrons=2647776
  AUDIT fns_50k_then_novel_keys_20k seconds=6.446 computrons=2595374
  ```
  Through `xst`: `p8_novel_keys_fns0.js` took 5.35 s and `p8_novel_keys_fns100k.js` took 12.40 s.
- **Recommendation:**
  - Index the rosters by name, as a `name → [(holder, kind, member)]` map.
    The pass over a suffix of k names then costs O(k·members-per-name).
  - Cache the boot identities (`%TypedArray%` and the species and `@@toStringTag` getters) in fields instead of `functions.iter().find_map`.
  - Make `SymbolIds` lookups allocation-free: implement `Borrow<[u8]>` on `SymbolName` and look ASCII or BMP `&str` up by its UTF-8 bytes, which equal its CESU-8 bytes.
  - The fault-in design removes the per-key pass entirely.
- **Confidence:** confirmed by probe.

### BOOT-4 — Every computed string-key operation runs a scan of about 65 allocating hash lookups, making `o[k]` about 12× slower than `o.k`

- **Lens(es):** 4, 1 (a metering skew of about 10×).
- **Proposed severity:** medium.
- **Location:**
  - `ironhorse-vm/src/interp/link.rs:313-335` (`missing_environment_global_bindings`), called unconditionally from `link.rs:1522`;
  - reached from `keys.rs:539`, `676` and `755`;
  - `ironhorse-vm/src/symbols.rs:25-27`.
- **Excerpt:**
  ```rust
  let mut missing: Vec<_> = self.intrinsics.keys().filter_map(|name| {
      self.symbol_ids.get(*name).copied()   // allocates two Vecs per call
          .filter(|id| !self.environment.binding_names.contains(id))
          ...
  ```
- **Mechanism:**
  - `install_pending_intrinsics` always performs the per-environment global catch-up, even when the name table has not grown.
  - That catch-up iterates all about 65 global constructor names, converting each `&str` into a `SymbolName` (two heap allocations), then sorts and dedups.
  - Every reflective or computed operation pays it: `o[k]`, `k in o`, `Object.hasOwn(o,"a")`, `Reflect.get`, `Object.keys` (once per key) and `defineProperty`.
- **Scenario:**
  - 200,000 `p[k]` reads take 3.79 s, against 0.31 s for `p.k`.
  - 100,000 `Object.hasOwn(o,"a")` calls take 2.59 s.
- **Evidence:** Probe R1:
  ```
  AUDIT static_reads_200k   seconds=0.312 computrons=4300049
  AUDIT computed_reads_200k seconds=3.786 computrons=4900057
  ```
  Through `xst`, `p11_static_read.js` took 0.61 s, `p11_index_read.js` 0.62 s and `p11_computed_read.js` 3.85 s.
- **Recommendation:**
  - Run the global catch-up only when the name table or the environment changed, using a generation counter per environment.
  - Make `SymbolIds::get(&str)` allocation-free, as in BOOT-3.
- **Confidence:** confirmed by probe; the attribution to this function is from static reading.

### BOOT-5 — Crank relink cost grows with the never-shrinking name table: 130 ms per crank at 50,000 runtime keys

- **Lens(es):** 4, 1 (unmetered host work driven by the guest).
- **Proposed severity:** medium.
- **Location:**
  - `ironhorse-vm/src/interp/link.rs:1403-1419`;
  - `link.rs:1457` → `bind_program_symbols` (`link.rs:20-71`).
- **Excerpt:**
  ```rust
  let mut extended = self.symbol_names.clone();
  for name in crank_names {
      let id = match extended.iter().position(|n| n == name) {
  ```
- **Mechanism:**
  - A non-aligned crank clones the whole table and does a linear search per crank name, giving O(N·M) work.
  - A growing crank then rebuilds every derived structure from scratch: about 25 special-id `position` scans, plus a clone and rehash of all N names.
  - Runtime-interned names are permanent, and a guest can mint 50,000 names cheaply (`JSON.parse` keys cost about 0.1 s).
  - So every later crank of that machine pays this unmetered.
- **Scenario:** a vat that once parsed a large JSON object makes every later delivery about 100 ms slower before any guest code runs.
- **Evidence:** Probe R3 (a 200-name crank, then a non-growing crank):
  ```
  AUDIT runtime_keys=0     growing_relink_ms=1.09   reuse_relink_ms=0.08
  AUDIT runtime_keys=10000 growing_relink_ms=12.79  reuse_relink_ms=0.44
  AUDIT runtime_keys=50000 growing_relink_ms=130.17 reuse_relink_ms=12.80
  ```
- **Recommendation:**
  - Resolve crank names through `symbol_ids` (O(M)).
  - Append incrementally instead of cloning and rebinding.
  - `bind_program_symbols` needs to run only at restore.
- **Confidence:** confirmed by probe.

### BOOT-6 — `Machine::new` costs 90 ms and 523 KB, rebuilt from scratch every time; a shared-machine restore builds two more just to validate

- **Lens(es):** 4.
- **Proposed severity:** medium.
- **Location:**
  - `ironhorse-vm/src/interp/realm.rs:725-892`;
  - `ironhorse-vm/src/interp/shared_persist.rs:216` and `816`;
  - `ironhorse-vm/src/interp/restore.rs:56-61`.
- **Excerpt:**
  ```rust
  let boot = Self::new_shared_realm_machine();
  if state.default_global != boot.realm.global_object().0
      || state.intrinsic_roots != boot.realm.intrinsics().roots.iter()...
  ```
  This sits in `restore_shared_machine`. `restore_shared_evaluators` builds another `boot` unconditionally.
- **Mechanism:**
  - Every Machine performs a full boot, links about 2,000 names through the allocating roster pass, then hardens every primordial.
  - Hardening walks keys through `to_read_key`, which pays the BOOT-4 scan per key.
  - A restore of a shared machine pays one `Interp::new()` plus two complete Machine constructions (at least 180 ms) only to obtain a deterministic root list and evaluator templates.
  - The plain-`Interp` boot is cheap (0.56 ms, 797 slots), but linking even the program `0` adds 1.7 ms.
- **Scenario:** a host that creates a Machine per vat or worker, or restores many vats, pays about 90 ms per creation and at least 180 ms per restore.
  Compartments themselves are cheap (92 µs, 76 slots).
- **Evidence:** Probe R1:
  ```
  AUDIT interp_new_us=557 live_slots=797 chunk_bytes=15498
  AUDIT new_plus_link_us=2283 live_slots_after_trivial_link=1099
  AUDIT machine_new_us=89930 machine_live_slots=3173 chunk_bytes=17228
  AUDIT compartment_create_eval_us=92 slots_per_compartment=76.0 chunk_bytes_per_compartment=0
  AUDIT rss_per_machine_kb=523
  AUDIT rss_per_linked_interp_kb=44
  ```
- **Recommendation:**
  - Compute the reference root list and evaluator rows once per process (`OnceLock`), as `boot_fingerprint` already does.
  - Build Machines by cloning a process-wide frozen template `Interp`.
  - Fix BOOT-3 and BOOT-4, which dominate the link and harden costs (a hypothesis; not profiled).
- **Confidence:** confirmed for the timings and the double build; the cost attribution is medium.

### BOOT-7 — Module execution is limited to self-contained modules, and `ModuleGraph` is an unconnected host-side model

- **Lens(es):** 3, 5, 6.
- **Proposed severity:** medium.
- **Location:**
  - `ironhorse-vm/src/interp/dispatch.rs:4843-4880` and `4936-4945`;
  - `ironhorse-vm/src/module.rs:1-55` and `640-643`;
  - `ironhorse-vm/src/compartment.rs:566-581`.
- **Excerpt:**
  ```rust
  if transfers.iter().any(|transfer| matches!(transfer.value, Payload::At(_, imported) if imported != 0)) {
      return Flow::Exit(Step::Host(Halt::NotImplemented("module:static-linking")));
  }
  ...
  if self.instance_prototype(execute_function) == self.async_function_proto {
      return Flow::Exit(Step::Host(Halt::NotImplemented("module:top-level-await")));
  }
  ...
  self.push(Slot::undefined()); // placeholder until namespace objects are wired here
  ```
- **Mechanism:**
  - The bytecode interpreter runs one module body with local or export-only transfers.
  - It refuses the following, each as `NotImplemented`:
    - any `import`;
    - `export … from`;
    - `export * as ns`;
    - dynamic `import()`;
    - `import.meta`;
    - top-level await.
  - Import attributes and JSON modules are therefore unreachable.
  - `module.rs` (1,350 lines plus `module_snapshot.rs`'s 237) separately models CyclicModuleRecord link and evaluate, namespaces and `ModuleSource` over hand-built `BodyOp`s holding primitive values. The interpreter never reads it (`ModuleGraph` is only stored in environments and snapshots).
  - The model also mishandles evaluation errors:
    - a TDZ error leaves modules in `Evaluating`;
    - a second `evaluate` returns `Ok` without re-throwing (`module.rs:640-643`; there is no `[[EvaluationError]]`);
    - `snapshot_admitted` then refuses that graph forever.
  - `export * as ns` is explicitly unmodelled (`module.rs`, the `Resolution` comment).
- **Scenario:** any multi-module program, any SES or Endo archive, or any test262 module case with an import halts.
- **Evidence:** a tally of the whole-tree expectations (module-code, import, export and dynamic-import files):
  - 1,582 `skip:unsupported-opcode:module:dynamic-import`;
  - 197 `…:module:top-level-await`;
  - 137 `…:module:static-linking`;
  - 47 `skip:module:resolution-linking`;
  - 5 `…:module:import-meta`;
  - 1,894 pass, mostly syntax and local-binding cases such as `language/module-code/instn-local-bndng-*.js`.

  Failing examples: `language/module-code/instn-iee-iee-cycle.js` and `instn-named-bndng-*.js`.
  `ironhorse-xst` refuses `-m` outright (`ironhorse_xst.rs:39-41`).
- **Recommendation:**
  - Connect `XS_CODE_MODULE`'s transfers to a real module map: per-module closure cells keyed by specifier and resolved through the compartment's graph, which replaces `BodyOp`.
  - Return a real namespace exotic object.
  - Add an `Errored` status that keeps the evaluation error.
  - Dynamic import and TLA need an async loader with deterministic job ordering. This is large: weeks.
  - Static linking of an already-registered graph is the cheapest first step.
- **Confidence:** high (static, plus the expectation counts).

### BOOT-8 — The guest `Compartment` and Hardened JavaScript surface are incomplete, and docs still say the guest Compartment does not exist

- **Lens(es):** 3, 6.
- **Proposed severity:** medium.
- **Location:**
  - `ironhorse-vm/src/interp/natives/compartment.rs:1-9`, `84-97` and `112-121`;
  - `ironhorse-vm/src/interp/realm.rs:244-253`;
  - `ironhorse-vm/src/compartment.rs:574-581`.
- **Excerpt:** from `realm.rs:247-249`: "The two that are absent presuppose a guest `Compartment`, which ironhorse does not have: the compartment-global template … and the `Math` duplicate".
  Yet `natives/compartment.rs` implements a guest `Compartment`, and `locked_down_prototypes` includes `compartment_proto` (`realm.rs:464`).
- **Mechanism:** Probe J5 (`p12_compartment_surface.js` and `p13_date_lockdown.js`) shows the following on a plain `Interp`:
  - `Compartment.prototype` keys: `["globalThis","evaluate","constructor","Symbol(Symbol.toStringTag)"]`;
  - no `import`, `importNow`, `load` or `module`;
  - `new Compartment({name:"n"}).name` gives `undefined`;
  - `ModuleSource` is `undefined`;
  - the `modules` option is validated and then dropped;
  - after `lockdown()`, `c.evaluate("Date") === Date` and `c.evaluate("Math") === Math` are both `true`, so there is no per-compartment `Date` or `Math` template.

  Present: `harden`, `petrify`, `lockdown` (the second call throws), per-compartment `eval`, `Function` and `Compartment`, and poisoned prototype constructors.
  `Date.now()` is `0`, deterministically, so the missing `Date` template leaks no time; it is a parity gap.
- **Scenario:** an Endo or SES compartment-mapper workload that calls `compartment.import()` or relies on `name`, `ModuleSource` or a module map fails.
  Together with BOOT-7, these are the concrete pieces behind README stage 4 "BAR NOT MET".
- **Evidence:** probe outputs J5.
- **Recommendation:**
  - Fix the stale `realm.rs` comment.
  - Implement the `name` getter: cheap, since `CompartmentOptions::name` already exists on the host side.
  - Add the compartment-global template (`Date`/`Math`) per `fx_lockdown`.
  - `import`, `importNow` and `ModuleSource` depend on BOOT-7.
- **Confidence:** confirmed by probe.

### BOOT-9 — Key-space exhaustion is classified as four different halts, with different commit semantics depending on the entry path

- **Lens(es):** 6 (taxonomy applied inconsistently), 1.
- **Proposed severity:** medium.
- **Location:**
  - `ironhorse-vm/src/interp/property/keys.rs:56` and `link.rs:1269-1271`: catchable `RangeError`;
  - `ironhorse-vm/src/interp/dispatch.rs:289` and `natives/promise.rs:876`: `Halt::Refused("property-key:id-space-exhausted")`;
  - `ironhorse-vm/src/interp/realm.rs:1027-1030` and `1048-1049`: `Halt::HeapExhausted`;
  - `ironhorse-vm/src/compartment.rs:783-786`: `relink_crank` error mapped to `Halt::Decode(InvalidSymbols)`.
- **Excerpt:**
  ```rust
  Some(names) => machine.relink_crank(&bytecode, names)
      .map_err(|_| Halt::Decode(crate::DecodeError::InvalidSymbols)),
  ```
  ```rust
  if !self.symbol_ids.contains_key(&name) && !self.has_guest_key_capacity(1) {
      return Err(Halt::HeapExhausted);
  }
  ```
- **Mechanism:**
  - One condition, the u16 name and symbol id spaces meeting, surfaces as:
    - a guest-catchable error;
    - a `Refused` halt, which is not `is_panic` and so is committable;
    - `HeapExhausted`, which is `is_panic` and so not committed;
    - a "malformed input" decode error, which is `is_panic` and provisional.
  - `RelinkError::TableFull` and `RelinkError::MalformedBytecode` are collapsed into the same decode error at the `Compartment` boundary.
- **Scenario:**
  - A vat whose name table is full receives a delivery through `Compartment::evaluate_with_symbols`. The supervisor sees `Decode(InvalidSymbols)` (the message is malformed) and may reject the message instead of treating the vat as resource-exhausted.
  - The same vat driven through `relink_crank` directly gets `TableFull`, and a guest-level intern gets a `RangeError`.
  - Commit and terminate decisions therefore depend on the API path, not on the condition.
- **Evidence:** static, from the cited sites and `Halt::is_panic` (`interp.rs:1796-1811`).
- **Recommendation:**
  - Define one halt for "key space exhausted", for example `Halt::Refused("property-key:id-space-exhausted")` or a dedicated variant.
  - Map `RelinkError::TableFull` to it everywhere, and keep `Decode` for genuinely malformed bytecode.
- **Confidence:** high.

### BOOT-10 — Parallel hand-maintained lists: adding one built-in method touches 5–9 lists, and a constructor about 12

- **Lens(es):** 2.
- **Proposed severity:** low.
- **Location:** traced for `Object.assign` and `Array.prototype.at`:
  1. `NativeMethod` variant: `interp/native_ids.rs:156` and `:400`.
  2. Boot registration and roster push: `interp/boot.rs:1545-1546` and `:687`.
  3. XS key-order rank: `interp/intrinsic_order.rs:479`, and `:169`/`:892` for `toSorted` on Array and `%TypedArray%`.
  4. Dispatch frame-class group: `interp/natives/dispatch.rs:2526` and `:2329`.
  5. Dispatch implementation arm: `natives/dispatch.rs:6775`, and `:4623` plus `natives/array.rs:4213`.
  6. Only when the name is an XS boot key (otherwise metering diverges): `ironhorse-meter/src/default_keys.rs:138`.
  7. Array methods: `ARRAY_UNSCOPABLES`, `interp.rs:639-656`.
  8. Methods that read members implicitly: a dependency gate in `link.rs:189-231` or `425-562`.
  9. If the method can refuse: `halt_labels.rs`.

  Regenerated artifacts:
  - the seven snapshot fixtures;
  - the inline digests in `metamorphic_determinism.rs`;
  - the fuzz seed corpus (commit `8af3bbc9`);
  - the whole-tree key-order expectations.

  A new constructor adds:
  - `Native` plus `display_name`, `arity` and `intrinsics()` (`native_ids.rs:1287`, `1350` and `1419`);
  - `GLOBAL_KEY_ORDER` (`intrinsic_order.rs:36`);
  - two `INTRINSIC_KEY_ORDER` rows;
  - the `@@toStringTag` table (`link.rs:888-971`, duplicating the `@@toStringTag` entries of `INTRINSIC_KEY_ORDER`);
  - `NOT_IMPLEMENTED_HELPER_LABELS` (`native-call:X`);
  - when it brings a new prototype field, that field in `derive_boot_fingerprint` (`boot.rs:236-324`) and the field inventory (`boot/tests.rs`).
- **Excerpt:** `("at", 1, NativeMethod::ArrayAt),` (`boot.rs:687`) and `| NativeMethod::ArrayAt` (`dispatch.rs:2329`).
- **Mechanism:** the name string, the arity, the variant, the rank and the tag live in separate tables with no single declaration.
  Only some consistency tests exist (`every_intrinsic_has_a_key_order`).
- **Scenario:** a method added without its rank is placed unranked, and its key order diverges from XS. A dependency gate that is forgotten produces BOOT-2-style holes.
- **Evidence:** static.
- **Recommendation:** use one declarative table per holder (name, arity, variant, attributes, frame class and tag) that generates the boot registration, ranks and dispatch class, as `interp_state!` already does for fields.
- **Confidence:** high.

### BOOT-11 — Duplicated and dead code in the linker and runtime adapter

- **Lens(es):** 2.
- **Proposed severity:** low.
- **Location and excerpt:** see the Duplication inventory.
  The largest items:
  - **Six identical iterator-protocol interning blocks.** These are `link.rs:448-468`, `475-485`, `494-509`, `520-530` and `544-554`, plus `natives/array.rs:606-625`. Each seeds `value_id`/`done_id` "if None". That seeding is dead: `append_name_key` (`keys.rs:155`) already refreshes the cache of every appended special name, and an existing name's cache was filled when it entered.
  - **The set-method name list is written twice** (`link.rs:199-207` and `437-445`).
  - **`install_global_intrinsic_binding` and `materialize_runtime_global` duplicate the value and flag selection** (`link.rs:235-305` and `1663-1702`).
  - **The error mapping is duplicated** across `IronhorseSourceCompiler::compile_source` and `finish_units` (`ironhorse-runtime/src/lib.rs:44-85` and `140-181`, about 45 lines).
- **Mechanism:** copy-paste families.
- **Scenario:** maintenance drift; the dead seeding hides the fact that the cache invariant moved into `append_name_key`.
- **Evidence:** static.
- **Recommendation:**
  - Replace the gates with one `implicit_reads: &[(trigger, &[names])]` table, or with fault-in, which removes them.
  - Delete the seeding blocks.
  - Have `compile_source` call `finish_units`.
- **Confidence:** high.

### BOOT-12 — Engine internals and test hooks in the public API surface

- **Lens(es):** 6, 2.
- **Proposed severity:** low.
- **Location:**
  - `ironhorse-vm/src/lib.rs:38-41`, `55-56`, `66-74` and `84-88`;
  - `compartment.rs:463-467` and `731-742`;
  - `module.rs:61` and `290-292`.
- **Excerpt:**
  ```rust
  pub use interp::{CompiledSource, EvalContext, Halt, Interp, Native, ...};
  pub use value::{BackingCommitAuthority, ..., Slot, SlotArena, SlotIndex, ...};
  #[doc(hidden)] pub mod source_scan;
  ```
- **Mechanism:**
  - `Interp`'s `link_intrinsics`, `relink_crank` and `install_test262_host` are callable by any embedder.
  - Raw `Slot` endowments are accepted by `define_global` and only refused at evaluation time, as `NotImplemented("compartment:heap-endowment")`, instead of by type.
  - `ModuleId(pub usize)` lets a caller index a graph it did not come from (`self.modules[id.0]` panics).
  - `source_scan`, a filesystem walker using `expect` that exists only for tests, is compiled into the production library.
- **Scenario:** a host misuse panics, or gets a "not implemented" verdict for an API that is actually a policy refusal (see the Ontology notes).
- **Evidence:** static.
- **Recommendation:**
  - Narrow the exports to `Machine`, `Compartment`, `Host*` and `Halt`, and move the harness entry points behind a feature.
  - Make the endowment API take `RootedValue` or primitives only.
  - Make `ModuleId` opaque.
- **Confidence:** high.

## Duplication inventory

| Family | Copies (path:line) | Size | Note |
|---|---|---|---|
| Iterator-protocol name interning plus `value_id`/`done_id` seeding | `link.rs:448-468`, `475-485`, `494-509`, `520-530`, `544-554`; `natives/array.rs:606-625` | 6 copies, ~80 lines | The seeding is dead (see BOOT-11). |
| Set-method trigger list | `link.rs:199-207`, `437-445` | 2 × 9 lines | Same seven names. |
| Global-binding value and flag selection | `link.rs:235-305` (`install_global_intrinsic_binding`); `link.rs:1663-1702` (`materialize_runtime_global`) | ~40 lines each | Intrinsic → evaluator copy / value global / `globalThis`. |
| `@@species` accessor install | `link.rs:1006-1022`, `1023-1039`, `1040-1056`; and a second mechanism, `boot.rs:2299-2321` (`create_species_accessors`, through `proto_accessors`) | 3 × 16 lines, plus 2 mechanisms | Promise, RegExp and ArrayBuffer bypass the roster that Array, Map, Set, SAB and TypedArray use. |
| `functions.iter().find_map(native/method == X)` for boot identities | `link.rs:566`, `872`, `877`, `1012`, `1029`, `1046`; `intrinsic_order.rs:1243`; `boot.rs:2300` | 8 sites | Each is O(#functions, guest closures included); should be cached fields. |
| `proto_methods.iter().find(holder, name)` | `link.rs:1079`, `1096`, `1124`, `1177`; `intrinsic_order.rs:1236` | 5 | A roster indexed by `(holder, name)` would serve all of them. |
| Well-known symbol by descriptor | `property/keys.rs:258-260` (also `well_known_symbol_property_id`, `keys.rs:226-231`); `intrinsic_order.rs:1329-1331`, `1536-1538` | 3 | Linear search. |
| Install-flag save, `catch_unwind`, restore, `resume_unwind` | `link.rs:1505-1519`, `1526-1536`; `keys.rs:244-255`; `realm.rs:938-972`; `natives/compartment.rs:132-178` | 5 | A guard type would do. |
| Lazy `create_environment` call with the `global_names` mapping closure | `compartment.rs:751-761`, `1150-1160` | 2 × 11 lines | |
| `SourceCompileError` mapping | `ironhorse-runtime/src/lib.rs:44-85`, `140-181` | 2 × ~45 lines | |
| SCC DFS (instantiate and evaluate) | `module.rs:~421-500`, `626-680` | 2 | The spec has two algorithms as well, so this is acceptable. |
| Boot-identity fields | `boot.rs:177-324` (fingerprint, about 70 hand-listed fields); `boot/tests.rs` field inventory | 2 lists | A field omitted from the fingerprint silently weakens snapshot compatibility checks. |
| Per-built-in parallel tables | see BOOT-10 | 5–12 lists | |
| `@@toStringTag` tags | `link.rs:888-971`; `INTRINSIC_KEY_ORDER` `"@@toStringTag"` entries | 2 | The tag string itself is held only in `link.rs`. |

## Skipped features and refusals inventory

| Site | What is refused or skipped | Spec status | Should support? | Effort |
|---|---|---|---|---|
| `dispatch.rs:4846`, `4938` | Dynamic `import()` (`module:dynamic-import`), 1,582 test262 cases | ES2020 | Yes; Endo depends on `compartment.import`. | Large: async loader and host hook. |
| `dispatch.rs:4849`, `4944` | `import.meta` (5 cases) | ES2020 | Yes | Small once modules link: a per-module object. |
| `dispatch.rs:4867` | Static `import` and `export … from` (`module:static-linking`, 137 cases, plus 47 `resolution-linking`) | ES2015 | Yes, first | Medium–large: wire transfers to a module map. |
| `dispatch.rs:4878` | Top-level await (197 cases) | ES2022 | Yes | Large: async module evaluation. |
| `dispatch.rs:4871`, `4874` | Module envelope without an execute function or body | n/a (shape) | Defensive | n/a |
| `dispatch.rs:4919-4923` | `fxPrepareModule` returns `undefined` instead of the module instance or namespace | XS host contract | Yes, with linking | Small |
| `module.rs` (`Resolution` comment) | `export * as ns` (namespace re-export) not modelled | ES2020 | Yes | Small, within the model |
| `module.rs:640-643` | No `[[EvaluationError]]` or errored status; re-evaluation is silent | ES2015 | Yes | Small |
| `module.rs` (`EvaluatingAsync`) | Async module status unreachable | ES2022 | With TLA | Large |
| `compartment.rs:579-581` | `Compartment::import` (host) always returns `CompartmentSkip::DynamicImport` | SES | Yes | With dynamic import |
| `compartment.rs:620-627` | Raw heap-`Slot` endowment, as `NotImplemented("compartment:heap-endowment")` | Host API | No; it is policy (use `RootedValue`) | Reclassify as Refused |
| `natives/compartment.rs:85-87` | `modules` option validated and then discarded | XS Compartment | Yes, with modules | Medium |
| `natives/compartment.rs:88-97` | `name` option read and then discarded; no `name` getter | XS Compartment | Yes | Small |
| `Compartment.prototype` (Probe J5) | `import`, `importNow`, `load`, `module` absent; `ModuleSource` global absent | XS/SES | Yes | With modules |
| `realm.rs:244-253` | Lockdown steps "compartment-global template" and `Math` duplicate (per-compartment `Date` and `Math`) | XS `fx_lockdown` | Yes, for parity (no time leak, since `Date.now()` is 0) | Small–medium |
| `natives/compartment.rs:113-117` | Guest compartments always take `global_names: None` (no attenuation option) | n/a | Optional | Small |
| `ironhorse_xst.rs:39-41` | `-m` module-goal cases refused by the plain host | Harness | Yes, once modules run | Small |
| `realm.rs:756-758` | Unfrozen Machine does not bind the engine's `lockdown` | Deliberate | Keep | n/a |

## Memory and performance opportunities

| Site | Waste | Magnitude | Fix |
|---|---|---|---|
| `link.rs:1502-1511`, `566-818` (BOOT-3) | Full roster pass per novel runtime key | 286 µs per key (5.7 s per 20k keys), plus about 0.7 ns per live function per key | Name-indexed rosters, cached identities, fault-in |
| `link.rs:313-335`, `1522` (BOOT-4) | About 65 allocating lookups per computed key | 16 µs per operation (12× slower `o[k]`) | Generation-gated catch-up; allocation-free lookups |
| `symbols.rs:25-27` | `SymbolIds::get(impl Into<SymbolName>)` allocates two `Vec`s per `&str` probe, on hot paths throughout the linker | Contributes to both rows above | Implement `Borrow<[u8]>`; look up by bytes |
| `link.rs:1403-1419`, `20-71` (BOOT-5) | O(N·M) relink and full table clone and rebind per crank | 130 ms per crank at 50k names | Hash lookup; incremental append |
| `realm.rs:725-892` (BOOT-6) | Machine built from scratch | 90 ms and 523 KB RSS per Machine | Process-wide template clone |
| `shared_persist.rs:216`, `816` (BOOT-6) | Two reference Machines built per shared restore | At least 180 ms per restore | `OnceLock` reference roots and evaluator rows |
| `property.rs:2166` → `link.rs:1587-1609` | `materialize_intrinsic_own_surface` filters all four rosters (thousands of tuples) on every `[[OwnPropertyKeys]]`, even for a plain object, before returning empty | O(roster) per `Object.keys`, measured as part of 30 µs per `Object.keys(o)` | Check `pending_surfaces`/`intrinsic_key_ranks` membership first, or use a holder → member-range index |
| `boot.rs:383-394`, `interp.rs:880` | Every native `FuncInfo` carries `name: String`, duplicating `name_chunk`. `FuncInfo` is large (an inline `Option<HostFunctionData>` and others) and lives in a `HashMap` with SipHash | About 600 natives × (24 B + a heap string) per boot, plus HashMap overhead (est. tens of KB; not measured) | Drop `name` (derive it from the chunk); box the rare `host` |
| `intrinsic_order.rs:1280-1289` | Each boot clones a ~150-entry `HashMap` of `&'static` tables | Small (µs) | `Rc` or `&'static` map shared per process |
| `link.rs:1322-1355` | Every tagged-template site in every eval or crank mints a permanent name | 1 of about 64.5k ids per site, forever | Inherent to the append-only name table; document as a key-space consumer |
| Name table (all of `link.rs` and `keys.rs`) | Runtime names are never reclaimed; relink and restore costs grow with them | See BOOT-5 | Generational or GC-able runtime keys (large) |
| `ironhorse-unicode/src/lib.rs:134-177` | Linear scan of about 690 or 800 pairs per non-ASCII identifier code point | ~1 µs per astral code point (est.) | Binary search over prefix sums (only if the lexer shows it) |

## Ontology notes

**(a) Synonyms and homonyms.**

- **"realm"** names three things:
  - the single shared `Realm` (`realm.rs:24`);
  - a compartment environment (local variables named `realm` in `create_environment`, `realm.rs:944`, and in `Compartment::execute`, `compartment.rs:749-762`);
  - per-environment state in method names (`set_realm_meter`, `detach_realm_compiler` detaching `environment.source_compiler`, `relink_unlinked_realm_program`).
  ECMA-262's Realm has one global environment. Here one Realm has many environments, which is the SES model, but the vocabulary blurs it.
- **"intrinsics"**:
  - the `Intrinsics` struct (roots plus lockdown flags, `compartment.rs:37`);
  - `Interp::intrinsics` (global constructor name → slot);
  - "intrinsic members" (the rosters);
  - `Compartment::intrinsics()`, which returns the flags struct, not the objects.
- **"globals"**:
  - `Compartment::globals` (host endowments);
  - `global_props` (bound global properties);
  - `global_names` (the binding filter);
  - `binding_names` (binding history);
  - `Compartment::global_this_keys()`, which the code and doc define as "configured named endowments" rather than `globalThis`'s keys (`compartment.rs:512-522`).
- **Compartment identity has two types.**
  - `CompartmentId(usize)` is a per-Machine counter (`global_this()`).
  - `EnvironmentId(u32)` is the global object's slot index (`snapshot_id()`).
  - A restored compartment gets a fresh counter id (`claim_compartment` sets 0 only for the start compartment), so `global_this()` equality across a restore is meaningless.
- **"Compartment" has two implementations with different option semantics.**
  - The host side keeps `name`, a module map and hook flags.
  - The guest side discards `name` and `modules` but supports `globalLexicals`, which the host side lacks (`realm.rs:70-71`).
- **"pending" has two definitions.**
  - Names above `installed_names_len` (persisted).
  - Holders in `pending_surfaces` (not persisted).
  - They disagree after a resume. This is promoted to BOOT-1.

**(b) Taxonomies.**

- **Key-space exhaustion** gets four halt classes (promoted to BOOT-9).
- **`CompartmentSkip::HeapEndowment`** is a deliberate safety policy, with a documented replacement API, yet it maps to `Halt::NotImplemented`, the skip-eligible "unported" class (`compartment.rs:620-627`).
  The sibling condition, a foreign-machine value, is `Halt::Refused("compartment:foreign-machine-value")`.
  `halt_labels.rs`'s own definitions (NotImplemented means unported; Refused means a deliberate policy limit) put it in Refused.
- **The same refusal carries two labels at two layers:** `compartment:dynamic-import` (host API) and `module:dynamic-import` (opcode).
  The test262 expectations add a third spelling (`skip:unsupported-opcode:module:dynamic-import`), and `skip:module:resolution-linking` has no engine label at all.
- **`ModuleStatus`** lacks an errored state, so the taxonomy is not exhaustive. `ModuleError` covers link errors and TDZ only; there is no evaluation-throw variant.
- **`halt_labels.rs:63`:** the comment "Custom iterator protocols and array-like interleaving are not yet modeled." sits above `"number:unmodeled"`, which it does not describe. That is a misattached classification note.

**(c) Types missing distinctions.**

- **Property key ids are a bare `u16` for both string names (counting up) and symbol keys (counting down).** The kind is recovered dynamically (`is_symbol_key_id`). Template-site and bytecode-id "names" are strings with a NUL prefix in the same space (`\0ironhorse-template-site:N`, `\0bytecode-id-N`).
- **Environments are identified by a bare `SlotIndex`** (the global object), in `inactive_environments` and `FuncInfo::global_env`.
- **The rosters key members by `&'static str`,** and `INTRINSIC_KEY_ORDER` encodes symbol keys as `"@@name"` strings.
- **`ModuleId(pub usize)` and `CellId(pub usize)` are not scoped to a graph.**

**(d) Divergences from the ECMA-262 model that a guest can observe.**

- **Intrinsic objects.**
  - The spec creates every intrinsic property at realm creation (CreateIntrinsics).
  - Ironhorse's ontology is "a member exists once its name has been interned and a pass has run". This is promoted to BOOT-1 and BOOT-2.
- **Await skips `Get(v, "constructor")` for a native promise.**
  - The spec runs `PromiseResolve` (`suspend.rs:1150-1162`). This is out of region; see the leads.
- **Modules.**
  - Module namespace objects and Module Records are not engine objects: `ModuleGraph` holds only primitive values and is never consulted.
  - `XS_CODE_MODULE` yields `undefined`.

**(e) Docs and code disagreeing.**

- `realm.rs:244-253` says ironhorse has no guest `Compartment`.
- `module.rs:50-54` lists only `dynamic-import` and `import-meta` as the named skips, omitting `static-linking`, `top-level-await`, `execute-*`.
- `lib.rs:13` says "Machine owns one frozen intrinsic graph", yet `Machine::unfrozen_with_start_global_names` exists.
- `CompartmentOptions` (`compartment.rs:284-286`) says "Endowments are copied onto the new global at construction", while `Compartment` (`compartment.rs:354`) says "Globals are allocated at first evaluation" (the code does the latter).
- `state.rs:2878-2880` claims "completing a complete surface again changes nothing" (refuted by BOOT-1).

## Leads that did not survive

- **`JSON.parse` key, then `Object.assign` onto `Object.prototype`, then for-in** (`p1_forin_shadow.js`): correct. `object_assign` converts keys through `to_read_key`, which runs the pass.
- **IteratorClose `return` on for-of `break` and destructuring, with no `return` in the source** (`p6_iterclose.js`): correct in both.
- **RegExp natives reading `flags`/`exec` implicitly** (`replaceAll`, `matchAll`, `split`, `new RegExp(re)`; `p7_regexp_flags.js`): all agree with Node, through fast paths.
- **Spy-proxy probe under the Promise, Array and RegExp prototypes** (`p5_spy_chain.js`): no extra misses observed, matching Node.
  The natives avoid these reads (see the await lead below).
- **`construct_compartment` rolling `installed_names_len` back on failure** (`natives/compartment.rs:170-172`): `create_environment` runs no install pass, so the floor never advances inside the guarded region. No resurrection path was found.
- **`HostValue` lifetime and GC:** the branded scope is invariant, and collection requires quiescence (`compartment.rs:1244-1257`), so no dangling host value mid-call.
- **`boot_fingerprint` determinism:** it sorts the HashMap-derived inputs, uses `Debug` of `f64` (exact) and is computed once per process. `intrinsic_surface_holders` is a HashSet used only for membership.
- **`Compartment::execute` endowment order:** `pending_ids` and `pending_names` are `BTreeSet`s, so the order is deterministic.
- **`ironhorse-unicode` table integrity:** the even lengths (1,372 and 1,598) and the full-domain hash test are present, and the odd-index panic is unreachable.
- **`Promise.prototype.finally` internal `[[PromiseFinally*]]` string keys** (`p15_finally_internal.js`): not visible on the closures handed to `then`; own keys are `["length","name"]`, as in Node.
- **Out of region, survived, handed off:** `await` of a native promise never reads `constructor`.
  - The code is `suspend.rs:1150-1162` (`schedule_native_await`), whose comment cites XS's `mxGetID(_constructor)` check.
  - Probe `p16_await_ctor_getter.js`: Node logs `["constructor read"]`; ironhorse logs `[]`.
  - Relevant test262 area: `language/expressions/await/` (monkey-patched `constructor` cases).
  - This belongs to the async or Promise reviewer.

---

### Probe sources

All probes are under `../probes/vm-boot-realm-modules/`.
The Rust probes were run with:

```
CARGO_TARGET_DIR=$SCRATCH/audit-target RUST_MIN_STACK=33554432 cargo test --release -p <crate> --test <name> -- --nocapture
```

The temporary test files were then deleted from the repository; copies are kept next to the JS probes.

**J1 `p2_forin_shadow_proto.js`.** Output: ironhorse `Error: ["toFixed","x"]`; node `Error: ["x"]`.

```js
var parsed = JSON.parse('{"to' + 'Fixed":1, "x":2}');
Object.setPrototypeOf(Number.prototype, parsed);
var seen = [];
for (var k in Object(1)) seen.push(k);
throw new Error(JSON.stringify(seen));
```

**J2 `p3_get_hole_replace.js`.** Output: ironhorse `{"out":"[]","afterComputedRead":"function"}`; node `{"out":"[function toFixed() ","afterComputedRead":"function"}`.

```js
var re = /a/;
re.exec = function () { var r = ["a"]; r.index = 0; r.groups = Object(1); return r; };
var out = "a".replace(re, "[$<to" + "Fixed>]");
var again = typeof Number.prototype["to" + "Fixed"];
throw new Error(JSON.stringify({ out: out.slice(0, 20), afterComputedRead: again }));
```

**J3: timing through `xst` (whole process; an empty script takes 17 ms).**

| Script | Time |
|---|---|
| `p8_novel_keys_fns0.js` (`o["k"+j]=j` × 20k) | 5.35 s |
| `p8_fns100k_only.js` (100k closures + 20k index keys) | 0.86 s |
| `p8_novel_keys_fns100k.js` | 12.40 s |
| `p9_json_keys.js` | 0.27 s |
| `p9_json_then_computed.js` | 0.88 s |
| `p9_computed_existing.js` | 0.50 s |
| node, 20k novel keys | 15 ms |

**J4: computed-read timing through `xst`.**

| Script | Time |
|---|---|
| `p11_static_read.js` | 0.61 s |
| `p11_index_read.js` | 0.62 s |
| `p11_computed_read.js` | 3.85 s |
| `p14_hasown_plain.js` | 2.59 s |
| `p14_keys_plain.js` | 3.06 s |

**J5: Compartment and Hardened JavaScript surface.**
`p12_compartment_surface.js` output: `protoKeys ["globalThis","evaluate","constructor","Symbol(Symbol.toStringTag)"]`, and:

| Check | Result |
|---|---|
| `evaluate` | `"2"` |
| `evalIdentity` | `false` |
| `import` | `undefined` |
| `importNow` | `undefined` |
| `name` | `undefined` |
| `ModuleSource` | `undefined` |
| `harden` | `true` |
| `petrify` | `function` |
| `assert` | `undefined` |
| `HandledPromise` | `undefined` |
| `lockdownAgain` | `TypeError: lockdown already called` |
| `mathRandom` | `undefined` |

`p13_date_lockdown.js` output:

| Check | Result |
|---|---|
| `nowBefore`, `nowStart`, `nowInCompartment` | `0` |
| `dateIdentity` | `true` |
| `mathIdentity` | `true` |
| `protoCtor` | `TypeError` |
| `compartmentCtorInside` | `false` |

**R1 `zz_audit_vm-boot-realm-modules_1.rs` (ironhorse-vm; output under BOOT-3, BOOT-4 and BOOT-6).**

```rust
use ironhorse_vm::{parse_symbols, Interp, Machine};
use std::time::Instant;
fn rss_kb() -> u64 { let s = std::fs::read_to_string("/proc/self/statm").unwrap();
    s.split_whitespace().nth(1).unwrap().parse::<u64>().unwrap() * 4 }
fn compile(src: &str) -> (Vec<u8>, Vec<ironhorse_vm::SymbolName>) {
    let (code, symbols) = ironhorse_compile::compile_atoms(src).unwrap(); (code, parse_symbols(&symbols)) }
fn run(src: &str) -> (f64, u64, String) {
    let (code, names) = compile(src); let mut vm = Interp::new(); vm.link_intrinsics(&names);
    let t = Instant::now(); let out = vm.run(&code); let dt = t.elapsed().as_secs_f64();
    assert!(out.completed, "{src}: {:?}", out.halt); (dt, out.computrons, out.result) }
#[test] fn boot_and_key_costs() { std::thread::Builder::new()
    .stack_size(ironhorse_vm::NATIVE_STACK_BYTES).spawn(body).unwrap().join().unwrap(); }
fn body() {
    drop(Interp::new());
    let n = 40; let t = Instant::now(); for _ in 0..n { drop(Interp::new()); }
    let boot_us = t.elapsed().as_secs_f64() * 1e6 / n as f64;
    let mut vm = Interp::new(); let stats = vm.collect_garbage().unwrap();
    println!("AUDIT interp_new_us={boot_us:.0} live_slots={} chunk_bytes={}", stats.slots_live, stats.chunk_bytes_after);
    let (code, names) = compile("0"); let t = Instant::now();
    for _ in 0..n { let mut vm = Interp::new(); vm.link_intrinsics(&names); }
    let link_us = t.elapsed().as_secs_f64() * 1e6 / n as f64;
    let mut vm = Interp::new(); vm.link_intrinsics(&names); assert!(vm.run(&code).completed);
    let stats = vm.collect_garbage().unwrap();
    println!("AUDIT new_plus_link_us={link_us:.0} live_slots_after_trivial_link={}", stats.slots_live);
    let m = 10; let t = Instant::now(); for _ in 0..m { drop(Machine::new()); }
    let machine_us = t.elapsed().as_secs_f64() * 1e6 / m as f64;
    let machine = Machine::new(); let s0 = machine.collect().unwrap();
    println!("AUDIT machine_new_us={machine_us:.0} machine_live_slots={} chunk_bytes={}", s0.slots_live, s0.chunk_bytes_after);
    let (ccode, csyms) = ironhorse_compile::compile_atoms("1").unwrap();
    let k = 50; let t = Instant::now(); let mut keep = Vec::new();
    for _ in 0..k { let c = machine.new_compartment(); let out = c.evaluate_with_symbols(&ccode, &csyms);
        assert!(out.completed, "{:?}", out.halt); keep.push(c); }
    let comp_us = t.elapsed().as_secs_f64() * 1e6 / k as f64; let s1 = machine.collect().unwrap();
    println!("AUDIT compartment_create_eval_us={comp_us:.0} slots_per_compartment={:.1} chunk_bytes_per_compartment={:.0}",
        (s1.slots_live - s0.slots_live) as f64 / k as f64, (s1.chunk_bytes_after as f64 - s0.chunk_bytes_after as f64) / k as f64);
    drop(keep);
    let before = rss_kb(); let held: Vec<Machine> = (0..20).map(|_| Machine::new()).collect(); let after = rss_kb();
    println!("AUDIT rss_per_machine_kb={:.0}", (after - before) as f64 / held.len() as f64); drop(held);
    let before = rss_kb(); let held: Vec<Interp> = (0..20).map(|_| { let mut vm = Interp::new(); vm.link_intrinsics(&names); vm }).collect();
    let after = rss_kb(); println!("AUDIT rss_per_linked_interp_kb={:.0}", (after - before) as f64 / held.len() as f64); drop(held);
    for (label, src) in [
        ("index_keys_20k", "var o = {}; for (var j = 0; j < 20000; j++) o[j] = j; 0"),
        ("novel_computed_keys_20k", "var o = {}; for (var j = 0; j < 20000; j++) o['k' + j] = j; 0"),
        ("json_parse_keys_20k", "var p = []; for (var j = 0; j < 20000; j++) p.push('\"k' + j + '\":' + j); var o = JSON.parse('{' + p.join(',') + '}'); 0"),
        ("fns_50k_then_index_keys_20k", "var f = []; for (var i = 0; i < 50000; i++) f.push(function () {}); var o = {}; for (var j = 0; j < 20000; j++) o[j] = j; 0"),
        ("fns_50k_then_novel_keys_20k", "var f = []; for (var i = 0; i < 50000; i++) f.push(function () {}); var o = {}; for (var j = 0; j < 20000; j++) o['k' + j] = j; 0"),
        ("static_reads_200k", "var p = { k: 1 }; var s = 0; for (var i = 0; i < 200000; i++) s += p.k; s"),
        ("computed_reads_200k", "var p = { k: 1 }; var k = 'k'; var s = 0; for (var i = 0; i < 200000; i++) s += p[k]; s"),
    ] { let (dt, c, r) = run(src); println!("AUDIT {label} seconds={dt:.3} computrons={c} result={r}"); }
}
```

**R2 `zz_audit_vm-boot-realm-modules_2.rs` (ironhorse-snapshot; output under BOOT-1).**
It uses `#[path = "common/twin.rs"] mod carry;` for `compile`, `crank` and `sig`:

```rust
fn twin_print(label: &str, first: &str, observation: &str) {
    let (bytecode, names) = carry::compile(first);
    let initial = || { let mut m = Interp::new(); m.link_intrinsics(&names);
        let o = m.run(&bytecode); assert!(o.completed, "{:?}", o.halt); m };
    let mut live = initial();
    let live_seen = carry::crank(&mut live, observation);
    let mut store = MemoryStore::new();
    drop(begin_store_session(initial(), &carry::sig(), &mut store).map_err(|(_, e)| e).expect("begin"));
    let mut eager = resume_from_store(&store, &carry::sig()).expect("eager resume");
    let resumed_seen = carry::crank(eager.machine_mut(), observation);
    println!("AUDIT {label} live    = {live_seen:?}");
    println!("AUDIT {label} resumed = {resumed_seen:?}");
    println!("AUDIT {label} agree   = {}", live_seen == resumed_seen);
}
// rows: ("assign", "Object.getOwnPropertyNames(Boolean.prototype); 0",
//   "var parsed = JSON.parse('{\"to' + 'Fixed\":1, \"x\":2}'); Object.setPrototypeOf(Number.prototype, parsed);
//    Boolean.prototype.zz = 1; var seen = []; for (var k in Object(1)) seen.push(k); seen.join()")
// ("define", same first crank, same observation with Object.defineProperty(Boolean.prototype, 'zz', { value: 1 }))
// ("control", "0", same observation as "assign")
```

**R3 `zz_audit_vm-boot-realm-modules_3.rs` (ironhorse-vm; output under BOOT-5).**

```rust
fn body() {
    let mut crank = String::new();
    for i in 0..200 { crank.push_str(&format!("var fresh_{i} = {i}; ")); }
    crank.push('0');
    for keys in [0usize, 10_000, 50_000] {
        let setup = format!("var p = []; for (var j = 0; j < {keys}; j++) p.push('\"k' + j + '\":0'); \
             var o = JSON.parse('{{' + p.join(',') + '}}'); 0");
        let (code, names) = compile(&setup);
        let mut vm = Interp::new(); vm.link_intrinsics(&names); assert!(vm.run(&code).completed);
        let (ccode, cnames) = compile(&crank);
        let t = Instant::now(); let relinked = vm.relink_crank(&ccode, &cnames).unwrap();
        let dt = t.elapsed().as_secs_f64() * 1e3; assert!(vm.run(&relinked).completed);
        let (c2, n2) = compile("fresh_1 + fresh_2");
        let t = Instant::now(); let r2 = vm.relink_crank(&c2, &n2).unwrap();
        let dt2 = t.elapsed().as_secs_f64() * 1e3; assert!(vm.run(&r2).completed);
        println!("AUDIT runtime_keys={keys} growing_relink_ms={dt:.2} reuse_relink_ms={dt2:.2}");
    }
}
```
