//! Program names, intrinsic installation, and crank relinking.
use super::*;

impl Interp {
    /// Derive the program-symbol tables and every name-keyed lookup-id cache
    /// from `names` (the decoded `SYMB` atom, `names[k]` = the name of id
    /// `k + 1`): the forward `symbol_names`, the inverse `symbol_ids`, the
    /// name-keyed lookup-id caches (string keys append to the table itself, so a
    /// novel key never collides), and the cached ids
    /// (`length_id`/`name_id`/… and the RegExp getter/result clusters).
    ///
    /// This is a **pure function of `names`** — it touches no arena and reads
    /// no other state — which is exactly why it is factored out of
    /// [`Self::link_intrinsics`]: [`Self::restore_snapshot_state`] calls it
    /// on the restored `symbol_names` to rebuild these tables identically to
    /// boot, without re-running the intrinsic *global-property* installation
    /// (those properties already round-trip inside the restored arena). It is
    /// the derivation that makes the SymbolTables ledger row's "rebuilt at
    /// restore" claim true, and it keeps the two callers from drifting.
    pub(super) fn bind_program_symbols(&mut self, names: &[SymbolName]) {
        *self.symbol_names = names.to_vec();
        // String keys interned at runtime APPEND to `symbol_names` (see
        // `intern_key`), so `names` here — a restored NAME row included —
        // already carries every string key the heap stores, and ids are
        // always positions. Nothing to seed: the symbol-key counter is
        // top-down and independent.
        // Cache the program-local id of `length` (XS's `mxID(_length)`) so an
        // `arr.length` get/set routes to the array length semantics.
        self.length_id = names
            .iter()
            .position(|n| n == "length")
            .map(|k| (k + 1) as u16);
        let id_of = |want: &str| names.iter().position(|n| n == want).map(|k| (k + 1) as u16);
        self.name_id = id_of("name");
        self.value_id = id_of("value");
        self.done_id = id_of("done");
        self.size_id = id_of("size");
        self.byte_length_id = id_of("byteLength");
        self.byte_offset_id = id_of("byteOffset");
        self.buffer_id = id_of("buffer");
        self.then_id = id_of("then");
        self.constructor_id = id_of("constructor");
        self.prototype_key_id = id_of("prototype");
        self.last_index_id = id_of("lastIndex");
        self.regexp_getter_ids = RegExpGetterIds {
            source: id_of("source"),
            flags: id_of("flags"),
            global: id_of("global"),
            ignore_case: id_of("ignoreCase"),
            multiline: id_of("multiline"),
            dot_all: id_of("dotAll"),
            sticky: id_of("sticky"),
            unicode: id_of("unicode"),
            has_indices: id_of("hasIndices"),
            unicode_sets: id_of("unicodeSets"),
        };
        self.regexp_result_ids = RegExpResultIds {
            index: id_of("index"),
            input: id_of("input"),
            groups: id_of("groups"),
            indices: id_of("indices"),
        };
        // Record the program-local id for every name (first occurrence wins,
        // matching the compiler's numbering), so a native built-in can relink
        // a well-known property name (`message`, `name`, …) to the id the
        // compiler assigned it in this program.
        for (k, name) in names.iter().enumerate() {
            let id = (k + 1) as u16;
            self.symbol_ids.entry(name.clone()).or_insert(id);
        }
    }

    /// Fill any special-name id cache (`length_id`/`name_id`/… and the RegExp
    /// clusters) that is still `None` from the current realm symbol table
    /// ([`Self::symbol_ids`]). The caches are seeded positionally from the
    /// **top-level** program's names ([`Self::bind_program_symbols`]); an
    /// `eval` / dynamic-`Function` unit that introduces a well-known property
    /// name the outer program never used (e.g. `length` in
    /// `Function('...r', 'return r.length')`) interns it past that range, so the
    /// exotic-property fast paths that gate on `Some(id) == self.length_id`
    /// would otherwise miss it and read the ordinary (absent) own property.
    /// Purely additive — a cache already `Some` is never changed, because the
    /// relinker maps an eval unit's shared name back to the id it already holds
    /// — so this cannot perturb top-level behavior. Called after the eval
    /// bridge relinks a unit's symbols.
    pub(super) fn refresh_special_ids_from_symbols(&mut self) {
        let id_of = |ids: &SymbolIds, want: &str| ids.get(want).copied();
        macro_rules! fill {
            ($field:expr, $name:literal) => {
                if $field.is_none() {
                    $field = id_of(&self.symbol_ids, $name);
                }
            };
        }
        fill!(self.length_id, "length");
        fill!(self.name_id, "name");
        fill!(self.value_id, "value");
        fill!(self.done_id, "done");
        fill!(self.size_id, "size");
        fill!(self.byte_length_id, "byteLength");
        fill!(self.byte_offset_id, "byteOffset");
        fill!(self.buffer_id, "buffer");
        fill!(self.then_id, "then");
        fill!(self.constructor_id, "constructor");
        fill!(self.last_index_id, "lastIndex");
        fill!(self.regexp_getter_ids.source, "source");
        fill!(self.regexp_getter_ids.flags, "flags");
        fill!(self.regexp_getter_ids.global, "global");
        fill!(self.regexp_getter_ids.ignore_case, "ignoreCase");
        fill!(self.regexp_getter_ids.multiline, "multiline");
        fill!(self.regexp_getter_ids.dot_all, "dotAll");
        fill!(self.regexp_getter_ids.sticky, "sticky");
        fill!(self.regexp_getter_ids.unicode, "unicode");
        fill!(self.regexp_getter_ids.has_indices, "hasIndices");
        fill!(self.regexp_getter_ids.unicode_sets, "unicodeSets");
        fill!(self.regexp_result_ids.index, "index");
        fill!(self.regexp_result_ids.input, "input");
        fill!(self.regexp_result_ids.groups, "groups");
        fill!(self.regexp_result_ids.indices, "indices");
    }

    /// Bind the intrinsic constructors this program references into the
    /// global object, keyed by the program-local symbol id the XS compiler
    /// assigned each name (`names[k]` is the name of id `k + 1`; see
    /// [`crate::symbols`]). Only names that match a known intrinsic are
    /// bound; everything else is left to resolve as an ordinary global (a
    /// `var`/sloppy-global) or to miss. Unmetered: these globals pre-exist
    /// the guest run exactly as XS's do, so no allocation is charged.
    pub fn link_intrinsics(&mut self, names: &[SymbolName]) {
        // The program-symbol name↔id tables and every name-keyed lookup-id
        // cache (`length_id`/`name_id`/… and the RegExp id clusters). Split
        // out because it is derived *purely* from `names` — so
        // [`Self::restore_snapshot_state`] re-derives it identically from the
        // restored `symbol_names` without re-linking intrinsics (the
        // SymbolTables ledger row's restore-time rebuild).
        self.bind_program_symbols(names);
        // OrdinaryToPrimitive reaches these properties implicitly even when
        // the guest never names either one (for example, `String(new
        // Number(3))`). Array's inherited `toString` in turn reaches `join`.
        // They are XS boot default keys, so assigning realm ids here is
        // unmetered. Include them in the full install's input/floor so their
        // intrinsic prototype methods are present from realm creation and a
        // later partial relink cannot resurrect a guest deletion.
        self.intern_key("toString");
        self.intern_key("valueOf");
        self.intern_key("join");
        // Error.prototype.toString reads these implicitly. Materialize their
        // inherited boot data even when source names neither property, so a
        // caught native TypeError does not stringify with the default Error
        // name. Including them in the install floor preserves guest deletions.
        self.intern_key("name");
        self.intern_key("message");
        // A non-guest-reachable descriptor in the persisted symbol-key table
        // marks the current arguments layout. Unlike a reserved string, this
        // cannot be pre-interned or spoofed by guest JavaScript; no property
        // uses the minted id. Reusing the table avoids a schema-only atom.
        self.intern_symbol_key(self.template_cache);
        // ArraySpeciesCreate performs an implicit `Get(original,
        // "constructor")` for Array receivers. Reify the boot-default key
        // before fixing the installed-name floor whenever an allocating
        // method is linked, so intrinsic prototype constructor properties are
        // present from realm creation and a later relink cannot resurrect a
        // guest deletion.
        if ["slice", "concat", "map", "filter"]
            .iter()
            .any(|name| self.symbol_ids.contains_key(*name))
        {
            self.intern_key("constructor");
        }
        // Promise combinators perform these property operations implicitly:
        // GetPromiseResolve(C), GetIterator, IteratorStepValue, and Invoke of
        // the returned promise's `then`. Reify their boot-default string keys
        // before the installed-name floor is fixed, exactly like Array species'
        // implicit `constructor` lookup above. Otherwise a source that names
        // only `Promise.all` can observe a hollow `%Promise%.resolve` or
        // iterator prototype even though the guest never deleted it.
        if ["all", "allSettled", "race", "any"]
            .iter()
            .any(|name| self.symbol_ids.contains_key(*name))
        {
            for name in ["resolve", "then", "next", "value", "done"] {
                self.intern_key(name);
            }
        }
        // `catch` performs Invoke(this, "then", ...), while `finally` first
        // performs SpeciesConstructor(this, %Promise%) and then the same
        // observable Invoke. These are implicit boot-default property reads.
        if ["catch", "finally"]
            .iter()
            .any(|name| self.symbol_ids.contains_key(*name))
        {
            self.intern_key("then");
            self.intern_key("constructor");
        }
        // `Promise.resolve` performs both the branded-promise constructor
        // identity read and thenable assimilation even when neither property
        // name appears in source text.
        if self.symbol_ids.contains_key("resolve") {
            self.intern_key("constructor");
            self.intern_key("then");
        }
        let names = self.symbol_names.clone();
        self.install_intrinsic_bindings(&names, 0, true, |_| true);
    }

    /// Install the global bindings, prototype methods/data, native
    /// value data, and well-known symbols for the names that `keep`
    /// admits — the reusable body of [`Self::link_intrinsics`] (called
    /// there with `full = true, |_| true`). [`Self::relink_crank`] and
    /// the `eval`/`Function` bridge call it with `full = false` and a
    /// filter that admits only the APPENDED ids, so a later unit that
    /// first references a built-in (`Math`, `arr.map`, an Intl
    /// namespace) gets it bound WITHOUT re-installing the
    /// earlier link's bindings — a re-install would clobber a guest
    /// monkeypatch or deletion of an already-linked property.
    ///
    /// `full` gates the branches that depend on NO program name — the
    /// well-known-symbol installs (`@@toStringTag` tags,
    /// `@@iterator`/`@@asyncIterator` identities, the dispose
    /// aliases): they run unconditionally on every full link, so on a
    /// relink they are always redundant, and the `keep` filter cannot
    /// gate them (symbol-key ids mint top-down from `u16::MAX`, so
    /// every one reads as "appended"). Re-running them on a relink
    /// silently reverted a crank-1 monkeypatch or deletion — and the
    /// Segments branch minted fresh iterator functions per relink
    /// (locked by `relink_preserves_guest_intrinsic_edits`). The
    /// `proto_accessors` branch is name-guarded instead: it installs
    /// when its GUARD name's id passes `keep`, so a later unit that
    /// first references `Intl` still gets the `format` accessor.
    ///
    /// Resolving ids through `symbol_ids` (rather than the positional
    /// `k + 1`) is what lets one body serve the top-level link, the
    /// relink filter, and an eval unit whose names were interned past
    /// the outer program's id range. Requires `bind_program_symbols`
    /// (or the relink) to have populated `symbol_ids` for the full
    /// name set first. Unmetered: these bindings pre-exist any guest
    /// run exactly as XS's realm does.
    pub(super) fn install_intrinsic_bindings(
        &mut self,
        names: &[SymbolName],
        names_start: usize,
        full: bool,
        keep: impl Fn(u16) -> bool,
    ) {
        let was_installing = self.installing_intrinsics;
        self.installing_intrinsics = true;
        // Consider exactly this suffix, retaining its absolute realm offset.
        // Names interned during installation remain above the new floor.
        // Copying/scanning the preceding names per runtime key was quadratic.
        self.installed_names_len = names_start + names.len();
        for name in names.iter() {
            let Some(&id) = self.symbol_ids.get(name) else {
                continue;
            };
            if !keep(id) {
                continue;
            }
            if self.global_props.contains_key(&id)
                || self.slots.get(self.global_obj).flag & XS_DONT_PATCH_FLAG != 0
            {
                continue;
            }
            if let Some(&func) = name.as_str().and_then(|name| self.intrinsics.get(name)) {
                // The global binding is an own property whose value is a
                // **reference** to the intrinsic function instance, exactly
                // like any other global property (so `get_variable` /
                // `get_this_variable` resolve a `Reference`, and `typeof`
                // sees a callable). Standard intrinsic globals are writable
                // and configurable but non-enumerable. Not metered — a
                // pre-existing global.
                let property =
                    self.create_global_property(id, (Kind::Reference, Payload::Reference(func)));
                self.slots.get_mut(property).flag |= XS_DONT_ENUM_FLAG;
            } else if let Some(v) = name.as_str().and_then(value_global) {
                // The primitive value globals `undefined`/`NaN`/`Infinity`
                // (XS's non-writable realm globals): bound as ordinary global
                // properties holding the value, so a reference reads it with
                // no built-in step (pure dispatch, bit-exact against the pin).
                // Their spec descriptor is `{writable:false, enumerable:false,
                // configurable:false}` — carry those flags so a `NaN = x`
                // sloppy assignment is the specified silent no-op and, at
                // declaration instantiation, a `function NaN(){}` fails
                // `CanDeclareGlobalFunction` ([`Self::can_declare_global_function`]).
                let prop = self.create_global_property(id, (v.kind, v.value));
                self.slots.get_mut(prop).flag |=
                    XS_DONT_DELETE_FLAG | XS_DONT_SET_FLAG | XS_DONT_ENUM_FLAG;
            } else if name == "globalThis" {
                // The realm's live `globalThis`: an own global property whose
                // value **references the global object itself** (XS's
                // `mxGlobal`, a non-configurable realm global present before
                // the guest runs, so unmetered). Because it is an ordinary
                // global property over `global_obj`, three things follow for
                // free: identifier `globalThis` resolves through the same
                // `global_props` fast index every other global uses; a
                // property read/write on it (`globalThis.x`) walks
                // `global_obj`'s own-property chain — the SAME slots a
                // `var`/sloppy-global declaration materializes and plain
                // identifier resolution sees (kept in lock-step by the
                // `global_obj` arm of `instance_put`/`delete_own_property`);
                // and the intrinsic bindings (`Object`, `Math`, …) are
                // reachable as its properties, since each is itself an own
                // property of `global_obj`. The self-reference
                // (`globalThis.globalThis === globalThis`) is exact — the
                // property's value slot points back at `global_obj`.
                let g = self.global_obj;
                let property =
                    self.create_global_property(id, (Kind::Reference, Payload::Reference(g)));
                self.slots.get_mut(property).flag |= XS_DONT_ENUM_FLAG;
            }
        }
        // The seven ES2025 "new Set methods" reach the ARGUMENT's `has`/`keys`
        // members and (through the returned iterator) `next` via `GetSetRecord`,
        // even when the program never names them textually (e.g.
        // `s1.union(new Set([2,3]))`). Those are XS boot default keys, so
        // force-interning them here — after `bind_program_symbols` populated
        // `symbol_ids` and before the prototype-method binding pass below —
        // makes the gated `Map`/`Set`/array-iterator prototype bindings fire, so
        // a native collection argument resolves `has`/`keys`/`next` through the
        // ordinary prototype chain exactly like a set-like object literal. The
        // names are all boot default keys, so interning charges no metering; the
        // widening fires only for programs that reference a set method, none of
        // which is covered before this change.
        let set_methods_used = [
            "union",
            "intersection",
            "difference",
            "symmetricDifference",
            "isSubsetOf",
            "isSupersetOf",
            "isDisjointFrom",
        ]
        .iter()
        .any(|n| self.symbol_ids.contains_key(*n));
        if set_methods_used {
            for name in [
                "size", "has", "keys", "values", "next", "done", "value", "return",
            ] {
                self.intern_key(name);
            }
            // The set methods drive a native collection's `keys()`/`values()`
            // iterator from Rust, reading the reused result object's `value`/
            // `done` own properties — which `make_collection_iterator` writes
            // only under the cached `value_id`/`done_id`. When the program never
            // spelled those names, `bind_program_symbols` left the caches `None`,
            // so the result carried no `done` and the driver spun forever. Point
            // the caches at the just-interned ids (a no-op when the program did
            // spell them, so their compiled id already wins).
            if self.value_id.is_none() {
                self.value_id = Some(self.intern_key("value"));
            }
            if self.done_id.is_none() {
                self.done_id = Some(self.intern_key("done"));
            }
        }
        let iterator_helpers_used = [
            "map", "filter", "take", "drop", "flatMap", "reduce", "toArray", "forEach", "some",
            "every", "find",
        ]
        .iter()
        .any(|name| self.symbol_ids.contains_key(*name));
        if iterator_helpers_used {
            for name in ["next", "done", "value", "return"] {
                self.intern_key(name);
            }
            if self.value_id.is_none() {
                self.value_id = Some(self.intern_key("value"));
            }
            if self.done_id.is_none() {
                self.done_id = Some(self.intern_key("done"));
            }
        }
        // `Array.from`, `Object.fromEntries`, and `AggregateError` perform the
        // full iterator protocol even when the guest source never spells
        // `next`, `value`, or `done`. Reify those boot-default names before
        // prototype-method linking so the mandatory observable
        // `Get(iterator, "next")` sees `%ArrayIteratorPrototype%.next` (and can
        // also observe an own override/getter on the returned iterator).
        if self.symbol_ids.contains_key("from")
            || self.symbol_ids.contains_key("fromEntries")
            || self.symbol_ids.contains_key("AggregateError")
        {
            for name in ["next", "done", "value", "return"] {
                self.intern_key(name);
            }
            if self.value_id.is_none() {
                self.value_id = Some(self.intern_key("value"));
            }
            if self.done_id.is_none() {
                self.done_id = Some(self.intern_key("done"));
            }
        }
        // The four collection constructors perform AddEntriesFromIterable (or
        // its Set counterpart) in native code. They therefore read `set` or
        // `add` before acquiring the iterator, then drive `next` and inspect
        // `done`/`value`, even when none of those names occurs in guest source.
        // Reify every implicit boot-default key before the prototype-method
        // linking pass so these operations use the ordinary observable
        // property path and intrinsic iterator-result objects carry fields.
        let collection_constructor_used = ["Map", "Set", "WeakMap", "WeakSet"]
            .iter()
            .any(|name| self.symbol_ids.contains_key(*name));
        if collection_constructor_used {
            for name in ["add", "set", "next", "done", "value", "return"] {
                self.intern_key(name);
            }
            if self.value_id.is_none() {
                self.value_id = Some(self.intern_key("value"));
            }
            if self.done_id.is_none() {
                self.done_id = Some(self.intern_key("done"));
            }
        }
        // `Date.prototype.toJSON` invokes the receiver's `toISOString`
        // property even when the source never names that method directly.
        // Intern it before the prototype-method pass so a Date receiver sees
        // the intrinsic and an ordinary receiver can expose an override.
        if self.symbol_ids.contains_key("toJSON") {
            self.intern_key("toISOString");
        }
        // `Map.groupBy` / `Object.groupBy` drive `GetIterator(items)` from Rust,
        // reading the produced result object's `next`/`value`/`done` — even when
        // the program never spells them (e.g. `Map.groupBy([1,2,3], fn)`). Mirror
        // the set-methods widening: force-intern those boot default keys (charges
        // no metering) and point the `value_id`/`done_id` caches at them so the
        // iterator driver reads the reused result object's own properties.
        if self.symbol_ids.contains_key("groupBy") {
            for name in ["next", "done", "value"] {
                self.intern_key(name);
            }
            if self.value_id.is_none() {
                self.value_id = Some(self.intern_key("value"));
            }
            if self.done_id.is_none() {
                self.done_id = Some(self.intern_key("done"));
            }
        }
        // `Array.fromAsync` is a native async state machine that drives the
        // iterator protocol (`next`/`value`/`done`/`length`/`return`/`then`)
        // itself, so those atoms and their intrinsic prototype methods must be
        // present even when the guest source never names them. Force-intern
        // them (and seed the id caches) when the program uses `fromAsync`, so
        // the method-linking pass below reifies e.g. `%ArrayIteratorProto%.next`
        // and intrinsic `{value, done}` result objects carry their fields.
        self.ensure_from_async_protocol_atoms();
        // Install the native prototype methods whose names this program
        // references, as own properties of their prototype (unmetered — an
        // inherited intrinsic method, present before the guest runs).
        let typed_array_ctor = self.functions.iter().find_map(|(&function, info)| {
            (info.native == Some(Native::TypedArrayBase)).then_some(function)
        });
        let typed_array_proto =
            typed_array_ctor.and_then(|constructor| self.ctor_prototype.get(&constructor).copied());
        let names_typed_array = TYPED_ARRAY_TYPES
            .iter()
            .any(|ty| self.symbol_ids.contains_key(ty.name));
        let date_ctor = self.intrinsics.get("Date").copied();
        let names_date = self.symbol_ids.contains_key("Date");
        let methods = std::mem::take(&mut self.proto_methods);
        for &(proto, mname, mfunc) in &methods {
            // Constructor `prototype` is a mandatory own property even when
            // the program reaches it reflectively through a string key rather
            // than a static `.prototype` access (and therefore has no SYMB
            // atom for the name). It is an XS boot default key, so assigning
            // its program-local id here is unmetered.
            let mid = if mname == "prototype" {
                let pid = self.intern_key(mname);
                // The canonical `prototype` key id (a boot default key,
                // present whether or not the program names it statically) —
                // the id `install_own_function_prototype`/`prototype_of` use.
                self.prototype_key_id = Some(pid);
                Some(pid)
            } else if let Some(&id) = self.symbol_ids.get(mname) {
                Some(id)
            } else if proto == self.intl_object && self.symbol_ids.contains_key("Intl") {
                // The `Intl.*` constructor and namespace-method properties are
                // reachable reflectively through a string key (e.g.
                // `verifyProperty(Intl, 'NumberFormat', {...})`) with no static
                // `.NumberFormat` access, so the member name carries no SYMB
                // atom. Mirror the `proto_accessors` guard: once the program
                // references `Intl` at all (which already aborts the Intl-less
                // oracle), force-intern the member key **without** metering so
                // `getOwnPropertyDescriptor(Intl, 'NumberFormat')` reveals the
                // real own data property. Non-Intl programs never enter this
                // branch, so their metering is untouched.
                Some(self.intern_key_unmetered(mname))
            } else if names_typed_array
                && (Some(proto) == typed_array_ctor || Some(proto) == typed_array_proto)
            {
                // `%TypedArray%` and `%TypedArray%.prototype` are not globals;
                // tests and ordinary programs reach them through the concrete
                // constructor inheritance chain and commonly name their own
                // properties with runtime strings. Materialize the complete
                // shared intrinsic surfaces once any concrete TypedArray is
                // linked, just as the reflective Intl namespace path above
                // does, so `hasOwnProperty` and descriptor operations do not
                // depend on a coincidental static `.from`/`.set` reference.
                Some(self.intern_key_unmetered(mname))
            } else if names_date && (Some(proto) == date_ctor || proto == self.date_proto) {
                // Date's constructor and prototype are likewise routinely
                // inspected through runtime strings (`hasOwnProperty`,
                // descriptor helpers, and harness utilities). Once `Date` is
                // linked, expose its complete modeled surface so reflection
                // does not depend on a coincidental static `.UTC`/`.getTime`
                // reference in the same compilation unit.
                Some(self.intern_key_unmetered(mname))
            } else {
                None
            };
            if let Some(mid) = mid {
                if !keep(mid) {
                    continue;
                }
                // A property the guest (or an earlier pass) already put
                // there wins — installs are create-only on partial passes
                // so a partial pass cannot clobber a monkeypatch whose
                // name was interned at runtime.
                if !full && self.find_property(proto, mid).is_some() {
                    continue;
                }
                let flag = if mname == "prototype" && proto == self.generator_function_proto {
                    XS_DONT_ENUM_FLAG | XS_DONT_SET_FLAG
                } else if mname == "prototype" {
                    XS_DONT_ENUM_FLAG | XS_DONT_DELETE_FLAG | XS_DONT_SET_FLAG
                } else {
                    XS_DONT_ENUM_FLAG
                };
                self.set_own_unmetered_with_flag(
                    proto,
                    mid,
                    Slot::of(Kind::Reference, Payload::Reference(mfunc)),
                    flag,
                );
            }
        }
        self.proto_methods = methods;
        // `%AsyncGeneratorPrototype%.constructor` points to `%AsyncGenerator%`
        // (the common function prototype object), not to the dynamic
        // `%AsyncGeneratorFunction%` constructor.  Its descriptor is
        // non-writable, non-enumerable, and configurable.
        if let Some(cid) = self.constructor_id {
            self.set_own_unmetered_with_flag(
                self.async_generator_proto,
                cid,
                Slot::of(
                    Kind::Reference,
                    Payload::Reference(self.async_generator_function_proto),
                ),
                XS_DONT_SET_FLAG | XS_DONT_ENUM_FLAG,
            );
        }
        // Inherited prototype data (Error `name`/`message`).
        let data = std::mem::take(&mut self.proto_data);
        for (proto, pname, value) in &data {
            if let Some(&pid) = self.symbol_ids.get(*pname) {
                if keep(pid) && (full || self.find_property(*proto, pid).is_none()) {
                    let off = self.alloc_str_text(value.as_bytes());
                    self.set_own_unmetered_with_flag(
                        *proto,
                        pid,
                        Slot::of(Kind::String, Payload::String(off)),
                        XS_DONT_ENUM_FLAG,
                    );
                }
            }
        }
        self.proto_data = data;
        // Native prototype accessor properties (`Intl.NumberFormat.prototype`'s
        // `format` getter). Installed as a real ordinary accessor property so
        // `getOwnPropertyDescriptor` reveals `{get, set: undefined,
        // enumerable: false, configurable: true}` and a `.format` read invokes
        // the getter with the receiver as `this`. Bound only when referenced.
        let accessors = std::mem::take(&mut self.proto_accessors);
        for &(proto, key, getter, setter, guard) in &accessors {
            if let ProtoAccessorKey::WellKnownSymbol(name) = key {
                if full {
                    if let Some(pid) = self.well_known_symbol_property_id(name) {
                        self.set_own_accessor_unmetered(
                            proto,
                            pid,
                            Some(Slot::of(Kind::Reference, Payload::Reference(getter))),
                            setter.map(|function| {
                                Slot::of(Kind::Reference, Payload::Reference(function))
                            }),
                        );
                    }
                }
                continue;
            }
            let ProtoAccessorKey::String(pname) = key else {
                unreachable!()
            };
            // Install only when the owning constructor is referenced (so a
            // non-Intl program's metering is untouched), then force-intern the
            // property key **without** metering — the tests read it by string,
            // so it has no atom id of its own. The GUARD name's id carries the
            // keep gate: a relinked crank or eval unit that first references
            // `Intl` (an appended id) gets the accessor, while one whose
            // earlier link already installed it does not re-install — a guest
            // redefinition of `format` survives.
            let guard_is_kept = if guard == "TypedArray" {
                TYPED_ARRAY_TYPES
                    .iter()
                    .any(|ty| self.symbol_ids.get(ty.name).copied().is_some_and(&keep))
            } else {
                self.symbol_ids.get(guard).copied().is_some_and(&keep)
            };
            let property_is_kept = self.symbol_ids.get(pname).copied().is_some_and(&keep);
            if guard_is_kept || property_is_kept {
                let pid = self.intern_key_unmetered(pname);
                if !full && self.find_property(proto, pid).is_some() {
                    continue;
                }
                self.set_own_accessor_unmetered(
                    proto,
                    pid,
                    Some(Slot::of(Kind::Reference, Payload::Reference(getter))),
                    setter.map(|function| Slot::of(Kind::Reference, Payload::Reference(function))),
                );
            }
        }
        self.proto_accessors = accessors;
        // `%Error.prototype%.stack` {get, set} (`XS_DONT_ENUM_FLAG` only —
        // enumerable: false, configurable: true), installed when the program
        // names `Error` so every other program's metering stays untouched;
        // the `stack` key is force-interned unmetered (an XS boot default
        // key, reachable reflectively by string).
        if let Some((proto, getter, setter)) = self.error_stack_accessor {
            let names_error_family = [
                "Error",
                "EvalError",
                "RangeError",
                "ReferenceError",
                "SyntaxError",
                "TypeError",
                "URIError",
                "AggregateError",
                "SuppressedError",
                "stack",
            ]
            .iter()
            .any(|n| self.symbol_ids.contains_key(*n));
            if names_error_family {
                let sid = self.intern_key_unmetered("stack");
                self.set_own_accessor_unmetered(
                    proto,
                    sid,
                    Some(Slot::of(Kind::Reference, Payload::Reference(getter))),
                    Some(Slot::of(Kind::Reference, Payload::Reference(setter))),
                );
            }
        }
        // Native numeric data properties (`Math.PI` &co.): bound as own
        // properties of their owner under the program-local id, unmetered.
        let vdata = std::mem::take(&mut self.proto_value_data);
        for (owner, pname, value) in &vdata {
            if let Some(&pid) = self.symbol_ids.get(*pname) {
                if keep(pid) && (full || self.find_property(*owner, pid).is_none()) {
                    self.set_own_unmetered(*owner, pid, *value);
                }
            }
        }
        self.proto_value_data = vdata;
        // Well-known symbols as own properties of the `Symbol` constructor.
        if let Some(&symbol_ctor) = self.intrinsics.get("Symbol") {
            let wks = std::mem::take(&mut self.well_known_symbols);
            for (name, value) in &wks {
                if let Some(&wid) = self.symbol_ids.get(*name) {
                    if keep(wid) && (full || self.find_property(symbol_ctor, wid).is_none()) {
                        // Every well-known symbol constant is immutable and
                        // non-enumerable on `%Symbol%` (ECMA-262 20.4.2):
                        // { writable: false, enumerable: false,
                        // configurable: false }.
                        self.set_own_unmetered_with_flag(
                            symbol_ctor,
                            wid,
                            *value,
                            XS_DONT_SET_FLAG | XS_DONT_ENUM_FLAG | XS_DONT_DELETE_FLAG,
                        );
                    }
                }
            }
            self.well_known_symbols = wks;
        }
        // The remaining branches depend on NO program name and run on
        // every FULL link; on a relink or eval-bridge install they are
        // redundant re-installs that would revert guest edits (see the
        // fn doc).
        if !full {
            self.installing_intrinsics = was_installing;
            return;
        }
        // `%Symbol.prototype%` and `%Date.prototype%` each have a standard
        // own `@@toPrimitive` method before guest code executes. Materialize
        // the shared key during the initial link so own-symbol enumeration
        // observes both properties even when the source never evaluates
        // `Symbol.toPrimitive` first.
        let _ = self.well_known_symbol_property_id("toPrimitive");
        // Namespace objects and ECMA-402 formatter prototypes carry a
        // `Symbol.toStringTag` string own property (writable:false,
        // enumerable:false, configurable:true — flags `DONT_SET | DONT_ENUM`,
        // but deletable), so `Object.prototype.toString` renders their
        // specified tag and a non-string guest override falls back to the
        // ordinary builtin tag.
        if let Some(tag_id) = self.well_known_symbol_property_id("toStringTag") {
            let typed_array_proto = self.functions.iter().find_map(|(&function, info)| {
                (info.native == Some(Native::TypedArrayBase))
                    .then(|| self.ctor_prototype.get(&function).copied())
                    .flatten()
            });
            let typed_array_tag_getter = self.functions.iter().find_map(|(&function, info)| {
                (info.method == Some(NativeMethod::TypedArrayToStringTagGetter)).then_some(function)
            });
            if let (Some(proto), Some(getter)) = (typed_array_proto, typed_array_tag_getter) {
                self.set_own_accessor_unmetered(
                    proto,
                    tag_id,
                    Some(Slot::of(Kind::Reference, Payload::Reference(getter))),
                    None,
                );
            }
            for (proto, tag) in [
                (self.math_object, "Math"),
                (self.arraybuffer_proto, "ArrayBuffer"),
                (self.list_format_proto, "Intl.ListFormat"),
                (self.plural_rules_proto, "Intl.PluralRules"),
                (self.segmenter_proto, "Intl.Segmenter"),
                (self.date_time_format_proto, "Intl.DateTimeFormat"),
                (self.number_format_proto, "Intl.NumberFormat"),
                (self.segment_iterator_proto, "Segmenter String Iterator"),
                (self.temporal_zoned_proto, "Temporal.ZonedDateTime"),
                (self.temporal_now_object, "Temporal.Now"),
                // `DataView.prototype[Symbol.toStringTag]` is the string
                // "DataView" with the same non-writable/non-enumerable/
                // configurable descriptor.
                (self.dataview_proto, "DataView"),
                (self.promise_proto, "Promise"),
                (self.map_iterator_proto, "Map Iterator"),
                (self.set_iterator_proto, "Set Iterator"),
                (self.regexp_string_iterator_proto, "RegExp String Iterator"),
                (self.async_generator_proto, "AsyncGenerator"),
                // The generator-family constructor prototypes each carry a
                // `Symbol.toStringTag` string (ES2024 25.2.3.1 / 25.3.3.1 /
                // 27.5.1.5), so `Object.prototype.toString` renders
                // `[object GeneratorFunction]` / `[object Generator]` /
                // `[object AsyncGeneratorFunction]` and a direct symbol read
                // returns the tag — the `%GeneratorPrototype%` /
                // `%GeneratorFunction.prototype%` / `%AsyncGeneratorFunction.prototype%`
                // metadata the intrinsic-metadata corpus pins. Only the
                // `%AsyncGeneratorPrototype%` tag was set before (above); its
                // three siblings were omitted, so every `GeneratorFunction` /
                // `AsyncGeneratorFunction` intrinsic-metadata case diverged from
                // XS on the tag and the toString rendering
                // (endojs/endo-but-for-bots#1046).
                (self.generator_proto, "Generator"),
                (self.generator_function_proto, "GeneratorFunction"),
                (
                    self.async_generator_function_proto,
                    "AsyncGeneratorFunction",
                ),
            ] {
                if proto.is_null() {
                    continue;
                }
                let off = self.alloc_str_text(tag.as_bytes());
                self.set_own_unmetered_with_flag(
                    proto,
                    tag_id,
                    Slot::of(Kind::String, Payload::String(off)),
                    XS_DONT_SET_FLAG | XS_DONT_ENUM_FLAG,
                );
            }
        }
        // `Promise[@@species]` is a configurable, non-enumerable accessor
        // whose getter returns its receiver and whose setter is undefined.
        if let (Some(species_id), Some(&promise_ctor)) = (
            self.well_known_symbol_property_id("species"),
            self.intrinsics.get("Promise"),
        ) {
            if let Some(getter) = self.functions.iter().find_map(|(&function, info)| {
                (info.method == Some(NativeMethod::PromiseSpeciesGetter)).then_some(function)
            }) {
                self.set_own_accessor_unmetered(
                    promise_ctor,
                    species_id,
                    Some(Slot::of(Kind::Reference, Payload::Reference(getter))),
                    None,
                );
            }
        }
        // `RegExp[@@species]` has the same accessor shape as Promise's but a
        // distinct getter identity.
        if let (Some(species_id), Some(&regexp_ctor)) = (
            self.well_known_symbol_property_id("species"),
            self.intrinsics.get("RegExp"),
        ) {
            if let Some(getter) = self.functions.iter().find_map(|(&function, info)| {
                (info.method == Some(NativeMethod::RegExpSpeciesGetter)).then_some(function)
            }) {
                self.set_own_accessor_unmetered(
                    regexp_ctor,
                    species_id,
                    Some(Slot::of(Kind::Reference, Payload::Reference(getter))),
                    None,
                );
            }
        }
        // `ArrayBuffer[@@species]` has the same accessor shape as Promise's
        // and RegExp's but a distinct getter identity.
        if let (Some(species_id), Some(&array_buffer_ctor)) = (
            self.well_known_symbol_property_id("species"),
            self.intrinsics.get("ArrayBuffer"),
        ) {
            if let Some(getter) = self.functions.iter().find_map(|(&function, info)| {
                (info.method == Some(NativeMethod::ArrayBufferSpeciesGetter)).then_some(function)
            }) {
                self.set_own_accessor_unmetered(
                    array_buffer_ctor,
                    species_id,
                    Some(Slot::of(Kind::Reference, Payload::Reference(getter))),
                    None,
                );
            }
        }
        if let Some(id) = self.well_known_symbol_property_id("asyncIterator") {
            self.set_own_unmetered_with_flag(
                self.instance_prototype(self.async_generator_proto),
                id,
                Slot::of(
                    Kind::Reference,
                    Payload::Reference(self.async_iterator_identity),
                ),
                XS_DONT_ENUM_FLAG,
            );
        }
        if let Some(id) = self.well_known_symbol_property_id("iterator") {
            self.set_own_unmetered_with_flag(
                self.iterator_proto,
                id,
                Slot::of(Kind::Reference, Payload::Reference(self.iterator_identity)),
                XS_DONT_ENUM_FLAG,
            );
            // Array.prototype[@@iterator] is the exact same function object as
            // Array.prototype.values. Reuse the boot method identity even when
            // source names only the symbol, so `array[Symbol.iterator]()` and
            // harness-generated iterable wrappers follow ordinary lookup.
            if let Some((_, _, values)) = self
                .proto_methods
                .iter()
                .find(|(holder, name, _)| *holder == self.array_proto && *name == "values")
                .copied()
            {
                self.set_own_unmetered_with_flag(
                    self.array_proto,
                    id,
                    Slot::of(Kind::Reference, Payload::Reference(values)),
                    XS_DONT_ENUM_FLAG,
                );
            }
            // `%TypedArray%.prototype[@@iterator]` is likewise the exact same
            // function object as its `values` method on the shared abstract
            // prototype.
            if let Some(typed_array_proto) = typed_array_proto {
                if let Some((_, _, values)) = self
                    .proto_methods
                    .iter()
                    .find(|(holder, name, _)| *holder == typed_array_proto && *name == "values")
                    .copied()
                {
                    self.set_own_unmetered_with_flag(
                        typed_array_proto,
                        id,
                        Slot::of(Kind::Reference, Payload::Reference(values)),
                        XS_DONT_ENUM_FLAG,
                    );
                }
            }
            self.set_own_unmetered_with_flag(
                self.string_proto,
                id,
                Slot::of(
                    Kind::Reference,
                    Payload::Reference(self.string_iterator_method),
                ),
                XS_DONT_ENUM_FLAG,
            );
            // Map's @@iterator is `entries`; Set's is the shared `values`
            // function. Locate the already-created boot methods directly so
            // the aliases exist even when the source never spells those
            // string keys (a Symbol.iterator-only test).
            for (proto, method_name) in [(self.map_proto, "entries"), (self.set_proto, "values")] {
                if let Some((_, _, function)) = self
                    .proto_methods
                    .iter()
                    .find(|(holder, name, _)| *holder == proto && *name == method_name)
                    .copied()
                {
                    self.set_own_unmetered_with_flag(
                        proto,
                        id,
                        Slot::of(Kind::Reference, Payload::Reference(function)),
                        XS_DONT_ENUM_FLAG,
                    );
                }
            }
            // `%Segments.prototype%[Symbol.iterator]` mints a `%SegmentIterator%`;
            // the iterator itself carries the identity `[Symbol.iterator]`
            // (`%IteratorPrototype%`) so it survives spread/`Array.from`.
            if !self.segments_proto.is_null() {
                self.set_own_unmetered_with_flag(
                    self.segments_proto,
                    id,
                    Slot::of(
                        Kind::Reference,
                        Payload::Reference(self.segments_iterator_method),
                    ),
                    XS_DONT_ENUM_FLAG,
                );
                self.set_own_unmetered_with_flag(
                    self.segment_iterator_proto,
                    id,
                    Slot::of(
                        Kind::Reference,
                        Payload::Reference(self.segment_iterator_identity),
                    ),
                    XS_DONT_ENUM_FLAG,
                );
            }
        }
        for (native, string_name, symbol_name) in [
            (Native::DisposableStack, "dispose", "dispose"),
            (Native::AsyncDisposableStack, "disposeAsync", "asyncDispose"),
        ] {
            let Some(proto) = self
                .intrinsics
                .get(native.display_name())
                .and_then(|&ctor| self.prototype_of(ctor))
            else {
                continue;
            };
            let Some(&string_id) = self.symbol_ids.get(string_name) else {
                continue;
            };
            let Some(symbol_id) = self.well_known_symbol_property_id(symbol_name) else {
                continue;
            };
            let function = self.instance_get(proto, string_id);
            if self.is_callable_value(function) {
                self.set_own_unmetered_with_flag(proto, symbol_id, function, XS_DONT_ENUM_FLAG);
            }
        }
        self.installing_intrinsics = was_installing;
    }

    /// Intern `name` into the realm's program symbol table as a **program**
    /// symbol (a name a compiled unit references), returning its stable host
    /// id and keeping the forward `symbol_names[id - 1]` entry in step with
    /// the inverse `symbol_ids` [`Self::intern_key`] maintains. A shared name
    /// resolves to the id it already holds; a novel one is appended past the
    /// current range. This is the linkage-ownership primitive the eval bridge
    /// relinks an independently-compiled unit's ids through, so the outer
    /// program and every eval unit share one realm symbol space (rather than
    /// the compiler's per-unit numbering colliding).
    pub(super) fn intern_program_symbol(&mut self, name: impl Into<SymbolName>) -> u16 {
        let name = name.into();
        let id = self.intern_key(&name);
        let idx = (id as usize).saturating_sub(1);
        if idx >= self.symbol_names.len() {
            self.symbol_names.resize(idx + 1, SymbolName::default());
        }
        self.symbol_names[idx] = name;
        id
    }

    /// Relink an independently-compiled unit's bytecode into this realm's
    /// symbol space: rewrite every symbol-id operand from the unit's
    /// program-local numbering (indexing `eval_names`, where `eval_names[k]`
    /// is the name of id `k + 1`) to the host realm id the same name holds
    /// here, interning any name the outer program never referenced.
    ///
    /// The walk is `fxReadCode`-exact ([`crate::opcode::instruction_len`]): an
    /// **ID-operand** opcode is precisely one whose `gxCodeSizes` entry is `0`
    /// ([`Opcode::size`] `== 0`), so its 2-byte operand at `pc + 1` is a
    /// symbol id; every other opcode (including the length-prefixed string /
    /// bigint literals whose payloads are data, not code) is skipped by its
    /// own instruction length. Nested function bodies are **inline** after
    /// their `XS_CODE_CODE_*` header (a fixed-size opcode, not a
    /// length-prefixed payload), so this single linear pass rewrites their
    /// ids too. Returns `None` only on a truncated/invalid stream.
    pub(super) fn relink_program_symbols(
        &mut self,
        code: &[u8],
        eval_names: &[SymbolName],
    ) -> Option<Vec<u8>> {
        let mut out = code.to_vec();
        let mut pc = 0usize;
        while pc < out.len() {
            let op = Opcode::from_u8(out[pc])?;
            let ilen = crate::opcode::instruction_len(&out, pc)?;
            if op.size() == 0 {
                let id = u16::from_le_bytes([*out.get(pc + 1)?, *out.get(pc + 2)?]);
                // Id 0 is XS's reserved `XS_NO_ID` (an anonymous function
                // name, an absent file): it names nothing, so it is left as-is.
                if id != 0 {
                    // Fail CLOSED on an id beyond the unit's own symbol
                    // atom: `relink_crank` refuses the
                    // same condition as MalformedBytecode; left in
                    // place it would denote whatever realm name holds
                    // that position.
                    let name = eval_names.get((id - 1) as usize)?.clone();
                    let host_id = self.intern_program_symbol(&name);
                    let bytes = host_id.to_le_bytes();
                    out[pc + 1] = bytes[0];
                    out[pc + 2] = bytes[1];
                }
            }
            pc += ilen;
        }
        self.rewrite_template_site_ids(&mut out).ok()?;
        Some(out)
    }

    /// Give every newly compiled tagged-template site a fresh realm key.
    ///
    /// XS's compiler uses a machine-global tag counter, while IronHorse's
    /// independently invoked compiler numbers each unit from `#0`. Ordinary
    /// name relinking would therefore make a later crank/eval alias the first
    /// unit's site. Rewrite only the compiler's hidden cache accesses — the
    /// `GET_PROPERTY` immediately after `TEMPLATE_CACHE` and its paired
    /// `SET_PROPERTY` immediately after `TEMPLATE` — so a user property whose
    /// spelling happens to be `"#0"` keeps its normal string-key identity.
    pub(super) fn rewrite_template_site_ids(&mut self, code: &mut [u8]) -> Result<(), RelinkError> {
        let mut site_order = Vec::<u16>::new();
        let mut seen = std::collections::HashSet::<u16>::new();
        let mut accesses = Vec::<(usize, u16)>::new();
        let mut previous = None;
        let mut pc = 0usize;
        while pc < code.len() {
            let op = Opcode::from_u8(code[pc]).ok_or(RelinkError::MalformedBytecode)?;
            let ilen =
                crate::opcode::instruction_len(code, pc).ok_or(RelinkError::MalformedBytecode)?;
            let cache_get = previous == Some(Opcode::XS_CODE_TEMPLATE_CACHE)
                && op == Opcode::XS_CODE_GET_PROPERTY;
            let cache_set =
                previous == Some(Opcode::XS_CODE_TEMPLATE) && op == Opcode::XS_CODE_SET_PROPERTY;
            if cache_get || cache_set {
                let a = *code.get(pc + 1).ok_or(RelinkError::MalformedBytecode)?;
                let b = *code.get(pc + 2).ok_or(RelinkError::MalformedBytecode)?;
                let old = u16::from_le_bytes([a, b]);
                if cache_get && seen.insert(old) {
                    site_order.push(old);
                }
                if cache_set && !seen.contains(&old) {
                    return Err(RelinkError::MalformedBytecode);
                }
                accesses.push((pc, old));
            }
            previous = Some(op);
            pc += ilen;
        }

        if self.symbol_names.len().saturating_add(site_order.len())
            >= self.next_symbol_key_id as usize
        {
            return Err(RelinkError::TableFull);
        }
        let mut sites = std::collections::HashMap::<u16, u16>::new();
        for old in site_order {
            // NUL keeps this internal name visually distinct in diagnostics.
            // Absence is checked so even an adversarial earlier runtime
            // string cannot make two sites share an id.
            let mut nonce = self.symbol_names.len();
            let name = loop {
                let candidate = format!("\0ironhorse-template-site:{nonce}");
                if !self.symbol_ids.contains_key(&candidate) {
                    break candidate;
                }
                nonce = nonce.checked_add(1).ok_or(RelinkError::TableFull)?;
            };
            sites.insert(old, self.append_name_key(&name));
        }
        for (pc, old) in accesses {
            let fresh = *sites.get(&old).ok_or(RelinkError::MalformedBytecode)?;
            let bytes = fresh.to_le_bytes();
            code[pc + 1] = bytes[0];
            code[pc + 2] = bytes[1];
        }
        Ok(())
    }

    /// Relink a later crank COMPILED AGAINST ITS OWN symbol table onto
    /// this machine's persisted table (side-table ledger G2: the
    /// per-crank relinking lift). Program-symbol ids are 1-based table
    /// positions, so a crank whose compiled table differs from the
    /// machine's would silently bind the wrong globals and properties;
    /// before this, such a crank was refused outright. Relinking makes
    /// it run correctly instead: each crank name resolves to its
    /// existing machine id or extends the table (append-only — every
    /// id already stored in heap slot records keeps its meaning), and
    /// every ID operand in the bytecode is rewritten through that map
    /// ([`crate::opcode::remap_ids`]; nested function bodies included).
    /// On extension the derived caches re-bind exactly as boot does.
    ///
    /// Refused fail-closed when the crank would EXTEND the table and
    /// the heap STORES a runtime-interned id (a novel dynamic property
    /// key or a symbol key, minted past the program table): the
    /// appended ids come out of the range those occupy, and re-keying
    /// them is the heap-wide id remap XS performs at snapshot load —
    /// the ledger's KEYS row, not this lift. A crank that only
    /// REORDERS onto names the table already holds moves nothing in the
    /// id space and is never refused. A crank referencing ids beyond
    /// its own table, or bytecode the walker cannot decode, is refused
    /// as malformed.
    pub fn relink_crank(
        &mut self,
        bytecode: &[u8],
        crank_names: &[SymbolName],
    ) -> Result<Vec<u8>, RelinkError> {
        if crank_names == self.symbol_names.as_slice() {
            let mut remapped = bytecode.to_vec();
            self.rewrite_template_site_ids(&mut remapped)?;
            self.install_pending_intrinsics();
            return Ok(remapped);
        }
        let old_len = self.symbol_names.len();
        let mut extended = self.symbol_names.clone();
        let mut map: Vec<u16> = Vec::with_capacity(crank_names.len());
        for name in crank_names {
            let id = match extended.iter().position(|n| n == name) {
                Some(k) => (k + 1) as u16,
                None => {
                    if extended.len().saturating_add(1) >= self.next_symbol_key_id as usize {
                        return Err(RelinkError::TableFull);
                    }
                    extended.push(name.clone());
                    extended.len() as u16
                }
            };
            map.push(id);
        }
        // Growing the table cannot alias any interned id: string keys
        // live IN the table (appended at intern time, so a crank name
        // equal to a runtime-minted name resolves to the minted id — the
        // aliasing-free outcome), and symbol-key ids are allocated
        // top-down from `u16::MAX`, far above any table position until
        // the spaces meet — which the `TableFull` bound above refuses.
        // The old shared-counter design had to refuse extension whenever
        // a runtime-interned id was STORED; the split id space retires
        // that refusal entirely.
        let mut remapped = crate::opcode::remap_ids(bytecode, |id| {
            if id == 0 {
                // XS_NO_ID: the "no name" sentinel, never a table
                // position.
                return Some(0);
            }
            map.get(id as usize - 1).copied()
        })
        .ok_or(RelinkError::MalformedBytecode)?;
        if extended.len() != old_len {
            // The table grew: re-derive the inverse table, the intern
            // counter, and every name-keyed lookup-id cache. The
            // install pass below then covers the appended ids along
            // with any older above-floor backlog.
            if old_len == 0 {
                // Initial relinking must establish the implicit keys and
                // current-layout marker, or restore mistakes this current
                // machine for a legacy layout and changes allocation order.
                self.link_intrinsics(&extended);
                if self.id_space_exhausted {
                    return Err(RelinkError::TableFull);
                }
            } else {
                self.bind_program_symbols(&extended);
            }
        }
        self.rewrite_template_site_ids(&mut remapped)?;
        self.install_pending_intrinsics();
        Ok(remapped)
    }

    /// The create-only partial install pass over every id ABOVE the
    /// installed-names floor — names no install pass has considered:
    /// ids this relink appended, names interned DURING an earlier
    /// pass (the `format` accessor key, the Intl member keys), and
    /// names the guest interned itself (a `JSON.parse` key, a
    /// defineProperty key). Run on EVERY relink, aligned or not: a
    /// crank that first references such a name must get it bound
    /// exactly as a fresh link would. Gating the pass
    /// on table GROWTH left non-growing cranks reading `undefined`
    /// where the next growing crank read the binding — the
    /// deferred-install divergence the Intl carry's twins caught.
    /// Create-only (a property or global the guest already holds
    /// wins), and the pass advances the floor, so each id is
    /// considered exactly once and the aligned hot path pays one
    /// length comparison once the backlog is empty.
    pub(super) fn install_pending_intrinsics(&mut self) {
        if self.symbol_names.len() <= self.installed_names_len {
            return;
        }
        let floor = self.installed_names_len;
        let names = self.symbol_names[floor..].to_vec();
        self.install_intrinsic_bindings(&names, floor, false, move |id| (id as usize) > floor);
    }

    /// Ensure `inst` exposes every modeled string-named own intrinsic before
    /// `[[OwnPropertyKeys]]` observes it. A constructor reached through a
    /// runtime-computed global name can exist before any of its member names
    /// entered the program symbol table. Direct property access installs one
    /// requested name, but own-key reflection must reveal the whole surface.
    ///
    /// Existing ids are only collected, never reinstalled: if guest code has
    /// already deleted or replaced an intrinsic property, its id lies at or
    /// below `installed_names_len` and the partial install leaves that edit
    /// alone. Newly interned names describe boot properties that have never
    /// been observable in this machine, so their create-only installation is
    /// sound and unmetered.
    pub(super) fn materialize_intrinsic_own_surface(&mut self, inst: crate::value::SlotIndex) {
        // Materialization is boot work, never authority to extend a sealed object.
        if self.slots.get(inst).flag & XS_DONT_PATCH_FLAG != 0 {
            return;
        }
        let mut member_names: Vec<&'static str> = self
            .proto_methods
            .iter()
            .filter_map(|(owner, name, _)| (*owner == inst).then_some(*name))
            .chain(
                self.proto_data
                    .iter()
                    .filter_map(|(owner, name, _)| (*owner == inst).then_some(*name)),
            )
            .chain(
                self.proto_value_data
                    .iter()
                    .filter_map(|(owner, name, _)| (*owner == inst).then_some(*name)),
            )
            .chain(
                self.proto_accessors
                    .iter()
                    .filter_map(|(owner, key, _, _, _)| match key {
                        ProtoAccessorKey::String(name) if *owner == inst => Some(*name),
                        _ => None,
                    }),
            )
            .collect();
        if self.intrinsics.get("Symbol").copied() == Some(inst) {
            member_names.extend(self.well_known_symbols.iter().map(|(name, _)| *name));
        }
        if self
            .error_stack_accessor
            .is_some_and(|(owner, _, _)| owner == inst)
        {
            member_names.push("stack");
        }
        if inst == self.global_obj {
            member_names.extend(self.intrinsics.keys().copied());
            member_names.extend(["undefined", "NaN", "Infinity", "globalThis"]);
        }
        if member_names.is_empty() {
            return;
        }
        // Complete symbol-keyed boot surfaces before own-key reflection or
        // integrity operations. Interning once also preserves later deletions.
        let descriptors: Vec<_> = self
            .well_known_symbols
            .iter()
            .filter_map(|(_, value)| {
                if let Payload::Reference(descriptor) = value.value {
                    Some(descriptor)
                } else {
                    None
                }
            })
            .collect();
        for descriptor in descriptors {
            self.intern_symbol_key(descriptor);
        }
        member_names.sort_unstable();
        member_names.dedup();
        let floor = self.installed_names_len;
        for name in member_names {
            self.intern_key_unmetered(name);
        }
        if self.symbol_names.len() > floor {
            let names = self.symbol_names[floor..].to_vec();
            self.install_intrinsic_bindings(&names, floor, false, move |id| (id as usize) > floor);
        }
    }

    /// String-key creation order for a standard intrinsic object's modeled
    /// boot properties. XS creates callable members in case-insensitive name
    /// order, followed by data constants in their declaration order. The VM's
    /// native-function allocation order is an implementation detail and must
    /// not leak through `[[OwnPropertyKeys]]`.
    pub(super) fn intrinsic_own_string_order(
        &self,
        inst: crate::value::SlotIndex,
    ) -> Option<Vec<u16>> {
        if !self.intrinsics.values().any(|owner| *owner == inst) {
            return None;
        }
        let mut callable_names: Vec<&'static str> = self
            .proto_methods
            .iter()
            .filter_map(|(owner, name, _)| {
                (*owner == inst && !matches!(*name, "length" | "name" | "prototype"))
                    .then_some(*name)
            })
            .chain(
                self.proto_accessors
                    .iter()
                    .filter_map(|(owner, key, _, _, _)| match key {
                        ProtoAccessorKey::String(name)
                            if *owner == inst
                                && !matches!(*name, "length" | "name" | "prototype") =>
                        {
                            Some(*name)
                        }
                        _ => None,
                    }),
            )
            .collect();
        // `sort_by_cached_key`, not `sort_unstable_by_key`: the key allocates a
        // String and the unstable form re-evaluates it on every comparison.
        // The stable sort also pins the order of two names that differ only in
        // case to their source order, rather than leaving it to the sort.
        callable_names.sort_by_cached_key(|name| name.to_ascii_lowercase());
        callable_names.dedup();

        let mut names = callable_names;
        for (owner, name, _) in &self.proto_data {
            if *owner == inst && !names.contains(name) {
                names.push(*name);
            }
        }
        for (owner, name, _) in &self.proto_value_data {
            if *owner == inst && !names.contains(name) {
                names.push(*name);
            }
        }
        if self.intrinsics.get("Symbol").copied() == Some(inst) {
            for (name, _) in &self.well_known_symbols {
                if !names.contains(name) {
                    names.push(*name);
                }
            }
        }
        Some(
            names
                .into_iter()
                .filter_map(|name| self.symbol_ids.get(name).copied())
                .collect(),
        )
    }

    /// Materialize a standard global when its name first enters the runtime
    /// key table through reflection rather than an identifier atom. Intrinsic
    /// global properties pre-exist guest execution in ECMAScript, so this is
    /// unmetered and carries the standard writable/non-enumerable/configurable
    /// data-property shape. The caller invokes this only for a newly interned
    /// name: once a guest deletes the property, the existing key prevents a
    /// later lookup from resurrecting it. The name and property (or its
    /// deletion) then travel through the ordinary snapshot tables.
    pub(super) fn materialize_runtime_global(&mut self, id: u16, name: &str) {
        if self.global_obj.is_null()
            || self.global_props.contains_key(&id)
            || self.slots.get(self.global_obj).flag & XS_DONT_PATCH_FLAG != 0
        {
            return;
        }
        let value = if let Some(function) = self.intrinsics.get(name).copied() {
            Some(Slot::of(Kind::Reference, Payload::Reference(function)))
        } else if let Some(value) = value_global(name) {
            Some(value)
        } else if name == "globalThis" {
            Some(Slot::of(
                Kind::Reference,
                Payload::Reference(self.global_obj),
            ))
        } else {
            None
        };
        let Some(value) = value else { return };
        let property = self.create_global_property(id, (value.kind, value.value));
        if value_global(name).is_some() {
            self.slots.get_mut(property).flag |=
                XS_DONT_DELETE_FLAG | XS_DONT_SET_FLAG | XS_DONT_ENUM_FLAG;
        } else {
            self.slots.get_mut(property).flag |= XS_DONT_ENUM_FLAG;
        }
    }
}
