//! Property keys, descriptors, indexed storage, proxy traps, and object integrity.
use super::*;

impl Interp {
    /// Intern a runtime string property name into the global key table
    /// (XS's `fxNewNameX`/`fxAt`), returning its stable id. The table is the
    /// one reconciliation point the program symbols, XS's boot-time default
    /// keys, and runtime-created names all share:
    ///
    /// * A name already interned — a program symbol (in `symbol_ids` from the
    ///   compiler's atom) or a previously-seen runtime key — returns its id
    ///   with **no** allocation.
    /// * A name that is one of XS's boot-time default keys (`gxIDStrings`) is
    ///   pre-interned at machine creation, so it too returns an id with no
    ///   allocation — it is merely assigned ironhorse's next program-local id the
    ///   first time it is seen (ironhorse numbers ids program-locally, so the id
    ///   value itself is arbitrary; only its stability and the metering
    ///   matter).
    /// * A genuinely-novel name allocates one key slot (`fxFindKey` →
    ///   `fxNewSlot`), metered as one slot allocation (`XS_SLOT_ALLOCATION_
    ///   METERING`), exactly as XS charges when the name misses the table.
    pub(super) fn intern_key(&mut self, name: impl Into<SymbolName>) -> u16 {
        let name = name.into();
        if let Some(&id) = self.symbol_ids.get(&name) {
            return id;
        }
        let id = self.append_name_key(&name);
        if !name.as_str().is_some_and(|s| self.default_keys.contains(s)) {
            // A name absent from XS's boot key table misses `nameTable`, so
            // `fxNewNameX` calls `fxFindKey` → `fxNewSlot`: one metered slot.
            self.meter.tick_slot_alloc();
        }
        if let Some(text) = name.as_str() {
            self.materialize_runtime_global(id, text);
        }
        id
    }

    /// Append a novel string key to the name table and hand out its id (the
    /// new table position). The table IS the persisted id→name map (the NAME
    /// row), so a key interned here round-trips a snapshot with its id — the
    /// unification that retired the string-key half of the old runtime-intern
    /// persistence refusal. Saturates at the symbol-key floor when the two id
    /// spaces meet (the exhaustion hazard documented on
    /// [`Self::next_symbol_key_id`]).
    pub(super) fn append_name_key(&mut self, name: impl Into<SymbolName>) -> u16 {
        let name = name.into();
        let next = self.symbol_names.len().saturating_add(1);
        if next >= self.next_symbol_key_id as usize {
            // The id spaces met: poison the machine and hand the CURRENT
            // operation a saturated placeholder. The placeholder aliases,
            // but the dispatch loop halts on the latch before the next
            // instruction and the managed lifecycle rewinds the crank, so
            // the alias is never guest-observable or persisted.
            self.id_space_exhausted = true;
            let id = self.next_symbol_key_id;
            self.symbol_ids.insert(&name, id);
            return id;
        }
        let id = next as u16;
        self.symbol_names.push(name.clone());
        self.symbol_ids.insert(&name, id);
        // Keep the name-keyed special-id caches in lockstep with the
        // table: a restore re-derives them from the FULL persisted
        // table (`bind_program_symbols`), so a live machine that
        // interned a cached name ("length", "value", …) without
        // seeding its cache would gate the exotic fast paths
        // differently from its own resumed twin — a result AND
        // computron divergence, checked by
        // `runtime_interned_special_name_gates_like_resumed`. The
        // refresh is additive (fills only `None` caches) and O(a few
        // map lookups) on the rare novel-intern path.
        self.refresh_special_ids_from_symbols();
        id
    }

    /// Intern a property key **without** metering — for a realm-boot property
    /// XS builds off the guest meter (the `Intl.NumberFormat.prototype.format`
    /// accessor key), and for an id IronHorse needs internally where XS reaches
    /// the same property without minting a key at all (`JSON.stringify`'s
    /// array-index walk). Returns the existing id if the name is already
    /// interned, so a program that also names the key keeps the compiler's atom
    /// id.
    pub(super) fn intern_key_unmetered(&mut self, name: impl Into<SymbolName>) -> u16 {
        let name = name.into();
        if let Some(&id) = self.symbol_ids.get(&name) {
            return id;
        }
        self.append_name_key(&name)
    }

    /// The program-local property **id** a symbol value is keyed under (XS's
    /// `mxID(symbol)` — a symbol already carries its id there; here a symbol's
    /// descriptor-slot identity is minted a stable id on first key-use). The
    /// same symbol (same descriptor slot) always resolves the same id, so
    /// `o[sym]` round-trips and `sym1 === sym2` implies same key. No metering:
    /// the symbol was already allocated (its descriptor slot); using it as a
    /// key allocates no new name slot in XS (`mxID` is a field read). The id is
    /// drawn from the top-down [`Self::next_symbol_key_id`] counter, so it never
    /// collides with a string key or a program symbol.
    pub(super) fn intern_symbol_key(&mut self, desc: crate::value::SlotIndex) -> u16 {
        let (id, newly_interned) = if let Some(&id) = self.symbol_key_ids.get(&desc) {
            (id, false)
        } else if (self.next_symbol_key_id as usize) <= self.symbol_names.len().saturating_add(1) {
            // Same poison latch as `append_name_key`: the placeholder id
            // aliases, but the loop-top halt fires before the next
            // instruction, so it never leaks to a completed crank.
            self.id_space_exhausted = true;
            let id = self.next_symbol_key_id;
            self.symbol_key_ids.insert(desc, id);
            (id, true)
        } else {
            let id = self.next_symbol_key_id;
            self.classes.1.mark(SnapshotSection::Symbols.mask());
            self.next_symbol_key_id -= 1;
            self.symbol_key_ids.insert(desc, id);
            (id, true)
        };
        // Symbol-keyed boot properties are materialized the first time the
        // realm interns their key. Re-running this on every lookup would
        // resurrect a guest deletion; an existing key proves the initial
        // materialization pass already happened (and snapshot rows preserve
        // either the property or its deletion).
        if newly_interned {
            self.install_well_known_symbol_property(desc, id);
        }
        id
    }

    /// Resolve a realm well-known symbol to the property id used by ordinary
    /// object lookup. The descriptor identity, rather than its description,
    /// is the key, so a guest-created `Symbol("iterator")` remains distinct
    /// from `Symbol.iterator`.
    pub(super) fn well_known_symbol_property_id(&mut self, name: &str) -> Option<u16> {
        let descriptor = self
            .well_known_symbols
            .iter()
            .find_map(|(symbol_name, value)| (*symbol_name == name).then_some(value.value))?;
        match descriptor {
            Payload::Reference(descriptor) => Some(self.intern_symbol_key(descriptor)),
            _ => None,
        }
    }

    /// Materialize symbol-keyed boot properties whose function identity was
    /// minted below `boot_slot_count` but whose property id must remain lazy.
    pub(super) fn install_well_known_symbol_property(
        &mut self,
        descriptor: crate::value::SlotIndex,
        id: u16,
    ) {
        let well_known_name = self.well_known_symbols.iter().find_map(|(name, value)| {
            (value.value == Payload::Reference(descriptor)).then_some(*name)
        });
        // `Array.prototype[@@unscopables]` (ECMA-262 23.1.3.35) is the one
        // well-known-symbol boot property that is **data**, not a method: a
        // null-prototype object whose keys are the array methods added after
        // ES5, each `true`, so `with (anArray) { keys }` sees the outer `keys`
        // rather than the method. It is built here rather than through the
        // method table below.
        if well_known_name == Some("unscopables") {
            if self.array_proto.is_null()
                || self.slots.get(self.array_proto).flag & XS_DONT_PATCH_FLAG != 0
                || self.find_property(self.array_proto, id).is_some()
            {
                return;
            }
            let list = self
                .slots
                .alloc(Slot::instance(crate::value::SlotIndex::NULL));
            for name in ARRAY_UNSCOPABLES {
                let key = self.intern_key_unmetered(name);
                // `CreateDataPropertyOrThrow`: writable, enumerable and
                // configurable all true — flag 0.
                self.set_own_unmetered_with_flag(list, key, Slot::boolean(true), 0);
            }
            // The property itself is {writable: false, enumerable: false,
            // configurable: true}.
            self.set_own_unmetered_with_flag(
                self.array_proto,
                id,
                Slot::of(Kind::Reference, Payload::Reference(list)),
                XS_DONT_SET_FLAG | XS_DONT_ENUM_FLAG,
            );
            return;
        }
        let installs = match well_known_name {
            Some("hasInstance") => vec![(
                self.function_proto,
                self.function_has_instance_method,
                "boot Function.prototype @@hasInstance method",
                XS_DONT_SET_FLAG | XS_DONT_ENUM_FLAG | XS_DONT_DELETE_FLAG,
            )],
            Some("toPrimitive") => vec![
                (
                    self.symbol_proto,
                    self.symbol_to_primitive_method,
                    "boot Symbol.prototype @@toPrimitive method",
                    XS_DONT_SET_FLAG | XS_DONT_ENUM_FLAG,
                ),
                (
                    self.date_proto,
                    self.date_to_primitive_method,
                    "boot Date.prototype @@toPrimitive method",
                    XS_DONT_SET_FLAG | XS_DONT_ENUM_FLAG,
                ),
            ],
            Some("replace") => vec![(
                self.regexp_proto,
                self.regexp_replace_method,
                "boot RegExp.prototype @@replace method",
                XS_DONT_ENUM_FLAG,
            )],
            Some("match") => vec![(
                self.regexp_proto,
                self.regexp_match_method,
                "boot RegExp.prototype @@match method",
                XS_DONT_ENUM_FLAG,
            )],
            Some("matchAll") => vec![(
                self.regexp_proto,
                self.regexp_match_all_method,
                "boot RegExp.prototype @@matchAll method",
                XS_DONT_ENUM_FLAG,
            )],
            Some("search") => vec![(
                self.regexp_proto,
                self.regexp_search_method,
                "boot RegExp.prototype @@search method",
                XS_DONT_ENUM_FLAG,
            )],
            Some("split") => vec![(
                self.regexp_proto,
                self.regexp_split_method,
                "boot RegExp.prototype @@split method",
                XS_DONT_ENUM_FLAG,
            )],
            _ => return,
        };
        for (owner, method, label, flags) in installs {
            if self.find_property(owner, id).is_some()
                || self.slots.get(owner).flag & XS_DONT_PATCH_FLAG != 0
            {
                continue;
            }
            assert!(!method.is_null(), "{label}");
            self.set_own_unmetered_with_flag(
                owner,
                id,
                Slot::of(Kind::Reference, Payload::Reference(method)),
                flags,
            );
        }
    }

    /// Whether property id `id` was minted for a **symbol** key (present as a
    /// value in [`Self::symbol_key_ids`]) — so the string-key enumerations
    /// (`Object.keys` / `Reflect.ownKeys`) can partition it out. The symbol-key
    /// set is empty until a symbol is first used as a key, so this is a no-op
    /// (always `false`) for a program that never keys by symbol.
    pub(super) fn is_symbol_key_id(&self, id: u16) -> bool {
        !self.symbol_key_ids.is_empty() && self.symbol_key_ids.values().any(|&v| v == id)
    }

    /// Scalar-only dispatch for array indices and built-in names.
    /// Guest-visible keys must use `property_key_slot` instead.
    pub(super) fn scalar_key_text(&self, id: u16) -> Option<String> {
        // O(1) through the forward table. `append_name_key` assigns
        // `id = symbol_names.len() + 1` after pushing, so the name for `id`
        // is `symbol_names[id - 1]`; a symbol key's id comes from the
        // top-down floor and falls off the end, which is the `None` this
        // wants anyway.
        //
        // This was a linear scan of the whole intern table, on a helper that
        // every index-name resolution calls. Cheap while only exotic paths
        // used it; with an ordinary object's index properties resolving
        // through it, a 70,000-key object turned it quadratic.
        let name = self.symbol_names.get((id as usize).checked_sub(1)?)?;
        // The two tables must agree before this is the name: the
        // exhausted-id-space placeholder inserts into `symbol_ids` without
        // pushing here, and must not resolve to whatever sits at that index.
        (self.symbol_ids.get(name) == Some(&id))
            .then(|| name.to_text())
            .flatten()
    }

    /// Resolve a property key `Slot` (string or symbol) to its interned id for
    /// the property-op surface, or `None` when the key is out of the covered
    /// grammar. A **symbol** key routes through [`Self::intern_symbol_key`]
    /// (its descriptor-slot identity). A **string** key interns as a name,
    /// applying the boot-default-key soundness gate when `gate_default` is set
    /// (a boot default-key name the program never symbol-referenced could be an
    /// unlinked inherited built-in, so a chain-walking `has`/`get` or an
    /// own-property create under an ambiguous id would risk a wrong answer — the
    /// same gate `XS_CODE_IN`/`resolve_at_key` apply); an index-valued string
    /// stays out (the exotic index behavior). A pure own-read
    /// (`getOwnPropertyDescriptor`) passes `gate_default = false`: an own miss is
    /// soundly `undefined`. Returns `None` for any other key kind.
    pub(super) fn property_key_id(&mut self, key: Slot, gate_default: bool) -> Option<u16> {
        match key.kind {
            Kind::Symbol => match key.value {
                Payload::Reference(desc) => Some(self.intern_symbol_key(desc)),
                _ => None,
            },
            Kind::String => {
                let s = match key.value {
                    Payload::String(off) => SymbolName::from_units(&self.str_units(off)),
                    _ => return None,
                };
                if gate_default
                    && !self.symbol_ids.contains_key(&s)
                    && s.as_str().is_some_and(|s| self.default_keys.contains(s))
                {
                    return None;
                }
                Some(self.intern_key(&s))
            }
            _ => None,
        }
    }

    /// Resolve a computed key at an `AT`/`AT_2` opcode, **interning** a
    /// genuinely-novel string name through the global intern table (XS's
    /// `fxNewNameX`/`fxNewName` in the `XS_CODE_AT_ALL` string branch). This
    /// never returns `None` for a string key: a
    /// non-index name that misses the symbol table is interned (metering one
    /// `fxNewSlot` key slot for a novel name, none for a boot default or a
    /// prior key — exactly [`Self::intern_key`]), so `o[k]` for any string `k`
    /// resolves to a named key rather than self-naming. A string that parses
    /// as an array index routes to the index item and, matching XS's
    /// `if (flag) the->meterIndex += 2 * XS_CODE_METERING`, meters two extra
    /// code units. Integer/number index keys and the negative/non-index
    /// numeric-name cases (which XS reaches through the same `mxToString` +
    /// `fxNewName` path) are handled identically. The remaining primitive
    /// values use their `ToString` spelling; references have already passed
    /// through `ToPrimitive` in the opcode dispatch above this helper.
    pub(super) fn resolve_at_key(&mut self, key: Slot) -> Option<Slot> {
        match key.kind {
            Kind::At => Some(key),
            Kind::Integer => {
                let i = match key.value {
                    Payload::Integer(i) => i,
                    _ => return None,
                };
                if i >= 0 {
                    Some(Slot::of(
                        Kind::At,
                        Payload::At(crate::value::XS_NO_ID, i as u32),
                    ))
                } else {
                    // A negative integer names a string key ("-1"): XS's
                    // `mxToString` + `fxNewName` interns it (no index branch).
                    let name = number_to_ecma_string(i as f64);
                    let id = self.intern_key(&name);
                    Some(Slot::of(Kind::At, Payload::At(id, 0)))
                }
            }
            Kind::Number => {
                let n = match key.value {
                    Payload::Number(n) => n,
                    _ => return None,
                };
                if n >= 0.0 && n.fract() == 0.0 && n < 4294967295.0 {
                    Some(Slot::of(
                        Kind::At,
                        Payload::At(crate::value::XS_NO_ID, n as u32),
                    ))
                } else {
                    let name = number_to_ecma_string(n);
                    let id = self.intern_key(&name);
                    Some(Slot::of(Kind::At, Payload::At(id, 0)))
                }
            }
            Kind::Undefined | Kind::Null | Kind::Boolean | Kind::BigInt => {
                let name = match key.kind {
                    Kind::Undefined => "undefined".to_owned(),
                    Kind::Null => "null".to_owned(),
                    Kind::Boolean => match key.value {
                        Payload::Boolean(true) => "true".to_owned(),
                        Payload::Boolean(false) => "false".to_owned(),
                        _ => return None,
                    },
                    Kind::BigInt => match key.value {
                        Payload::BigInt(off) => {
                            let (negative, magnitude) = self.read_bigint(off);
                            bi_to_decimal(negative, &magnitude)
                        }
                        _ => return None,
                    },
                    _ => unreachable!(),
                };
                // None of these primitive spellings names a standard inherited
                // object property. In particular, `undefined` is a global own
                // property, not an `%Object.prototype%` property, so the broad
                // boot-default ambiguity gate used for arbitrary strings does
                // not apply here.
                let id = self.intern_key(&name);
                Some(Slot::of(Kind::At, Payload::At(id, 0)))
            }
            // A symbol key (`o[sym]`): resolve its descriptor-slot identity to
            // the interned property id (XS's `mxID(symbol)`). No index branch —
            // a symbol never string-coerces to an array index.
            Kind::Symbol => match key.value {
                Payload::Reference(desc) => {
                    let id = self.intern_symbol_key(desc);
                    Some(Slot::of(Kind::At, Payload::At(id, 0)))
                }
                _ => None,
            },
            Kind::String => {
                let content = match key.value {
                    Payload::String(off) => SymbolName::from_units(&self.str_units(off)),
                    _ => return None,
                };
                let s = content;
                if let Some(idx) = s.as_str().and_then(string_to_index) {
                    // An index-valued string routes to the item; XS meters the
                    // `fxStringToIndex` success two extra code units.
                    self.meter.tick_code_n(2);
                    Some(Slot::of(Kind::At, Payload::At(crate::value::XS_NO_ID, idx)))
                } else {
                    let id = self.intern_key(&s);
                    // A runtime-computed name can be the first reference to a
                    // standard global, method, or accessor. Complete the same
                    // create-only lazy install used by reflective ToPropertyKey
                    // operations before the following property opcode observes
                    // the object. The installed-name floor preserves earlier
                    // guest deletion and replacement.
                    self.install_pending_intrinsics();
                    Some(Slot::of(Kind::At, Payload::At(id, 0)))
                }
            }
            _ => None,
        }
    }

    /// Read a computed (`AT`-key) property (`GET_PROPERTY_AT`): an array index
    /// reads the item (or `undefined` for a hole / past the end); a named key
    /// reads the (own-or-inherited) property. Meters no built-in step, like
    /// `GET_PROPERTY`.
    pub(super) fn property_at_get(
        &mut self,
        code: &[u8],
        obj: Slot,
        key: Slot,
    ) -> Result<Slot, Step> {
        let (id, index) = match key.value {
            Payload::At(id, index) => (id, index),
            _ => return Err(Step::Host(Halt::EngineInvariant("get_property_at:key"))),
        };
        // A primitive string indexed by number yields its one-unit character;
        // a named key boxes to `%String.prototype%` (methods / `.length`).
        if let Payload::String(off) = obj.value {
            if id == crate::value::XS_NO_ID {
                if u64::from(index) < self.str_len(off) as u64 {
                    return Ok(self.string_index_get(off, index));
                }
                // Out of range is NOT `undefined`. `fxStringGetProperty`
                // (`xsString.c`) answers with the string accessor only for
                // `length` or an index below the length, and otherwise falls
                // THROUGH to `fxOrdinaryGetProperty` — so an index defined on
                // the wrapper prototype is still inherited by a primitive
                // receiver. `String.prototype[5] = 'P'; 'ab'[5]` is `'P'` on
                // XS, and was `undefined` here while
                // `Reflect.get(Object('ab'), '5')` — the same read spelled
                // reflectively — already answered `'P'`.
                return match self.string_proto {
                    proto if proto.is_null() => Ok(Slot::undefined()),
                    // Look the index name up rather than mint it, for the same
                    // reason every other index read does.
                    proto => match self.index_read_key_id(index) {
                        Some(id) => self.ordinary_get(code, proto, id, obj),
                        None => self.uninterned_index_get(code, proto, index, obj),
                    },
                };
            }
            return self.string_property_get(code, off, id, obj);
        }
        // A primitive bigint, number, boolean or symbol boxes to its wrapper
        // prototype for a computed property read just as it does for the static
        // `GET_PROPERTY` path: `true['toString']` and `true.toString` must name
        // the same inherited method. The match is on the receiver's KIND, which
        // is what makes the symbol case correct: a symbol value carries
        // `Payload::Reference(desc)`, so without this arm it reaches the
        // generic reference arm below and reads properties off its own
        // description slot (`Symbol({x:5})['x']` was `5`).
        let boxed_proto = match obj.kind {
            Kind::BigInt => self.bigint_proto,
            Kind::Integer | Kind::Number => self.number_proto,
            Kind::Boolean => self.boolean_proto,
            Kind::Symbol => self.symbol_proto,
            _ => crate::value::SlotIndex::NULL,
        };
        if !boxed_proto.is_null() {
            // An integer index arrives without a name key. LOOK one up rather
            // than minting it: a read creates nothing, and interning per
            // distinct index would burn the u16 id space (and meter a slot
            // apiece) on a loop like `for (i…) n[i]` that can only read
            // `undefined`. A key some `Prototype[0] = v` already defined is in
            // the table, so that read still resolves.
            let id = if id == crate::value::XS_NO_ID {
                match self.index_read_key_id(index) {
                    Some(id) => id,
                    // Not simply `undefined`: the wrapper prototype's own chain
                    // can still answer an index WITHOUT a name — after
                    // `Object.setPrototypeOf(Number.prototype, [1, 2, 3])`,
                    // `(5)[0]` is `1`. Same walk as every other index read.
                    None => return self.uninterned_index_get(code, boxed_proto, index, obj),
                }
            } else {
                id
            };
            // The full `[[Get]]`, not a slot read: an accessor's property slot
            // holds `undefined`, so a getter installed on the wrapper
            // prototype would otherwise be invisible to a primitive receiver.
            // `obj` stays the receiver, so `this` inside the getter is the
            // primitive, as OrdinaryGet requires — which is what lets
            // `%Symbol.prototype%`'s `description` getter see the symbol it
            // was read from.
            return self.ordinary_get(code, boxed_proto, id, obj);
        }
        // `null[k]` / `undefined[k]`: `fxToInstance` throws.
        if matches!(obj.kind, Kind::Null | Kind::Undefined) {
            return Err(self.catchable_type_error_msg(cannot_coerce_to_object(obj.kind)));
        }
        // A symbol whose realm has no `%Symbol.prototype%` linked falls through
        // the boxing arm above; there is nothing to resolve against, and the
        // generic reference arm below would read its DESCRIPTION slot.
        if obj.kind == Kind::Symbol {
            return Ok(Slot::undefined());
        }
        let inst = match obj.value {
            Payload::Reference(i) => i,
            _ => return Ok(Slot::undefined()),
        };
        if self.proxies.contains_key(&inst) {
            // `p[k]` routes through the `get` trap; an integer index key is a
            // canonical numeric string for the proxy.
            let key_id = if id == crate::value::XS_NO_ID {
                match self.index_read_key_id(index) {
                    Some(id) => id,
                    // The trap still has to be CALLED for an index the table
                    // has no key for — but minting the key here, before the
                    // trap lookup, is what let `p[i]` over novel indices walk
                    // the id space into its saturation guard even for a proxy
                    // that traps nothing.
                    None => return self.uninterned_index_get(code, inst, index, obj),
                }
            } else {
                id
            };
            return self.proxy_get(code, inst, key_id, obj);
        }
        if let Some(&ta) = self.typed_arrays.get(&inst) {
            // The integer-indexed exotic `[[Get]]` (ECMA-262 10.4.5.4): a
            // canonical numeric index string (`sample[0]`, `sample["1.1"]`,
            // `sample["-0"]`, …) reads the element (or `undefined` for an
            // invalid index — out of range / non-integral / detached), NEVER
            // the prototype chain. Every other key (a non-canonical string, a
            // symbol) is an ordinary `[[Get]]` up the chain.
            if let Some(n) = self.ta_numeric_index_at(id, index) {
                return Ok(self.ta_indexed_element_get(ta, n));
            }
            let id = if id == crate::value::XS_NO_ID {
                // Unreachable: `ta_numeric_index_at` answers every `XS_NO_ID`
                // key as a canonical index above. A lookup rather than a mint
                // even so, so this arm can never become the id-space leak the
                // other index reads were.
                match self.index_read_key_id(index) {
                    Some(id) => id,
                    None => return Ok(Slot::undefined()),
                }
            } else {
                id
            };
            return self.ordinary_get(code, inst, id, obj);
        }
        if let Some(Slot {
            kind: Kind::String,
            value: Payload::String(off),
            ..
        }) = self.wrapper_data.get(&inst).copied()
        {
            if id == crate::value::XS_NO_ID {
                // Only an IN-RANGE index is the String exotic's own unit. An
                // out-of-range index falls through to the ordinary walk below,
                // exactly as `fxStringGetProperty` falls through to
                // `fxOrdinaryGetProperty`, so the wrapper still inherits an
                // index its prototype chain defines.
                if u64::from(index) < self.str_len(off) as u64 {
                    return Ok(self.string_index_get(off, index));
                }
            } else if Some(id) == self.length_id {
                return Ok(Slot::integer(self.str_len(off) as i32));
            }
        }
        if id == crate::value::XS_NO_ID {
            // An index key. (A TypedArray receiver is handled by the
            // integer-indexed exotic `[[Get]]` above and never reaches here.)
            if let Some(item) = self
                .arrays
                .get(&inst)
                .and_then(|a| a.items().get(&index).copied())
            {
                return Ok(self.array_item_value(inst, item));
            }
            match self.index_read_key_id(index) {
                Some(id) => self.ordinary_get(code, inst, id, obj),
                None => self.uninterned_index_get(code, inst, index, obj),
            }
        } else if Some(id) == self.length_id
            && self.arrays.contains_key(&inst)
            && !self.arguments_objects.contains(&inst)
        {
            self.meter.tick_raw(ARRAY_LENGTH_GET_METERING);
            Ok(Self::array_index_number(u64::from(
                self.arrays[&inst].length,
            )))
        } else {
            self.ordinary_get(code, inst, id, obj)
        }
    }

    /// The id an index key is **already** interned under, if any.
    ///
    /// A read creates nothing, so an index-keyed read must LOOK ITS NAME UP
    /// rather than mint it: [`Self::intern_key`] hands out a fresh `u16` (and
    /// meters a slot allocation) per novel name, so `for (var i = 0; i < 70000;
    /// i++) o[i]` would otherwise carry the name table into the meet with the
    /// symbol-key floor documented on [`Self::next_symbol_key_id`] — a refusal
    /// that poisons the machine rather than throwing something the guest can
    /// catch, i.e. a denial of service on the whole engine from an ordinary
    /// loop. XS mints nothing either: `XS_CODE_GET_PROPERTY_AT` passes
    /// `(XS_NO_ID, index)` straight to `mxBehaviorGetProperty`, so the dropped
    /// `tick_slot_alloc` is also the metering-faithful answer.
    pub(super) fn index_read_key_id(&self, index: u32) -> Option<u16> {
        self.symbol_ids.get(index.to_string()).copied()
    }

    /// Re-resolve a [`ReadKey`] that was captured earlier in the same
    /// operation, in case the guest has since NAMED that index.
    ///
    /// A `ReadKey::Index` answers out of the side tables, so it is only valid
    /// while the property still lives there — and while no name for it
    /// exists, since an `Index` and the `Id` it refreshes to must not be
    /// treated as different properties. Guest code running mid-operation can
    /// change both: any write of a novel index name interns it, and
    /// `array_define_index` still PROMOTES a compact item to an ordinary
    /// named slot for an ACCESSOR descriptor, minting the name as it goes. So
    /// a key snapshotted before guest code ran must be refreshed before it is
    /// used, or the read misses a property the object demonstrably has and an
    /// equality test splits one property in two.
    pub(super) fn refresh_read_key(&self, key: ReadKey) -> ReadKey {
        match key {
            ReadKey::Index(index) => match self.index_read_key_id(index) {
                Some(id) => ReadKey::Id(id),
                None => ReadKey::Index(index),
            },
            key => key,
        }
    }

    /// Whether a [`ReadKey`] names a canonical integer index — answerable
    /// without a name when it is an `Index`, and by the name's own spelling
    /// when the table already holds one.
    pub(super) fn read_key_is_index(&self, key: ReadKey) -> bool {
        match key {
            ReadKey::Index(_) => true,
            ReadKey::Id(id) => self
                .scalar_key_text(id)
                .is_some_and(|name| string_to_index(&name).is_some()),
        }
    }

    /// The name id for a [`ReadKey`] that is about to be used by an operation
    /// which CREATES a property, minting one if the table has never held it.
    ///
    /// Unmetered: XS never interns an index name, so a `tick_slot_alloc` here
    /// would be an overcharge rather than parity. Call this only where the
    /// representation genuinely requires a name — an ordinary object's index
    /// property is a named slot in this engine, where in XS it is a slot in an
    /// internal array chunk.
    pub(super) fn read_key_intern(&mut self, key: ReadKey) -> u16 {
        match key {
            ReadKey::Id(id) => id,
            ReadKey::Index(index) => self.intern_key_unmetered(index.to_string()),
        }
    }

    /// Resolve a key slot for a READ-side operation, minting nothing for an
    /// index the key table has never held ([`ReadKey`]).
    ///
    /// This is [`Self::to_property_id`] with the index case split out. Every
    /// other case is byte-for-byte that path: a symbol keeps its descriptor
    /// identity, and a non-index string interns as a name (XS interns those
    /// too — `fxAt` only takes its index branch for a canonical index — so
    /// `o["k" + i]` exhausting the id space stays the engine's documented
    /// limit rather than something this split pretends to fix).
    pub(super) fn to_read_key(&mut self, code: &[u8], key: Slot) -> Result<ReadKey, Step> {
        if let Payload::At(id, index) = key.value {
            if id != crate::value::XS_NO_ID {
                return Ok(ReadKey::Id(id));
            }
            return Ok(match self.index_read_key_id(index) {
                Some(id) => ReadKey::Id(id),
                None => ReadKey::Index(index),
            });
        }
        let property_key = self.to_property_key(code, key)?;
        if property_key.kind == Kind::Symbol {
            return match property_key.value {
                Payload::Reference(descriptor) => {
                    Ok(ReadKey::Id(self.intern_symbol_key(descriptor)))
                }
                _ => Err(Step::Host(Halt::EngineInvariant(
                    "to_read_key:symbol-without-descriptor",
                ))),
            };
        }
        let name = match property_key.value {
            Payload::String(offset) => SymbolName::from_units(&self.str_units(offset)),
            _ => {
                return Err(Step::Host(Halt::EngineInvariant(
                    "to_read_key:non-string-key",
                )))
            }
        };
        // A canonical array-index string is what XS's `fxAt` turns into
        // `(XS_NO_ID, index)`; uninterned, it stays an index here too.
        if let Some(index) = name.as_str().and_then(string_to_index) {
            if let Some(id) = self.index_read_key_id(index) {
                return Ok(ReadKey::Id(id));
            }
            return Ok(ReadKey::Index(index));
        }
        let id = self.intern_key(&name);
        self.install_pending_intrinsics();
        Ok(ReadKey::Id(id))
    }

    /// The key as the string/symbol slot a Proxy trap is handed. An `Index`
    /// spells its own canonical numeric string, exactly as XS's `fxKeyAt`
    /// does for `XS_NO_ID`, without interning it.
    pub(super) fn read_key_slot(&mut self, key: ReadKey) -> Result<Slot, Step> {
        match key {
            ReadKey::Id(id) => self.property_key_slot(id),
            ReadKey::Index(index) => {
                let offset = self.alloc_str_text_metered(index.to_string().as_bytes())?;
                Ok(Slot::of(Kind::String, Payload::String(offset)))
            }
        }
    }

    /// `[[Get]]` of an index key whose canonical name the key table has never
    /// held, with `receiver` as the `[[Get]]` receiver.
    ///
    /// An ordinary own property exists only under a name that was interned to
    /// define it, so no ordinary slot anywhere on the chain can answer to an
    /// uninterned name. Only the receivers that resolve an index WITHOUT
    /// consulting the name table can: a TypedArray element, an array item, a
    /// String-wrapper unit, and a Proxy's `get` trap — which is handed the key
    /// as a string, and so is the one place the key is worth building at all.
    /// Every other object on the chain falls through to its prototype, and the
    /// end of the chain is `undefined`, minting nothing.
    pub(super) fn uninterned_index_get(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        index: u32,
        receiver: Slot,
    ) -> Result<Slot, Step> {
        // Charged against the native-recursion budget like every other MOP
        // entry point: forwarding down a chain of untrapped proxies recurses
        // here, and an unbudgeted recursion overflows the real stack and
        // aborts the process instead of halting with `StackOverflow`.
        self.with_native_frame(LIGHT_FRAME_COST, |vm| {
            vm.uninterned_index_get_inner(code, inst, index, receiver)
        })
    }

    pub(super) fn uninterned_index_get_inner(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        index: u32,
        receiver: Slot,
    ) -> Result<Slot, Step> {
        // The Array Iterator's residual for a trap already taken, exactly as
        // `mop_get` charges it for an id-keyed read. An ordinary object's
        // index property has no name, so this arm — not that one — is where
        // the iterator's read of one lands.
        //
        // The context is only ever installed against a Proxy target, so the
        // delegation below takes `proxy_get_with_metering` and cannot come
        // back through the `ReadKey::Index` arm that would re-enter here.
        if let Some(context) = self
            .array_iterator_proxy_get_context
            .filter(|context| context.target == inst)
            .filter(|context| self.refresh_read_key(context.key) == ReadKey::Index(index))
        {
            return self.mop_get_with_proxy_metering(
                code,
                inst,
                ReadKey::Index(index),
                receiver,
                context.trap_metering,
                context.meter_terminal_wrapper,
                false,
                true,
            );
        }
        let mut cur = inst;
        while !cur.is_null() {
            if self.proxies.contains_key(&cur) {
                return self.uninterned_index_proxy_get(code, cur, index, receiver);
            }
            if let Some(&ta) = self.typed_arrays.get(&cur) {
                // The integer-indexed exotic `[[Get]]` answers for the whole
                // read, at the receiver or through a prototype, and never
                // continues up the chain (ECMA-262 10.4.5.4).
                return Ok(self.ta_indexed_element_get(ta, f64::from(index)));
            }
            if let Some(item) = self
                .arrays
                .get(&cur)
                .and_then(|a| a.items().get(&index).copied())
            {
                return Ok(self.array_item_value(cur, item));
            }
            if let Some(Slot {
                kind: Kind::String,
                value: Payload::String(off),
                ..
            }) = self.wrapper_data.get(&cur).copied()
            {
                let unit = self.string_index_get(off, index);
                if unit.kind != Kind::Undefined {
                    return Ok(unit);
                }
            }
            // An ordinary object at this chain level answers from its index
            // store. Only a data property can live there, so this is the
            // value, not a descriptor to interpret.
            if let Some(item) = self.index_prop_item(cur, index) {
                return Ok(Slot::of(item.kind, item.value));
            }
            cur = self.instance_prototype(cur);
        }
        Ok(Slot::undefined())
    }

    /// The Proxy arm of [`Self::uninterned_index_get`]: `[[Get]]` (ECMA-262
    /// 10.5.8) of an index key the name table has no id for.
    ///
    /// The trap must still be CALLED, and it is handed the key as a string —
    /// built here from the index, exactly as XS's `fxKeyAt` builds one for
    /// `XS_NO_ID`, so the trap sees the canonical numeric string without the
    /// engine minting a key id for it. A proxy that traps nothing forwards to
    /// its target with the key still unbuilt.
    pub(super) fn uninterned_index_proxy_get(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
        index: u32,
        receiver: Slot,
    ) -> Result<Slot, Step> {
        let (target, handler) = self.proxy_target_handler(proxy, "get")?;
        let trap = match self.proxy_trap(code, handler, "get")? {
            Some(trap) => trap,
            None => return self.uninterned_index_get(code, target, index, receiver),
        };
        self.proxy_get_trapped(
            code,
            target,
            handler,
            trap,
            ReadKey::Index(index),
            receiver,
            0,
            false,
            false,
        )
    }

    /// Whether `o` has an OWN property at `index` whose name the table has
    /// never held — [`Self::object_own_property_present`] with the index known
    /// directly instead of derived from the key's name. Every arm that reaches
    /// for `find_property` there is `false` here: an ordinary own slot only
    /// exists under a name that was interned to define it.
    pub(super) fn uninterned_index_own_present(
        &mut self,
        code: &[u8],
        o: crate::value::SlotIndex,
        index: u32,
    ) -> Result<bool, Step> {
        if self.proxies.contains_key(&o) {
            return Ok(self
                .uninterned_index_own_descriptor(code, o, index)?
                .is_some());
        }
        if let Some(&ta) = self.typed_arrays.get(&o) {
            return Ok(self.ta_valid_index(ta, f64::from(index)).is_some());
        }
        if let Some(a) = self.arrays.get(&o) {
            return Ok(a.items().contains_key(&index));
        }
        if let Some(Slot {
            kind: Kind::String,
            value: Payload::String(off),
            ..
        }) = self.wrapper_data.get(&o).copied()
        {
            return Ok(self.string_exotic_has_own(self.str_len(off), None, Some(index)));
        }
        // An ordinary object keeps its index properties BY INDEX, so an
        // uninterned name misses them but the store does not.
        Ok(self.index_prop_item(o, index).is_some())
    }

    /// `[[HasProperty]]` of an index key the name table has no id for, plus
    /// the `fxOrdinaryHasProperty` frame count its callers meter — the same
    /// loop and the same counting rule as
    /// [`Self::mop_has_with_recursions_inner`].
    pub(super) fn uninterned_index_has(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        index: u32,
    ) -> Result<(bool, u64), Step> {
        self.with_native_frame(LIGHT_FRAME_COST, |vm| {
            let mut current = inst;
            let mut frames = 0u64;
            loop {
                if vm.proxies.contains_key(&current) {
                    return Ok((vm.uninterned_index_proxy_has(code, current, index)?, frames));
                }
                if vm.uninterned_index_own_present(code, current, index)? {
                    return Ok((true, frames));
                }
                frames += 1;
                let prototype = vm.instance_prototype(current);
                if prototype.is_null() {
                    return Ok((false, frames));
                }
                current = prototype;
            }
        })
    }

    /// `[[GetOwnProperty]]` of an index key the name table has no id for —
    /// [`Self::mop_get_own_property`] with the index known directly.
    pub(super) fn uninterned_index_own_descriptor(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        index: u32,
    ) -> Result<Option<OrdinaryDescriptor>, Step> {
        // Budget-charged for the same reason as [`Self::uninterned_index_get`],
        // and to match `mop_get_own_property`, the id-keyed twin.
        self.with_native_frame(LIGHT_FRAME_COST, |vm| {
            vm.uninterned_index_own_descriptor_inner(code, inst, index)
        })
    }

    pub(super) fn uninterned_index_own_descriptor_inner(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        index: u32,
    ) -> Result<Option<OrdinaryDescriptor>, Step> {
        if self.proxies.contains_key(&inst) {
            return self.uninterned_index_proxy_own_descriptor(code, inst, index);
        }
        if let Some(&ta) = self.typed_arrays.get(&inst) {
            return Ok(self.ta_index_own_descriptor(ta, f64::from(index)));
        }
        if let Some(item) = self
            .arrays
            .get(&inst)
            .and_then(|a| a.items().get(&index).copied())
        {
            let value = self.array_item_value(inst, item);
            return Ok(Some(OrdinaryDescriptor {
                value: Some(value),
                writable: Some(item.flag & XS_DONT_SET_FLAG == 0),
                enumerable: Some(item.flag & XS_DONT_ENUM_FLAG == 0),
                configurable: Some(item.flag & XS_DONT_DELETE_FLAG == 0),
                ..OrdinaryDescriptor::default()
            }));
        }
        if let Some(Slot {
            kind: Kind::String,
            value: Payload::String(off),
            ..
        }) = self.wrapper_data.get(&inst).copied()
        {
            let value = self.string_index_get(off, index);
            if value.kind != Kind::Undefined {
                return Ok(Some(OrdinaryDescriptor {
                    value: Some(value),
                    writable: Some(false),
                    enumerable: Some(true),
                    configurable: Some(false),
                    ..OrdinaryDescriptor::default()
                }));
            }
        }
        Ok(self.index_prop_descriptor(inst, index))
    }

    /// `[[Delete]]` of an index key the name table has no id for —
    /// [`Self::mop_delete_inner`] with the index known directly. A delete
    /// creates nothing either, and an absent property is a vacuous `true`.
    pub(super) fn uninterned_index_delete(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        index: u32,
    ) -> Result<bool, Step> {
        self.with_native_frame(LIGHT_FRAME_COST, |vm| {
            if vm.proxies.contains_key(&inst) {
                return vm.uninterned_index_proxy_delete(code, inst, index);
            }
            if let Some(&ta) = vm.typed_arrays.get(&inst) {
                // The integer-indexed exotic `[[Delete]]` (10.4.5.7): a valid
                // index cannot be deleted; an invalid one is vacuously `true`.
                return Ok(vm.ta_valid_index(ta, f64::from(index)).is_none());
            }
            if vm.arrays.contains_key(&inst) {
                if let Some(item) = vm.arrays[&inst].items().get(&index).copied() {
                    if item.flag & XS_DONT_DELETE_FLAG != 0 {
                        return Ok(false);
                    }
                    vm.arrays
                        .get_mut(&inst)
                        .unwrap()
                        .remove_item(&index, &mut vm.side_refs);
                    return Ok(true);
                }
                return Ok(true);
            }
            if let Some(Slot {
                kind: Kind::String,
                value: Payload::String(off),
                ..
            }) = vm.wrapper_data.get(&inst).copied()
            {
                // String-exotic index units are non-configurable.
                if (index as usize) < vm.str_len(off) {
                    return Ok(false);
                }
            }
            // An ordinary object's index property lives in the index store.
            if let Some(item) = vm.index_prop_item(inst, index) {
                if item.flag & XS_DONT_DELETE_FLAG != 0 {
                    return Ok(false);
                }
                vm.index_prop_remove(inst, index);
            }
            // Anything else cannot hold the property, so there is nothing to
            // delete and no own slot to drop.
            Ok(true)
        })
    }

    /// The Proxy arm of [`Self::uninterned_index_has`]: `[[HasProperty]]`
    /// (ECMA-262 10.5.7) for an index key with no id. The trap is handed the
    /// key as a string; an untrapped proxy forwards with the key unbuilt.
    pub(super) fn uninterned_index_proxy_has(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
        index: u32,
    ) -> Result<bool, Step> {
        let (target, handler) = self.proxy_target_handler(proxy, "has")?;
        let trap = match self.proxy_trap(code, handler, "has")? {
            Some(trap) => trap,
            None => return Ok(self.uninterned_index_has(code, target, index)?.0),
        };
        let handler_slot = Slot::of(Kind::Reference, Payload::Reference(handler));
        let target_slot = Slot::of(Kind::Reference, Payload::Reference(target));
        let key = self.read_key_slot(ReadKey::Index(index))?;
        let result = self.invoke_value(code, trap, handler_slot, &[target_slot, key])?;
        let boolean = self.truthy(&result);
        if !boolean {
            // The trap may have NAMED this index, promoting it to an ordinary
            // slot the index arm cannot see; refresh or the invariant check is
            // silently skipped.
            let key_id = self.refresh_read_key(ReadKey::Index(index));
            if let Some(d) = self.mop_get_own_property_read(code, target, key_id)? {
                if d.configurable == Some(false) {
                    return Err(self.catchable_type_error_msg(
                        "(proxy).has: false for non-configurable property".into(),
                    ));
                }
                if !self.mop_is_extensible(code, target)? {
                    return Err(self.catchable_type_error_msg(
                        "(proxy).has: false for property of not extensible object".into(),
                    ));
                }
            }
        }
        Ok(boolean)
    }

    /// The Proxy arm of [`Self::uninterned_index_own_descriptor`].
    pub(super) fn uninterned_index_proxy_own_descriptor(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
        index: u32,
    ) -> Result<Option<OrdinaryDescriptor>, Step> {
        let (target, handler) = self.proxy_target_handler(proxy, "getOwnPropertyDescriptor")?;
        let trap = match self.proxy_trap(code, handler, "getOwnPropertyDescriptor")? {
            Some(trap) => trap,
            None => return self.uninterned_index_own_descriptor(code, target, index),
        };
        self.proxy_get_own_property_trapped(code, target, handler, trap, ReadKey::Index(index))
    }

    /// The Proxy arm of [`Self::uninterned_index_delete`].
    pub(super) fn uninterned_index_proxy_delete(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
        index: u32,
    ) -> Result<bool, Step> {
        let (target, handler) = self.proxy_target_handler(proxy, "deleteProperty")?;
        let trap = match self.proxy_trap(code, handler, "deleteProperty")? {
            Some(trap) => trap,
            None => return self.uninterned_index_delete(code, target, index),
        };
        self.proxy_delete_trapped(code, target, handler, trap, ReadKey::Index(index))
    }

    /// `[[Get]]` dispatched on a [`ReadKey`].
    pub(super) fn mop_get_read(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        key: ReadKey,
        receiver: Slot,
    ) -> Result<Slot, Step> {
        match key {
            ReadKey::Id(id) => self.mop_get(code, inst, id, receiver),
            ReadKey::Index(index) => self.uninterned_index_get(code, inst, index, receiver),
        }
    }

    /// `[[HasProperty]]` dispatched on a [`ReadKey`], with the frame count.
    pub(super) fn mop_has_read_with_recursions(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        key: ReadKey,
    ) -> Result<(bool, u64), Step> {
        match key {
            ReadKey::Id(id) => self.mop_has_with_recursions(code, inst, id),
            ReadKey::Index(index) => self.uninterned_index_has(code, inst, index),
        }
    }

    /// `[[GetOwnProperty]]` dispatched on a [`ReadKey`].
    pub(super) fn mop_get_own_property_read(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        key: ReadKey,
    ) -> Result<Option<OrdinaryDescriptor>, Step> {
        match key {
            ReadKey::Id(id) => self.mop_get_own_property(code, inst, id),
            ReadKey::Index(index) => self.uninterned_index_own_descriptor(code, inst, index),
        }
    }

    /// `[[DefineOwnProperty]]` dispatched on a [`ReadKey`].
    ///
    /// A TypedArray element needs no name: its store is the buffer, addressed
    /// by index, and nothing is ever promoted out of it.
    ///
    /// An ARRAY element needs none either, now that `array_define_index`
    /// stamps a data descriptor onto the item slot in place the way XS does.
    /// That is what makes `Object.freeze`/`Object.seal`/`harden` of a large
    /// array possible at all: promoting one item per element used to mint one
    /// name per element, which walked the `u16` id space into the saturation
    /// guard that poisons the machine. Only an ACCESSOR on an index still
    /// promotes, and it mints its own name when it does.
    ///
    /// Everything else — an ordinary object, a String wrapper, a Proxy that
    /// forwards to one — still routes through a real id, because in this
    /// representation the define is what CREATES a distinct named property.
    pub(super) fn mop_define_own_property_read(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        key: ReadKey,
        desc: OrdinaryDescriptor,
    ) -> Result<bool, Step> {
        let index = match key {
            ReadKey::Id(id) => return self.mop_define_own_property(code, inst, id, desc),
            ReadKey::Index(index) => index,
        };
        if !self.proxies.contains_key(&inst) {
            if let Some(&ta) = self.typed_arrays.get(&inst) {
                return self.with_native_frame(LIGHT_FRAME_COST, |vm| {
                    vm.ta_index_define(code, ta, f64::from(index), desc)
                });
            }
            if self.indexes_by_index(inst) {
                if let Some(accepted) = self.index_prop_define(inst, index, desc) {
                    return Ok(accepted);
                }
            }
            if self.arrays.contains_key(&inst) {
                // Not `array_define_own_property`: an index is never `length`
                // and never an ordinary expando, so its dispatch has nothing
                // to decide — and deciding would need the name this call
                // exists to avoid materializing.
                let id = self.index_read_key_id(index);
                return self.with_native_frame(LIGHT_FRAME_COST, |vm| {
                    Ok(vm.array_define_index(inst, id, index, desc))
                });
            }
            // A String wrapper's in-range index is an immutable own property.
            // A define against it CREATES nothing — the answer is only whether
            // the descriptor is compatible with the one already there — so it
            // needs no name either.
            //
            // This arm is what `harden` needs. XS's `fx_harden` clears its
            // `useIndexes` flag only for a TYPED ARRAY (`xsLockdown.c:232`),
            // so a String wrapper's indices are reached and defined like any
            // other key; ironhorse must reach them too, and minting a name per
            // unit made `harden(new String('x'.repeat(70000)))` poison the
            // machine even after the array case was fixed.
            if let Some(Slot {
                kind: Kind::String,
                value: Payload::String(off),
                ..
            }) = self.wrapper_data.get(&inst).copied()
            {
                let shadowed = self
                    .index_read_key_id(index)
                    .is_some_and(|id| self.find_property(inst, id).is_some());
                if !shadowed && u64::from(index) < self.str_len(off) as u64 {
                    // No `with_native_frame` here: `uninterned_index_own_descriptor`
                    // charges its own, and every sibling arm charges exactly one.
                    let current = self.uninterned_index_own_descriptor(code, inst, index)?;
                    if let Some(current) = current {
                        return Ok(self.is_compatible_descriptor(false, &desc, Some(&current)));
                    }
                }
            }
        }
        let id = self.intern_key_unmetered(index.to_string());
        self.mop_define_own_property(code, inst, id, desc)
    }

    /// `[[Delete]]` dispatched on a [`ReadKey`].
    pub(super) fn mop_delete_read(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        key: ReadKey,
    ) -> Result<bool, Step> {
        match key {
            ReadKey::Id(id) => self.mop_delete(code, inst, id),
            ReadKey::Index(index) => self.uninterned_index_delete(code, inst, index),
        }
    }

    /// Diagnose XS's super setter without repeating guest getters or traps.
    /// A data property on the home prototype leads XS to the receiver's own
    /// property. Keep spec-only rejections bare when XS would instead succeed.
    pub(super) fn failed_super_set_error(
        &mut self,
        base: crate::value::SlotIndex,
        id: u16,
        receiver: Slot,
    ) -> Step {
        let mut current = base;
        while !current.is_null() {
            if self.proxies.contains_key(&current) {
                return self.catchable_type_error();
            }
            let descriptor = self
                .ordinary_get_own_descriptor(current, id)
                .or_else(|| self.exotic_own_descriptor(current, id));
            if let Some(descriptor) = descriptor {
                if descriptor.is_accessor() {
                    if descriptor
                        .set
                        .is_none_or(|setter| setter.kind == Kind::Undefined)
                    {
                        let name = self.property_debug_name(id);
                        return self.catchable_type_error_msg(format!("set {name}: no setter"));
                    }
                    return self.catchable_type_error();
                }
                break;
            }
            current = self.instance_prototype(current);
        }
        let Payload::Reference(object) = receiver.value else {
            return self.catchable_type_error();
        };
        if receiver.kind != Kind::Reference || self.proxies.contains_key(&object) {
            return self.catchable_type_error();
        }
        let descriptor = self
            .ordinary_get_own_descriptor(object, id)
            .or_else(|| self.exotic_own_descriptor(object, id));
        let reason = match descriptor {
            Some(descriptor) if descriptor.is_accessor() => {
                if descriptor
                    .set
                    .is_none_or(|setter| setter.kind == Kind::Undefined)
                {
                    "no setter"
                } else {
                    return self.catchable_type_error();
                }
            }
            Some(descriptor) if descriptor.writable == Some(false) => "not writable",
            None if !self.instance_extensible(object) => "not extensible",
            _ => return self.catchable_type_error(),
        };
        let name = self.property_debug_name(id);
        self.catchable_type_error_msg(format!("set {name}: {reason}"))
    }

    /// Write a computed (`AT`-key) property. `define` distinguishes
    /// `NEW_PROPERTY_AT` (a literal/`Object.defineProperty`-style define,
    /// which meters one extra built-in step) from `SET_PROPERTY_AT` (a plain
    /// assignment). An array index grows/overwrites the item chunk; a named
    /// key routes to the ordinary property store or the array length.
    pub(super) fn property_at_set(
        &mut self,
        code: &[u8],
        obj: Slot,
        key: Slot,
        value: Slot,
        define: bool,
    ) -> Result<(), Step> {
        // `null[k] = v` / `undefined[k] = v`: `fxToInstance` throws.
        if matches!(obj.kind, Kind::Null | Kind::Undefined) {
            return Err(self.catchable_type_error_msg(cannot_coerce_to_object(obj.kind)));
        }
        // A primitive symbol carries `Payload::Reference(desc)` — its
        // description slot, NOT an instance. Without this guard `sym[k] = v`
        // reached THROUGH the symbol into the description: it ran that
        // object's setters and stored on it, which let an object handed to
        // `Symbol()` be written through a value that is routinely treated as
        // opaque. A symbol joins the other primitive receivers here: the write
        // stores nothing. (XS additionally throws for the strict form, as it
        // does for every primitive receiver; that gap is the standing
        // `property_at_set`-on-primitives divergence, not this one.)
        if obj.kind == Kind::Symbol {
            return Ok(());
        }
        let inst = match obj.value {
            Payload::Reference(i) => i,
            _ => return Ok(()),
        };
        let (id, index) = match key.value {
            Payload::At(id, index) => (id, index),
            _ => return Err(Step::Host(Halt::EngineInvariant("set_property_at:key"))),
        };
        if self.proxies.contains_key(&inst) {
            // `p[k] = v` (or a computed define) routes through the proxy's
            // `[[Set]]`/`[[DefineOwnProperty]]` trap.
            let key_id = if id == crate::value::XS_NO_ID {
                self.intern_key(index.to_string())
            } else {
                id
            };
            if define {
                let desc = OrdinaryDescriptor {
                    value: Some(value),
                    writable: Some(true),
                    enumerable: Some(true),
                    configurable: Some(true),
                    ..OrdinaryDescriptor::default()
                };
                self.proxy_define_own_property(code, inst, key_id, desc)?;
            } else {
                let accepted = self.proxy_set(code, inst, key_id, value, obj)?;
                // The spec rejects a false strict Proxy Set; pinned XS ignores
                // that trap result here, so it has no matching diagnostic.
                if !accepted && self.strict {
                    return Err(self.catchable_type_error());
                }
            }
            return Ok(());
        }
        if let Some(&ta) = self.typed_arrays.get(&inst) {
            // The integer-indexed exotic `[[Set]]` (ECMA-262 10.4.5.5) with the
            // receiver equal to the view (the direct `sample[k] = v` form):
            // `IntegerIndexedElementSet` coerces the value (running any
            // `valueOf`/`toString`, which may throw) and stores it only for a
            // valid integer index — an out-of-range / non-integral / detached
            // index is a coercion-only no-op. Any non-canonical key is an
            // ordinary named write up the chain.
            if let Some(n) = self.ta_numeric_index_at(id, index) {
                return self.ta_indexed_element_set(code, ta, n, value);
            }
            let id = if id == crate::value::XS_NO_ID {
                self.intern_key(index.to_string())
            } else {
                id
            };
            if define {
                let descriptor = OrdinaryDescriptor {
                    value: Some(value),
                    writable: Some(true),
                    enumerable: Some(true),
                    configurable: Some(true),
                    ..OrdinaryDescriptor::default()
                };
                self.ordinary_define_own_property(inst, id, descriptor);
                self.meter.tick_builtin();
            } else {
                let _ = self.ordinary_set(code, inst, id, value, obj)?;
            }
            return Ok(());
        }
        if id == crate::value::XS_NO_ID {
            // A TypedArray receiver is handled by the integer-indexed exotic
            // `[[Set]]` above and never reaches here.
            if self.arrays.contains_key(&inst) {
                // Compact writes do not materialize a property name in XS.
                // Look up an existing name only: interning every literal index
                // charged a name-slot allocation and shifted exact metering.
                let key_id = self.symbol_ids.get(index.to_string()).copied();
                if let Some(key_id) = key_id.filter(|id| self.find_property(inst, *id).is_some()) {
                    if define {
                        let descriptor = OrdinaryDescriptor {
                            value: Some(value),
                            writable: Some(true),
                            enumerable: Some(true),
                            configurable: Some(true),
                            ..OrdinaryDescriptor::default()
                        };
                        let _ = self.array_define_index(inst, Some(key_id), index, descriptor);
                        self.meter.tick_builtin();
                    } else {
                        let accepted = self.ordinary_set(code, inst, key_id, value, obj)?;
                        if !accepted && self.strict {
                            return Err(self.failed_set_error(inst, key_id, "set"));
                        }
                    }
                } else if !define
                    && (self.arrays[&inst]
                        .items()
                        .get(&index)
                        .is_some_and(|item| item.flag & XS_DONT_SET_FLAG != 0)
                        || index >= self.arrays[&inst].length && !self.array_length_writable(inst)
                        || !self.instance_extensible(inst)
                            && !self.arrays[&inst].items().contains_key(&index))
                {
                    if self.strict {
                        let reason = if self.arrays[&inst]
                            .items()
                            .get(&index)
                            .is_some_and(|item| item.flag & XS_DONT_SET_FLAG != 0)
                        {
                            "not writable"
                        } else {
                            "not extensible"
                        };
                        return Err(self.catchable_type_error_msg(format!("set ?: {reason}")));
                    }
                } else {
                    self.array_item_set(inst, index, value, define);
                }
                Ok(())
            } else {
                // An ordinary object keeps its index properties BY INDEX, the
                // way XS's `fxOrdinarySetProperty` grows an internal
                // `XS_ARRAY_KIND` slot rather than naming anything. Naming
                // them here is what made `o[i] = i` over a loop exhaust the
                // `u16` key space and poison the machine.
                if self.indexes_by_index(inst) {
                    if define {
                        let descriptor = OrdinaryDescriptor {
                            value: Some(value),
                            writable: Some(true),
                            enumerable: Some(true),
                            configurable: Some(true),
                            ..OrdinaryDescriptor::default()
                        };
                        if self.index_prop_define(inst, index, descriptor).is_some() {
                            self.meter.tick_builtin();
                            return Ok(());
                        }
                    } else if self
                        .ordinary_index_set(code, inst, index, value, obj)?
                        .is_some()
                    {
                        return Ok(());
                    }
                    // Fall through: the narrow shapes the index store cannot
                    // answer (an accessor, an existing named slot, a Proxy or
                    // TypedArray prototype whose behaviour must observe the
                    // key) resolve a name and take the path below.
                }
                let id = self.intern_key(index.to_string());
                if define {
                    let descriptor = OrdinaryDescriptor {
                        value: Some(value),
                        writable: Some(true),
                        enumerable: Some(true),
                        configurable: Some(true),
                        ..OrdinaryDescriptor::default()
                    };
                    self.ordinary_define_own_property(inst, id, descriptor);
                    self.meter.tick_builtin();
                } else {
                    let _ = self.ordinary_set(code, inst, id, value, obj)?;
                }
                Ok(())
            }
        } else if self.arrays.contains_key(&inst)
            && !self.arguments_objects.contains(&inst)
            && self.scalar_key_text(id).as_deref() == Some("length")
        {
            // `ArraySetLength` is also the `DefineProperty` algorithm and
            // therefore permits the same value on a non-writable length.
            // Ordinary assignment must reject the write before that
            // same-value exception is considered.
            if !define && !self.array_length_writable(inst) {
                if self.strict {
                    return Err(self.catchable_type_error_msg("set length: not writable".into()));
                }
                return Ok(());
            }
            let accepted = self.array_define_length(
                code,
                inst,
                OrdinaryDescriptor {
                    value: Some(value),
                    ..OrdinaryDescriptor::default()
                },
            )?;
            if !accepted && self.strict {
                // Preserve the spec's failed length-shrink error. XS's array
                // length setter ignores fxSetArrayLength's false return.
                return Err(self.catchable_type_error());
            }
            Ok(())
        } else {
            if define {
                let descriptor = OrdinaryDescriptor {
                    value: Some(value),
                    writable: Some(true),
                    enumerable: Some(true),
                    configurable: Some(true),
                    ..OrdinaryDescriptor::default()
                };
                self.ordinary_define_own_property(inst, id, descriptor);
                self.meter.tick_builtin();
            } else {
                let _ = self.ordinary_set(code, inst, id, value, obj)?;
            }
            Ok(())
        }
    }

    /// Project a compact array item into its observable ECMAScript value.
    /// Sloppy mapped arguments keep a closure-cell edge in the item so the
    /// parameter binding remains live; every other item is already a value.
    pub(super) fn array_item_value(&self, inst: crate::value::SlotIndex, item: Slot) -> Slot {
        if self.arguments_objects.contains(&inst)
            && item.kind == Kind::Closure
            && matches!(item.value, Payload::Reference(_))
        {
            let Payload::Reference(cell) = item.value else {
                unreachable!()
            };
            let value = self.slots.get(cell);
            return Slot::of(value.kind, value.value);
        }
        Slot::of(item.kind, item.value)
    }

    /// Set array item `index = value` (XS's `fxSetIndexProperty` +
    /// `fxRunDefine`). Grows the item chunk when the index is new (metered by
    /// [`Self::array_item_grow_metering`]) and bumps `length` when the index
    /// reaches past the end; `define` adds the `fxRunDefine` built-in step.
    pub(super) fn array_item_set(
        &mut self,
        inst: crate::value::SlotIndex,
        index: u32,
        value: Slot,
        define: bool,
    ) {
        if self.arguments_objects.contains(&inst) {
            if let Some(Slot {
                kind: Kind::Closure,
                value: Payload::Reference(cell),
                ..
            }) = self.arrays[&inst].items().get(&index).copied()
            {
                let target = self.slots.get_mut(cell);
                target.kind = value.kind;
                target.value = value.value;
                if define {
                    self.meter.tick_raw(ARRAY_ITEM_DEFINE_STEP_METERING);
                }
                return;
            }
        }
        let is_new = !self
            .arrays
            .get(&inst)
            .map(|a| a.items().contains_key(&index))
            .unwrap_or(false);
        if is_new {
            let present = self.arrays[&inst].items().len() as u64;
            self.meter.tick_raw(self.array_item_grow_metering(present));
        }
        if define {
            self.meter.tick_raw(ARRAY_ITEM_DEFINE_STEP_METERING);
        }
        if let Some(a) = self.arrays.get_mut(&inst) {
            let mut v = value;
            v.id = 0;
            v.next = crate::value::SlotIndex::NULL;
            // A write to an EXISTING item replaces its value and leaves its
            // attributes alone, as XS's `fxOrdinarySetProperty` writes
            // `kind`/`value` into the slot it found without touching `flag`.
            //
            // Taking the incoming value's flag (always the default 0) instead
            // is a SEAL BYPASS: `Object.seal` marks each element
            // non-configurable, and a sealed element is still writable, so
            // `a[1] = 9` would clear the very `XS_DONT_DELETE_FLAG` that seal
            // had just stamped and `delete a[1]` would then succeed —
            // `false|9` on XS, `true|undefined` here. It was unreachable
            // while sealing PROMOTED each element out of the item map; making
            // seal stamp items in place is what exposed it.
            v.flag = a.items().get(&index).map_or(v.flag, |item| item.flag);
            a.insert_item(index, v, &mut self.side_refs);
            if index + 1 > a.length {
                a.length = index + 1;
            }
        }
    }

    /// The raw 16.16 chunk-growth cost of appending one item to an array that
    /// already holds `present` items (XS's `fxNewChunk`/`fxRenewChunk` of the
    /// item chunk to `present + 1` slots). XS meters the *adjusted* requested
    /// size: `fxAdjustChunkSize((present+1) * sizeof(txSlot))` with
    /// `sizeof(txSlot) == 32` on the 64-bit oracle target, i.e.
    /// `round_up_8((present+1)*32) + sizeof(txChunk)` = `(present+1)*32 + 16`
    /// (the payload is already 8-aligned). Verified against the pin: an
    /// N-element literal's per-element chunk cost is 48, 80, 112, 144, ….
    ///
    /// Known sub-computron residual: a *spread* segment appending into an
    /// already-populated array carries a −8-raw-per-segment gap (ironhorse
    /// over-charges by 8) versus XS's item-chunk over-allocation
    /// (`fxNewGrowableChunk`/`fxSizeToCapacity`) growth path. It is well under
    /// one computron and never crosses a `>> 16` boundary in a bounded program,
    /// so the computron-level bar (and every corpus/fuzz/test262 check, which
    /// compare `meterIndex >> 16`) stays exact; modeling the over-allocation
    /// capacity to close the raw gap is a later refinement.
    pub(super) fn array_item_grow_metering(&self, present: u64) -> u64 {
        let bytes = (present + 1) * ARRAY_ITEM_BYTES;
        // round up to 8 (already a multiple of 8) + 16-byte chunk header.
        (((bytes + CHUNK_ALIGNMENT - 1) & !(CHUNK_ALIGNMENT - 1)) + CHUNK_HEADER_BYTES)
            * CHUNK_ALLOCATION_METERING
    }

    /// Whether an Array exotic's non-configurable `length` data property is
    /// writable. The instance slot's property-only `XS_DONT_SET_FLAG` bit is
    /// otherwise unused on instances, travels in the ordinary slot snapshot,
    /// and therefore keeps this bit of exotic state durable without another
    /// side-table/schema row.
    pub(super) fn array_length_writable(&self, inst: crate::value::SlotIndex) -> bool {
        self.slots.get(inst).flag & XS_DONT_SET_FLAG == 0
    }

    pub(super) fn set_array_length_writable(
        &mut self,
        inst: crate::value::SlotIndex,
        writable: bool,
    ) {
        if writable {
            self.slots.get_mut(inst).flag &= !XS_DONT_SET_FLAG;
        } else {
            self.slots.get_mut(inst).flag |= XS_DONT_SET_FLAG;
        }
    }

    /// Freeze one compiler-created template array in place. Template
    /// elements stay in the compact array table, whose `Slot::flag` carries
    /// the same non-writable/non-configurable bits as an XS item slot; the
    /// exotic `length` writable bit lives on the instance slot.
    pub(super) fn freeze_template_array(&mut self, inst: crate::value::SlotIndex) -> bool {
        let Some(array) = self.arrays.get_mut(&inst) else {
            return false;
        };
        self.slots.get_mut(inst).flag |= XS_DONT_PATCH_FLAG | XS_DONT_SET_FLAG;
        array.or_all_item_flags(XS_DONT_DELETE_FLAG | XS_DONT_SET_FLAG);
        for property in self.own_property_slots(inst) {
            let slot = self.slots.get_mut(property);
            slot.flag |= XS_DONT_DELETE_FLAG;
            if slot.flag & (XS_GETTER_FLAG | XS_SETTER_FLAG) == 0 {
                slot.flag |= XS_DONT_SET_FLAG;
            }
        }
        true
    }

    /// `XS_CODE_TEMPLATE`: freeze the cooked array, its non-enumerable `raw`
    /// property, and the raw array. The compiler has already created every
    /// element with the final descriptor flags; this closes extensibility and
    /// the two exotic `length` properties just as XS's handler does.
    pub(super) fn freeze_template_object(&mut self, cooked: crate::value::SlotIndex) -> bool {
        let Some(raw_id) = self.symbol_ids.get("raw").copied() else {
            return false;
        };
        let Some(raw_property) = self.find_property(cooked, raw_id) else {
            return false;
        };
        let raw = match self.slots.get(raw_property).value {
            Payload::Reference(raw) => raw,
            _ => return false,
        };
        if !self.freeze_template_array(raw) || !self.freeze_template_array(cooked) {
            return false;
        }
        let property = self.slots.get_mut(raw_property);
        property.flag |= XS_DONT_DELETE_FLAG | XS_DONT_ENUM_FLAG | XS_DONT_SET_FLAG;
        true
    }

    /// Set an array's `length` after the caller has performed the observable
    /// numeric coercion (XS's `fxArrayLengthSetter` → `fxSetArrayLength`).
    /// Growing past the current length adds holes; shrinking drops compact
    /// items and any materialized configurable index descriptors at or above
    /// the new length. A non-configurable materialized index stops the shrink
    /// at `index + 1`, as ArraySetLength requires. Returns the internal-method
    /// boolean; assignment decides whether a false result throws from strict
    /// code.
    pub(super) fn array_set_length(&mut self, inst: crate::value::SlotIndex, value: Slot) -> bool {
        self.meter.tick_raw(ARRAY_LENGTH_SET_METERING);
        let Some(new_len) = self.checked_array_length(value) else {
            return false;
        };
        let old_len = self.arrays[&inst].length;
        if new_len != old_len && !self.array_length_writable(inst) {
            return false;
        }
        if new_len < old_len {
            let mut indices: Vec<(u32, Option<u16>)> = self
                .own_property_slots(inst)
                .into_iter()
                .filter_map(|property| {
                    let id = self.slots.get(property).id;
                    self.scalar_key_text(id)
                        .and_then(|name| string_to_index(&name))
                        .filter(|index| *index >= new_len)
                        .map(|index| (index, Some(id)))
                })
                .collect();
            indices.extend(
                self.arrays[&inst]
                    .items()
                    .range(new_len..)
                    .map(|(&index, _)| (index, None)),
            );
            indices.sort_unstable_by_key(|(index, _)| std::cmp::Reverse(*index));
            for (index, ordinary_id) in indices {
                if let Some(id) = ordinary_id {
                    if !self.delete_own_property(inst, id) {
                        self.arrays.get_mut(&inst).unwrap().length = index + 1;
                        return false;
                    }
                } else {
                    // An item can be non-configurable now that
                    // `array_define_index` stamps attributes onto the item
                    // slot instead of promoting it to a named property, so
                    // this branch has to refuse the same way the named branch
                    // above does. `ArraySetLength` (ECMA-262 10.4.2.4) stops
                    // at the first index it cannot delete, leaves `length` one
                    // past it, and returns false — without this,
                    // `Object.seal(a); a.length = 1` silently truncated a
                    // sealed array.
                    if self.arrays[&inst].items()[&index].flag & XS_DONT_DELETE_FLAG != 0 {
                        self.arrays.get_mut(&inst).unwrap().length = index + 1;
                        return false;
                    }
                    self.arrays
                        .get_mut(&inst)
                        .unwrap()
                        .remove_item(&index, &mut self.side_refs);
                }
            }
        }
        self.arrays.get_mut(&inst).unwrap().length = new_len;
        true
    }

    /// A valid array length (`fxCheckArrayLength`): a non-negative integer in
    /// `[0, 2^32-1]`. Returns `None` for a fractional or out-of-range number
    /// (XS throws a `RangeError` there — out of the covered set).
    pub(super) fn checked_array_length(&self, value: Slot) -> Option<u32> {
        match value.value {
            Payload::Integer(i) if i >= 0 => Some(i as u32),
            Payload::Number(n) if n >= 0.0 && n.fract() == 0.0 && n <= 4294967295.0 => {
                Some(n as u32)
            }
            _ => None,
        }
    }

    /// `ArraySetLength` for a property descriptor. `ToUint32`/`ToNumber` is
    /// represented by the shared observable `ToNumber` path followed by the
    /// exact array-length range/integrality check; a mismatch is the spec's
    /// catchable `RangeError`. Attribute checks happen after value coercion.
    pub(super) fn array_define_length(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        descriptor: OrdinaryDescriptor,
    ) -> Result<bool, Step> {
        let requested_nonwritable = descriptor.writable == Some(false);
        let new_length = if let Some(value) = descriptor.value {
            // ArraySetLength performs ToUint32(value) and then ToNumber(value)
            // as two distinct observable coercions. For an object value this
            // deliberately invokes valueOf/toString twice, in that order.
            let primitive = self.to_primitive(code, value, false)?;
            if primitive.kind == Kind::Symbol {
                return Err(
                    self.catchable_type_error_msg("cannot coerce symbol to unsigned".into())
                );
            }
            if primitive.kind == Kind::BigInt {
                return Err(self.catchable_type_error_msg("cannot coerce to unsigned".into()));
            }
            let uint32_number = self.to_number_f64(code, primitive)?;
            let new_len = if !uint32_number.is_finite() || uint32_number == 0.0 {
                0
            } else {
                uint32_number.trunc().rem_euclid(4_294_967_296.0) as u32
            };
            let number = self.to_number_f64(code, value)?;
            if !number.is_finite()
                || number < 0.0
                || number != new_len as f64
                || number.fract() != 0.0
            {
                return Err(self.catchable_range_error_msg("invalid length".into()));
            }
            Some((new_len, number))
        } else {
            None
        };

        if descriptor.is_accessor()
            || descriptor.configurable == Some(true)
            || descriptor.enumerable == Some(true)
            || (!self.array_length_writable(inst) && descriptor.writable == Some(true))
        {
            return Ok(false);
        }

        if let Some((new_len, number)) = new_length {
            let old_len = self.arrays[&inst].length;
            if new_len != old_len && !self.array_length_writable(inst) {
                return Ok(false);
            }
            if !self.array_set_length(inst, Slot::number(number)) {
                if requested_nonwritable {
                    self.set_array_length_writable(inst, false);
                }
                return Ok(false);
            }
        }
        if requested_nonwritable {
            self.set_array_length_writable(inst, false);
        }
        Ok(true)
    }

    /// Array exotic `[[DefineOwnProperty]]` for an integer index. Compact
    /// elements carry data-descriptor restrictions in `Slot::flag`. On an
    /// accessor redefinition, move that element into the ordinary property
    /// chain so the existing descriptor, accessor, snapshot, and GC machinery
    /// carries the full shape. The side item is removed, making array
    /// algorithms select their generic MOP path.
    ///
    /// `id` is the index's interned name, or `None` when the name table has
    /// never held it. `None` is not a weaker form of the same call: a name
    /// that was never minted cannot key an ordinary shadow slot or an
    /// `accessors` entry, so the two lookups it would serve provably miss, and
    /// only the accessor path below — which genuinely creates a named
    /// property — has to mint one.
    pub(super) fn array_define_index(
        &mut self,
        inst: crate::value::SlotIndex,
        id: Option<u16>,
        index: u32,
        descriptor: OrdinaryDescriptor,
    ) -> bool {
        let old_len = self.arrays[&inst].length;
        if index >= old_len && !self.array_length_writable(inst) {
            return false;
        }

        if let Some(id) = id {
            if let Some(current) = self.ordinary_get_own_descriptor(inst, id) {
                if !self.is_compatible_descriptor(
                    self.instance_extensible(inst),
                    &descriptor,
                    Some(&current),
                ) {
                    return false;
                }
                let accepted = self.ordinary_define_own_property(inst, id, descriptor);
                if accepted && index >= old_len {
                    self.arrays.get_mut(&inst).unwrap().length = index + 1;
                }
                return accepted;
            }
        }

        if let Some(value) = self.arrays[&inst].items().get(&index).copied() {
            let observable_value = self.array_item_value(inst, value);
            let current = OrdinaryDescriptor {
                value: Some(observable_value),
                writable: Some(value.flag & XS_DONT_SET_FLAG == 0),
                enumerable: Some(value.flag & XS_DONT_ENUM_FLAG == 0),
                configurable: Some(value.flag & XS_DONT_DELETE_FLAG == 0),
                ..OrdinaryDescriptor::default()
            };
            if !self.is_compatible_descriptor(true, &descriptor, Some(&current)) {
                return false;
            }
            let mapped_cell = match (value.kind, value.value) {
                (Kind::Closure, Payload::Reference(cell))
                    if self.arguments_objects.contains(&inst) =>
                {
                    Some(cell)
                }
                _ => None,
            };
            if let Some(cell) = mapped_cell {
                if !descriptor.is_accessor() {
                    if let Some(new_value) = descriptor.value {
                        let target = self.slots.get_mut(cell);
                        target.kind = new_value.kind;
                        target.value = new_value.value;
                    }
                    let mut flag = value.flag;
                    if let Some(writable) = descriptor.writable {
                        if writable {
                            flag &= !XS_DONT_SET_FLAG;
                        } else {
                            flag |= XS_DONT_SET_FLAG;
                        }
                    }
                    if let Some(enumerable) = descriptor.enumerable {
                        if enumerable {
                            flag &= !XS_DONT_ENUM_FLAG;
                        } else {
                            flag |= XS_DONT_ENUM_FLAG;
                        }
                    }
                    if let Some(configurable) = descriptor.configurable {
                        if configurable {
                            flag &= !XS_DONT_DELETE_FLAG;
                        } else {
                            flag |= XS_DONT_DELETE_FLAG;
                        }
                    }
                    if descriptor.writable == Some(false) {
                        let current = self.slots.get(cell);
                        let mut replacement = Slot::of(current.kind, current.value);
                        replacement.flag = flag;
                        self.arrays.get_mut(&inst).unwrap().insert_item(
                            index,
                            replacement,
                            &mut self.side_refs,
                        );
                    } else {
                        self.arrays
                            .get_mut(&inst)
                            .unwrap()
                            .set_item_flag(index, flag);
                    }
                    return true;
                }
            }
            // XS stamps the ITEM SLOT in place. `fxArrayDefineOwnProperty`
            // hands an index straight to `fxOrdinaryDefineOwnProperty`
            // (`xsType.c`), which takes `mxBehaviorGetProperty(…, id, index,
            // XS_OWN)` — the slot living inside the array's item chunk — and
            // writes that slot's flag and value. Nothing is promoted to a
            // named property, so nothing is interned.
            //
            // Ironhorse cannot follow XS for an ACCESSOR: `self.accessors` is
            // keyed by `(instance, id)`, so a getter/setter on an index needs
            // a real name and still promotes below. Every DATA descriptor,
            // though — including the `{writable: false, configurable: false}`
            // that `Object.freeze` stamps on each element — is exactly the
            // item slot's three flags plus its value.
            //
            // Promoting each element instead made `Object.freeze` on a
            // 70,000-element array mint a key per element, walking the `u16`
            // id space into the saturation guard that POISONS the machine
            // (`harden`, which Hardened JS is built on, is `Object.freeze`
            // over a graph). It also made the freeze quadratic: each promoted
            // element lengthened the named chain the next element's
            // `find_property` has to scan.
            if !descriptor.is_accessor() {
                let mut flag = value.flag;
                if let Some(writable) = descriptor.writable {
                    if writable {
                        flag &= !XS_DONT_SET_FLAG;
                    } else {
                        flag |= XS_DONT_SET_FLAG;
                    }
                }
                if let Some(enumerable) = descriptor.enumerable {
                    if enumerable {
                        flag &= !XS_DONT_ENUM_FLAG;
                    } else {
                        flag |= XS_DONT_ENUM_FLAG;
                    }
                }
                if let Some(configurable) = descriptor.configurable {
                    if configurable {
                        flag &= !XS_DONT_DELETE_FLAG;
                    } else {
                        flag |= XS_DONT_DELETE_FLAG;
                    }
                }
                match descriptor.value {
                    // A new value replaces the item, so the side-reference
                    // counts move with it.
                    Some(mut replacement) => {
                        replacement.id = 0;
                        replacement.flag = flag;
                        replacement.next = crate::value::SlotIndex::NULL;
                        self.arrays.get_mut(&inst).unwrap().insert_item(
                            index,
                            replacement,
                            &mut self.side_refs,
                        );
                    }
                    // Attributes only: the value and its reference topology
                    // are untouched, so stamp the flag where it lies.
                    None => {
                        self.arrays
                            .get_mut(&inst)
                            .unwrap()
                            .set_item_flag(index, flag);
                    }
                }
                return true;
            }
            // An accessor on an index: `self.accessors` is keyed by
            // `(instance, id)`, so this one genuinely needs a name.
            let id = self.array_index_promotion_id(id, index);
            self.arrays
                .get_mut(&inst)
                .unwrap()
                .remove_item(&index, &mut self.side_refs);
            self.set_own_unmetered_with_flag(inst, id, current.value.unwrap(), value.flag);
            return self.ordinary_define_own_property(inst, id, descriptor);
        }

        if !self.instance_extensible(inst) {
            return false;
        }
        let id = self.array_index_promotion_id(id, index);
        let accepted = self.ordinary_define_own_property(inst, id, descriptor);
        if accepted && index >= old_len {
            self.arrays.get_mut(&inst).unwrap().length = index + 1;
        }
        accepted
    }

    /// The name id for an array index that is about to become a real ordinary
    /// property, minting one only if the table has never held it.
    ///
    /// Unmetered, because XS charges nothing for it: XS never interns an index
    /// name at all (`fxOrdinaryDefineOwnProperty` addresses the item slot by
    /// `(XS_NO_ID, index)`), so a `tick_slot_alloc` here would be an
    /// overcharge, not parity.
    pub(super) fn array_index_promotion_id(&mut self, id: Option<u16>, index: u32) -> u16 {
        match id {
            Some(id) => id,
            None => self.intern_key_unmetered(index.to_string()),
        }
    }

    /// Array exotic `[[DefineOwnProperty]]` (ECMA-262 10.4.2.1): dispatch
    /// `length`, array-index strings, and ordinary expandos to their respective
    /// storage/validation paths.
    pub(super) fn array_define_own_property(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        id: u16,
        descriptor: OrdinaryDescriptor,
    ) -> Result<bool, Step> {
        let name = self.scalar_key_text(id);
        if name.as_deref() == Some("length") && !self.arguments_objects.contains(&inst) {
            return self.array_define_length(code, inst, descriptor);
        }
        if let Some(index) = name.as_deref().and_then(string_to_index) {
            return Ok(self.array_define_index(inst, Some(id), index, descriptor));
        }
        Ok(self.ordinary_define_own_property(inst, id, descriptor))
    }

    pub(super) fn new_object(&mut self) -> crate::value::SlotIndex {
        self.meter.tick_builtin();
        self.meter.tick_slot_alloc();
        // Ordinary objects chain to %Object.prototype% (the payload holds the
        // prototype). Property lookup stays own-only, so this is invisible to
        // reads; it exists for the `instanceof` prototype-chain walk.
        self.slots.alloc(Slot::instance(self.object_proto))
    }

    /// Find an own property slot of `inst` by key `id`, walking its
    /// `next`-linked property list. Every slot in the list is a property
    /// (XS's property slots hold the value directly, keyed by `id`), so
    /// the match is by `id` alone — a property slot's `kind` is the
    /// value's kind, not a separate marker.
    /// `Get(inst, @@toStringTag)` followed by the string check from
    /// `Object.prototype.toString`. The ordinary MOP lookup is load-bearing:
    /// `%TypedArray%.prototype` supplies the tag through a native accessor, and
    /// guest accessors must likewise run and propagate abrupt completions.
    pub(super) fn string_to_string_tag(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
    ) -> Result<Option<String>, Step> {
        let Some(tag_id) = self.well_known_symbol_property_id("toStringTag") else {
            return Ok(None);
        };
        let receiver = Slot::of(Kind::Reference, Payload::Reference(inst));
        let value = self.mop_get(code, inst, tag_id, receiver)?;
        Ok(match value {
            Slot {
                kind: Kind::String,
                value: Payload::String(off),
                ..
            } => Some(self.str_text(off)),
            _ => None,
        })
    }

    /// Whether `inst` stores its integer-indexed properties by INDEX, in
    /// [`Self::index_props`], rather than by name.
    ///
    /// True for an object whose `[[Set]]`/`[[DefineOwnProperty]]` is the
    /// ordinary one. An Array, TypedArray, `arguments` object, String wrapper
    /// or Proxy all answer an index through their own exotic behaviour and are
    /// excluded; so, for now, are the remaining side-table shapes that
    /// `is_ordinary_object` excludes, which keep naming their index expandos.
    pub(super) fn indexes_by_index(&self, inst: crate::value::SlotIndex) -> bool {
        self.is_ordinary_object(inst)
    }

    /// The value stored at `index` on `inst`, if `inst` keeps index properties
    /// by index and holds one there.
    pub(super) fn index_prop_item(
        &self,
        inst: crate::value::SlotIndex,
        index: u32,
    ) -> Option<Slot> {
        self.index_props
            .get(&inst)
            .and_then(|props| props.items().get(&index).copied())
    }

    /// Store `value` at `index` on `inst`, creating the store on first use —
    /// XS's `fxOrdinarySetProperty` growing its `XS_ARRAY_KIND` slot.
    pub(super) fn index_prop_set(
        &mut self,
        inst: crate::value::SlotIndex,
        index: u32,
        value: Slot,
    ) {
        // XS's `fxOrdinarySetProperty` (`xsType.c:727`) grows the instance's
        // `XS_ARRAY_KIND` slot: `fxNewSlot` for the holder on first use, then
        // `fxSetIndexProperty` → `fxSetIndexSize`, whose cost is the item
        // chunk's — the same resize `array_item_grow_metering` already models
        // for an exotic array's items, since it is the same XS function.
        // Replacing an item in place resizes nothing.
        if self.index_prop_item(inst, index).is_none() {
            let props = self.index_props.get(&inst);
            let present = props.map_or(0, |props| props.items().len() as u64);
            if props.is_none() {
                self.meter.tick_slot_alloc();
            }
            let grow = self.array_item_grow_metering(present);
            self.meter.tick_raw(grow);
        }
        self.index_prop_store(inst, index, value);
    }

    /// [`Self::index_prop_set`] without the growth metering — the resume path,
    /// which rebuilds a store that was already paid for when the guest built
    /// it. Charging here would make a resumed machine's meter diverge from the
    /// uninterrupted one it must agree with.
    pub(super) fn index_prop_store(
        &mut self,
        inst: crate::value::SlotIndex,
        index: u32,
        mut value: Slot,
    ) {
        value.id = crate::value::XS_NO_ID;
        value.next = crate::value::SlotIndex::NULL;
        let refs = &mut self.side_refs;
        let props = self.index_props.entry(inst).or_default();
        props.insert_item(index, value, refs);
        // `ArrayData::length` is this store's HIGH-WATER mark, not an array
        // `length` (an ordinary object has none). It only ever rises, so a
        // deleted index keeps the cursor domain it opened — XS's resident
        // indexed-array slot does not shrink when an element is deleted, and
        // `resident_indexed_limit` reads this as the tombstone it documents.
        props.length = props.length.max(index.saturating_add(1));
    }

    /// Remove the property at `index`. The store itself STAYS once it has held
    /// anything: its high-water mark is the tombstone
    /// [`Self::resident_indexed_limit`] relies on, so an object that no longer
    /// keeps an index property is deliberately distinguishable from one that
    /// never did.
    pub(super) fn index_prop_remove(
        &mut self,
        inst: crate::value::SlotIndex,
        index: u32,
    ) -> Option<Slot> {
        let refs = &mut self.side_refs;
        let removed = self
            .index_props
            .get_mut(&inst)
            .and_then(|props| props.remove_item(&index, refs));
        if self
            .index_props
            .get(&inst)
            .is_some_and(|props| props.items().is_empty() && props.length == 0)
        {
            self.index_props.remove(&inst);
        }
        removed
    }

    /// Every index this object holds, ascending — the order
    /// `fxQueueIndexKeys` produces, which is the order `[[OwnPropertyKeys]]`
    /// and `for-in` both need.
    pub(super) fn index_prop_indices(&self, inst: crate::value::SlotIndex) -> Vec<u32> {
        self.index_props
            .get(&inst)
            .map(|props| props.items().keys().copied().collect())
            .unwrap_or_default()
    }

    /// The own descriptor of the index property at `index` on `inst`, read out
    /// of the index store. Item flags carry the attributes exactly as an
    /// array's items do.
    pub(super) fn index_prop_descriptor(
        &self,
        inst: crate::value::SlotIndex,
        index: u32,
    ) -> Option<OrdinaryDescriptor> {
        let item = self.index_prop_item(inst, index)?;
        Some(OrdinaryDescriptor {
            value: Some(Slot::of(item.kind, item.value)),
            writable: Some(item.flag & XS_DONT_SET_FLAG == 0),
            enumerable: Some(item.flag & XS_DONT_ENUM_FLAG == 0),
            configurable: Some(item.flag & XS_DONT_DELETE_FLAG == 0),
            ..OrdinaryDescriptor::default()
        })
    }

    /// `OrdinarySet(O, ToString(index), V, Receiver)` keyed by INDEX.
    ///
    /// The same walk as [`Self::ordinary_set`], reading each level's own
    /// descriptor by index instead of by name, so a write to a novel index on
    /// an ordinary object neither needs nor mints a property name.
    ///
    /// Returns `Ok(None)` when the walk reaches a prototype whose `[[Set]]` is
    /// not this algorithm — a Proxy, or a TypedArray answering an integer
    /// index — because delegating to those requires the key the trap or the
    /// exotic will be handed. The caller resolves a name for that narrow shape
    /// and retries by id, which keeps the trap observable at the cost of one
    /// name.
    pub(super) fn ordinary_index_set(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        index: u32,
        value: Slot,
        receiver: Slot,
    ) -> Result<Option<bool>, Step> {
        let mut current = inst;
        loop {
            let own = self
                .index_prop_descriptor(current, index)
                .or_else(|| self.named_index_descriptor(current, index))
                .or_else(|| self.exotic_index_own_descriptor(current, index));
            if let Some(descriptor) = own {
                if descriptor.is_accessor() {
                    let setter = descriptor.set.unwrap_or_else(Slot::undefined);
                    if setter.kind == Kind::Undefined {
                        return Ok(Some(false));
                    }
                    self.invoke_setter(code, setter, receiver, value)?;
                    return Ok(Some(true));
                }
                if descriptor.writable == Some(false) {
                    return Ok(Some(false));
                }
                break;
            }
            let parent = self.instance_prototype(current);
            if parent.is_null() {
                break;
            }
            // A Proxy's `set` trap and a TypedArray's integer-indexed
            // `[[Set]]` are observable behaviour, not a descriptor read, so
            // they cannot be flattened into this walk.
            if self.proxies.contains_key(&parent) || self.typed_arrays.contains_key(&parent) {
                return Ok(None);
            }
            current = parent;
        }
        let receiver_inst = match receiver.value {
            Payload::Reference(receiver_inst) if receiver.kind == Kind::Reference => receiver_inst,
            _ => return Ok(Some(false)),
        };
        if receiver_inst != inst || !self.indexes_by_index(receiver_inst) {
            // A different or non-ordinary receiver completes through the
            // general path, which knows that receiver's own storage.
            return Ok(None);
        }
        // CreateDataProperty / update, on the receiver.
        match self.index_prop_item(receiver_inst, index) {
            Some(existing) => {
                if existing.flag & XS_DONT_SET_FLAG != 0 {
                    return Ok(Some(false));
                }
                let mut replacement = value;
                replacement.flag = existing.flag;
                self.index_prop_set(receiver_inst, index, replacement);
            }
            None => {
                if !self.instance_extensible(receiver_inst) {
                    return Ok(Some(false));
                }
                self.index_prop_set(receiver_inst, index, value);
            }
        }
        Ok(Some(true))
    }

    /// The index store's descriptor for a property arrived at by NAME.
    ///
    /// Guarded on the store existing at all, so an object that has never held
    /// an index property pays one hash lookup and never the reverse name
    /// resolution.
    pub(super) fn index_prop_descriptor_by_id(
        &self,
        inst: crate::value::SlotIndex,
        id: u16,
    ) -> Option<OrdinaryDescriptor> {
        if !self.index_props.contains_key(&inst) {
            return None;
        }
        let index = string_to_index(&self.scalar_key_text(id)?)?;
        self.index_prop_descriptor(inst, index)
    }

    /// The index this `id` names, when `inst` actually keeps an index store.
    pub(super) fn index_prop_index_of_id(
        &self,
        inst: crate::value::SlotIndex,
        id: u16,
    ) -> Option<u32> {
        if !self.index_props.contains_key(&inst) {
            return None;
        }
        let index = string_to_index(&self.scalar_key_text(id)?)?;
        self.index_prop_item(inst, index).map(|_| index)
    }

    /// `ValidateAndApplyPropertyDescriptor` against the index store.
    ///
    /// `None` means this store cannot represent the definition and the caller
    /// must resolve a name: an ACCESSOR (whose getter/setter live in
    /// `self.accessors`, keyed by `(instance, id)`), or an index that already
    /// has an ordinary named slot, which stays where it is.
    pub(super) fn index_prop_define(
        &mut self,
        inst: crate::value::SlotIndex,
        index: u32,
        descriptor: OrdinaryDescriptor,
    ) -> Option<bool> {
        if descriptor.is_accessor() {
            return None;
        }
        if self
            .index_read_key_id(index)
            .is_some_and(|id| self.find_property(inst, id).is_some())
        {
            return None;
        }
        match self.index_prop_item(inst, index) {
            Some(item) => {
                let current = self.index_prop_descriptor(inst, index)?;
                if !self.is_compatible_descriptor(
                    self.instance_extensible(inst),
                    &descriptor,
                    Some(&current),
                ) {
                    return Some(false);
                }
                let mut flag = item.flag;
                if let Some(writable) = descriptor.writable {
                    if writable {
                        flag &= !XS_DONT_SET_FLAG;
                    } else {
                        flag |= XS_DONT_SET_FLAG;
                    }
                }
                if let Some(enumerable) = descriptor.enumerable {
                    if enumerable {
                        flag &= !XS_DONT_ENUM_FLAG;
                    } else {
                        flag |= XS_DONT_ENUM_FLAG;
                    }
                }
                if let Some(configurable) = descriptor.configurable {
                    if configurable {
                        flag &= !XS_DONT_DELETE_FLAG;
                    } else {
                        flag |= XS_DONT_DELETE_FLAG;
                    }
                }
                let mut replacement = descriptor
                    .value
                    .unwrap_or_else(|| Slot::of(item.kind, item.value));
                replacement.flag = flag;
                self.index_prop_set(inst, index, replacement);
                Some(true)
            }
            None => {
                if !self.instance_extensible(inst) {
                    return Some(false);
                }
                // An absent property takes `false` for every attribute the
                // descriptor omits.
                let mut flag = 0u8;
                if !descriptor.writable.unwrap_or(false) {
                    flag |= XS_DONT_SET_FLAG;
                }
                if !descriptor.enumerable.unwrap_or(false) {
                    flag |= XS_DONT_ENUM_FLAG;
                }
                if !descriptor.configurable.unwrap_or(false) {
                    flag |= XS_DONT_DELETE_FLAG;
                }
                let mut item = descriptor.value.unwrap_or_else(Slot::undefined);
                item.flag = flag;
                self.index_prop_set(inst, index, item);
                Some(true)
            }
        }
    }

    /// The own descriptor for `index` spelled as a NAME, when the name is
    /// already interned and the object carries an ordinary slot under it.
    ///
    /// An index property created before this store existed — or by a
    /// `defineProperty` that needed a name, such as an accessor — lives in the
    /// named chain, and both storages have to be consulted.
    pub(super) fn named_index_descriptor(
        &self,
        inst: crate::value::SlotIndex,
        index: u32,
    ) -> Option<OrdinaryDescriptor> {
        let id = self.index_read_key_id(index)?;
        self.ordinary_get_own_descriptor(inst, id)
    }

    /// The own descriptor an EXOTIC receiver synthesizes for `index` — a
    /// String wrapper's unit, a function's synthetic own names, and so on.
    pub(super) fn exotic_index_own_descriptor(
        &mut self,
        inst: crate::value::SlotIndex,
        index: u32,
    ) -> Option<OrdinaryDescriptor> {
        let id = self.index_read_key_id(index)?;
        self.exotic_own_descriptor(inst, id)
    }

    pub(super) fn find_property(
        &self,
        inst: crate::value::SlotIndex,
        id: u16,
    ) -> Option<crate::value::SlotIndex> {
        self.slots.find_property(inst, id)
    }

    /// Whether `inst` is an *ordinary* object — one whose whole own-property
    /// set lives in the slot-arena property chain, with no exotic side table
    /// (array/typed-array/collection/buffer/view/wrapper). Error instances are
    /// ordinary objects for MOP purposes: their `message`/`cause` properties
    /// live entirely in this same slot chain; `error_data` only accelerates
    /// Error.prototype.toString.
    /// Callers use this only when they specifically require a slot-chain-only
    /// receiver; reflection and integrity operations instead route through the
    /// complete `mop_*` dispatchers.
    pub(super) fn is_ordinary_object(&self, inst: crate::value::SlotIndex) -> bool {
        !(self.arrays.contains_key(&inst)
            || self.collections.contains_key(&inst)
            || self.typed_arrays.contains_key(&inst)
            || self.array_buffers.contains_key(&inst)
            || self.data_views.contains_key(&inst)
            || self.wrapper_data.contains_key(&inst)
            || self.regexps.contains_key(&inst)
            || self.proxies.contains_key(&inst))
    }

    /// The slot indices of every own property of `inst`, in creation
    /// (insertion) order — XS's `mxBehaviorOwnKeys` over the property chain,
    /// unfiltered (data and accessor, enumerable or not). Used by the
    /// integrity operations, which stamp/read a flag on *every* own property.
    pub(super) fn own_property_slots(
        &self,
        inst: crate::value::SlotIndex,
    ) -> Vec<crate::value::SlotIndex> {
        let mut out = Vec::new();
        let mut cur = self.slots.get(inst).next;
        while !cur.is_null() {
            let slot = self.slots.get(cur);
            if slot.flag & XS_INTERNAL_FLAG == 0 {
                out.push(cur);
            }
            cur = slot.next;
        }
        // Newest-first chain → creation order.
        out.reverse();
        out
    }

    /// Whether instance `inst` is extensible (XS's `mxBehaviorIsExtensible`):
    /// its own `XS_INSTANCE_KIND` slot does not carry `XS_DONT_PATCH_FLAG`.
    pub(super) fn instance_extensible(&self, inst: crate::value::SlotIndex) -> bool {
        self.slots.get(inst).flag & XS_DONT_PATCH_FLAG == 0
    }

    /// The global `harden(x)` (`fx_harden` + `fx_hardenFreezeAndTraverse` +
    /// `fx_hardenQueue`, `xsLockdown.c`): the transitive freeze worklist over
    /// the slot arena. Prevent extensions and stamp every own data property
    /// non-writable/non-configurable (accessors non-configurable) on each
    /// reached instance, then queue its prototype and every reference-valued
    /// own property, marking each reached instance `XS_DONT_MARSHALL_FLAG` so
    /// the graph is walked once. Returns `x` (the argument). A non-reference
    /// argument, an already-hardened object, and `harden()` with no argument
    /// pass through per XS. `xsLockdown.c` calls no `mxMeter`, so the cost is
    /// the allocation constants; computron parity over a transitive walk into
    /// ironhorse's sparse intrinsics is structurally unavailable, so the corpus is
    /// result-gated (the freeze *result* is faithful).
    pub(super) fn do_harden(&mut self, code: &[u8], arg0: Slot) -> Result<Slot, Step> {
        if arg0.kind != Kind::Reference {
            return Ok(arg0);
        }
        let inst = match arg0.value {
            Payload::Reference(i) => i,
            _ => return Ok(arg0),
        };
        // Already hardened: XS short-circuits (`slot->flag & flag`).
        if self.slots.get(inst).flag & XS_DONT_MARSHALL_FLAG != 0 {
            return Ok(arg0);
        }
        let mut list: Vec<crate::value::SlotIndex> = Vec::new();
        self.harden_enqueue(inst, &mut list);
        let mut i = 0;
        while i < list.len() {
            if let Err(halt) = self.harden_freeze_and_traverse(code, list[i], &mut list) {
                // `fx_harden` clears the visited/hardened bit from every item
                // accumulated in its worklist when any proxy trap or property
                // definition fails. A later harden attempt must retry rather
                // than short-circuit a partially frozen graph.
                for &queued in &list {
                    self.slots.get_mut(queued).flag &= !XS_DONT_MARSHALL_FLAG;
                }
                return Err(halt);
            }
            i += 1;
        }
        Ok(arg0)
    }

    /// `fx_hardenQueue`: mark `inst` hardened (`XS_DONT_MARSHALL_FLAG`, the
    /// visited set) and push it onto the worklist, skipping an already-marked
    /// instance. XS marks the instance during processing and checks the mark at
    /// enqueue; marking at enqueue is behaviorally identical (the mark is only a
    /// visited set — the freeze still happens in `harden_freeze_and_traverse`)
    /// and makes the Vec-backed walk terminate without duplicate entries.
    pub(super) fn harden_enqueue(
        &mut self,
        inst: crate::value::SlotIndex,
        list: &mut Vec<crate::value::SlotIndex>,
    ) {
        if inst.is_null() {
            return;
        }
        if self.slots.get(inst).flag & XS_DONT_MARSHALL_FLAG != 0 {
            return;
        }
        self.slots.get_mut(inst).flag |= XS_DONT_MARSHALL_FLAG;
        self.meter.tick_raw(HARDEN_QUEUE_ITEM_METERING);
        list.push(inst);
    }

    /// `fx_hardenFreezeAndTraverse`: freeze one instance and queue its
    /// referents. Both passes route through the full internal-method seam, so
    /// Proxy traps and exotic own properties are observed exactly where XS
    /// observes them. XS deliberately skips integer-indexed TypedArray
    /// elements: their descriptors cannot be made non-writable, while the
    /// receiver itself and any ordinary expandos are still hardened.
    pub(super) fn harden_freeze_and_traverse(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        list: &mut Vec<crate::value::SlotIndex>,
    ) -> Result<(), Step> {
        self.meter.tick_raw(HARDEN_OBJECT_BASE_METERING);
        if !self.mop_prevent_extensions(code, inst)? {
            return Err(self.catchable_type_error_msg("extensible object".into()));
        }
        let skip_indexes = self.typed_arrays.contains_key(&inst);
        for key in self.mop_own_keys(code, inst)? {
            self.meter.tick_raw(HARDEN_PER_KEY_METERING / 2);
            // Stamping flags OBSERVES the key set and rewrites existing
            // entries; it creates no name. `set_integrity_level` was taught
            // this and `harden` — which is the entry point a SES-shaped
            // engine actually calls — has its OWN loop, so it was left
            // minting a name per key: `Object.freeze(bigArray)` completed
            // while `harden(bigArray)`, the same freeze, still poisoned the
            // machine.
            let read_key = self.to_read_key(code, key)?;
            if skip_indexes && self.read_key_is_index(read_key) {
                continue;
            }
            let Some(current) = self.mop_get_own_property_read(code, inst, read_key)? else {
                continue;
            };
            let frozen = if current.is_accessor() {
                OrdinaryDescriptor {
                    configurable: Some(false),
                    ..OrdinaryDescriptor::default()
                }
            } else {
                OrdinaryDescriptor {
                    writable: Some(false),
                    configurable: Some(false),
                    ..OrdinaryDescriptor::default()
                }
            };
            // The descriptor read can run a proxy trap that names this index.
            let read_key = self.refresh_read_key(read_key);
            if !self.mop_define_own_property_read(code, inst, read_key, frozen)? {
                return Err(self.catchable_type_error_msg("cannot configure property".into()));
            }
        }

        let keys = self.mop_own_keys(code, inst)?;
        let proto = self.mop_get_prototype(code, inst)?;
        if let Payload::Reference(proto) = proto.value {
            self.harden_enqueue(proto, list);
        }
        for key in keys {
            self.meter.tick_raw(HARDEN_PER_KEY_METERING / 2);
            let read_key = self.to_read_key(code, key)?;
            let Some(descriptor) = self.mop_get_own_property_read(code, inst, read_key)? else {
                continue;
            };
            if let Some(value) = descriptor.value {
                if let Payload::Reference(referent) = value.value {
                    self.harden_enqueue(referent, list);
                }
            } else {
                for function in [descriptor.get, descriptor.set].into_iter().flatten() {
                    if let Payload::Reference(function) = function.value {
                        self.harden_enqueue(function, list);
                    }
                }
            }
        }
        Ok(())
    }

    /// The global `petrify(x)` (`fx_petrify`, `xsLockdown.c`): a *single*-object
    /// freeze (non-transitive, no prototype walk). Prevent extensions and stamp
    /// every configurable own property non-writable/non-configurable. XS skips
    /// immutable String indices and integer-indexed TypedArray elements, and
    /// separately marks mutable internal data read-only; IronHorse persists
    /// that state on the instance head because its internal data is side-table
    /// backed. Returns `x`.
    pub(super) fn do_petrify(&mut self, code: &[u8], arg0: Slot) -> Result<Slot, Step> {
        if arg0.kind != Kind::Reference {
            return Ok(arg0);
        }
        let inst = match arg0.value {
            Payload::Reference(i) => i,
            _ => return Ok(arg0),
        };
        self.meter.tick_raw(PETRIFY_OBJECT_BASE_METERING);
        if !self.mop_prevent_extensions(code, inst)? {
            return Err(self.catchable_type_error_msg("extensible object".into()));
        }
        let skip_indexes = self.typed_arrays.contains_key(&inst)
            || self
                .wrapper_data
                .get(&inst)
                .is_some_and(|value| value.kind == Kind::String);
        for key in self.mop_own_keys(code, inst)? {
            self.meter.tick_raw(PETRIFY_PER_KEY_METERING);
            // The same observation-only stamp as `harden` above, and the same
            // reason it must not mint: `petrify` is `harden`'s single-object
            // half and reaches every key of the object it is handed.
            let read_key = self.to_read_key(code, key)?;
            if skip_indexes && self.read_key_is_index(read_key) {
                continue;
            }
            let Some(current) = self.mop_get_own_property_read(code, inst, read_key)? else {
                continue;
            };
            let frozen = if current.is_accessor() {
                OrdinaryDescriptor {
                    configurable: Some(false),
                    ..OrdinaryDescriptor::default()
                }
            } else {
                OrdinaryDescriptor {
                    writable: Some(false),
                    configurable: Some(false),
                    ..OrdinaryDescriptor::default()
                }
            };
            let read_key = self.refresh_read_key(read_key);
            if !self.mop_define_own_property_read(code, inst, read_key, frozen)? {
                return Err(self.catchable_type_error_msg("cannot configure property".into()));
            }
        }
        if self.array_buffers.contains_key(&inst)
            || self.dates.contains_key(&inst)
            || self.collections.contains_key(&inst)
        {
            self.slots.get_mut(inst).flag |= XS_DONT_MODIFY_FLAG;
        }
        Ok(arg0)
    }

    /// Add one field of a synthesized property descriptor object (an own
    /// enumerable data property `name = value`), charging the same slot weight
    /// on ordinary and Proxy descriptor paths. The field name resolves
    /// through the global intern table so `descriptor.value` (etc.) reads back
    /// under the same id the program's `.value` access uses.
    pub(super) fn define_descriptor_field(
        &mut self,
        inst: crate::value::SlotIndex,
        name: &str,
        value: Slot,
    ) {
        self.meter.tick_slot_alloc();
        let id = self.intern_key(name);
        let head = self.slots.get(inst).next;
        let mut prop = value;
        prop.id = id;
        prop.flag = 0;
        prop.next = head;
        let idx = self.slots.alloc(prop);
        self.slots.get_mut(inst).next = idx;
    }

    /// The ordinary-object behavior seam. Proxy and exotic-object support can
    /// dispatch around these methods; all ordinary property operations route
    /// through them so descriptor compatibility cannot drift between syntax,
    /// `Object.*`, and `Reflect.*`.
    /// A function's exotic `length`/`name` as an own **data** descriptor
    /// `{writable:false, enumerable:false, configurable:true}`, synthesized from
    /// the [`FuncInfo`] — XS builds these as real own slots at
    /// `fxNewFunctionInstance`, their allocation pre-paid in
    /// [`FUNCTION_DEFINE_METERING`], so ironhorse mirrors them without a slot
    /// (no allocation, no metering). Returns `None` for a non-function, a name
    /// other than `length`/`name`, a pair the guest has `delete`d
    /// ([`Self::deleted_fn_meta`]), or when an ordinary slot already shadows the
    /// id (a `defineProperty` override wins). This is the single view all the
    /// reflective MOP paths consult so `getOwnPropertyDescriptor` /
    /// `hasOwnProperty` / a non-writable set / `delete` / `for-in` agree.
    pub(super) fn function_meta_own_descriptor(
        &self,
        inst: crate::value::SlotIndex,
        id: u16,
    ) -> Option<OrdinaryDescriptor> {
        let is_length = Some(id) == self.length_id;
        let is_name = Some(id) == self.name_id;
        if !(is_length || is_name) {
            return None;
        }
        let fi = self.functions.get(&inst)?;
        if self.deleted_fn_meta.contains(&(inst, id)) {
            return None;
        }
        let value = if is_length {
            Slot::integer(fi.arity as i32)
        } else {
            Slot::of(Kind::String, Payload::String(fi.name_chunk))
        };
        Some(OrdinaryDescriptor {
            value: Some(value),
            writable: Some(false),
            enumerable: Some(false),
            configurable: Some(true),
            ..OrdinaryDescriptor::default()
        })
    }

    pub(super) fn ordinary_get_own_descriptor(
        &self,
        inst: crate::value::SlotIndex,
        id: u16,
    ) -> Option<OrdinaryDescriptor> {
        let property = match self.find_property(inst, id) {
            Some(property) => property,
            // No ordinary own slot. An index property lives in the index
            // store instead of the named chain, and most callers arrive here
            // having interned its name (`getOwnPropertyDescriptor(o, '0')`),
            // so the two storages are bridged here rather than at every
            // caller.
            None => {
                return self
                    .index_prop_descriptor_by_id(inst, id)
                    .or_else(|| self.function_meta_own_descriptor(inst, id))
            }
        };
        let slot = self.slots.get(property);
        let enumerable = Some(slot.flag & XS_DONT_ENUM_FLAG == 0);
        let configurable = Some(slot.flag & XS_DONT_DELETE_FLAG == 0);
        if slot.flag & (XS_GETTER_FLAG | XS_SETTER_FLAG) != 0 {
            let accessor = self.accessors.get(&(inst, id)).copied().unwrap_or_default();
            Some(OrdinaryDescriptor {
                get: Some(accessor.get.unwrap_or_else(Slot::undefined)),
                set: Some(accessor.set.unwrap_or_else(Slot::undefined)),
                enumerable,
                configurable,
                ..OrdinaryDescriptor::default()
            })
        } else {
            Some(OrdinaryDescriptor {
                value: Some(Slot::of(slot.kind, slot.value)),
                writable: Some(slot.flag & XS_DONT_SET_FLAG == 0),
                enumerable,
                configurable,
                ..OrdinaryDescriptor::default()
            })
        }
    }

    /// ECMAScript SameValue, including NaN equality and distinct signed zeros.
    pub(super) fn same_value(&self, left: Slot, right: Slot) -> bool {
        match (numeric_of(&left), numeric_of(&right)) {
            (Some(a), Some(b)) => (a.is_nan() && b.is_nan()) || a.to_bits() == b.to_bits(),
            _ => self.strict_equal(&left, &right),
        }
    }

    /// Give a function's synthesized exotic `length`/`name` a real backing slot
    /// (unmetered — XS holds it as a real slot whose allocation is pre-paid in
    /// [`FUNCTION_DEFINE_METERING`]) so a `[[DefineOwnProperty]]` has an ordinary
    /// slot to mutate. A no-op unless `id` is a live (non-tombstoned) function
    /// `length`/`name` with no ordinary slot yet. Idempotent.
    pub(super) fn materialize_function_meta_slot(
        &mut self,
        inst: crate::value::SlotIndex,
        id: u16,
    ) {
        if self.find_property(inst, id).is_some() {
            return;
        }
        if let Some(desc) = self.function_meta_own_descriptor(inst, id) {
            let value = desc.value.unwrap_or_else(Slot::undefined);
            self.set_own_unmetered_with_flag(inst, id, value, XS_DONT_ENUM_FLAG | XS_DONT_SET_FLAG);
        }
    }

    /// Validate and apply a partial property descriptor (ECMA-262
    /// ValidateAndApplyPropertyDescriptor) to an ordinary object.
    pub(super) fn ordinary_define_own_property(
        &mut self,
        inst: crate::value::SlotIndex,
        id: u16,
        descriptor: OrdinaryDescriptor,
    ) -> bool {
        if descriptor.is_accessor() && descriptor.is_data() {
            return false;
        }
        // An index property on an ordinary object belongs in the index store.
        // Route it there when the store already holds it, or when this object
        // keeps indexes by index and has no named slot under this name — so a
        // `defineProperty` spelled by name lands in the same place a plain
        // write does, rather than creating a second, shadowing storage.
        if self.find_property(inst, id).is_none() {
            if let Some(index) = self
                .scalar_key_text(id)
                .as_deref()
                .and_then(string_to_index)
                .filter(|_| self.indexes_by_index(inst) || self.index_props.contains_key(&inst))
            {
                if let Some(accepted) = self.index_prop_define(inst, index, descriptor) {
                    return accepted;
                }
                // An accessor cannot live in the store, so the property
                // PROMOTES to a named slot. Carry its current value and
                // attributes across first: the define below validates against
                // whatever it finds, and finding nothing would treat a
                // redefinition as a creation and silently reset `enumerable`
                // and `configurable` to their absent-property defaults.
                if let Some(item) = self.index_prop_item(inst, index) {
                    self.index_prop_remove(inst, index);
                    let value = Slot::of(item.kind, item.value);
                    self.set_own_unmetered_with_flag(inst, id, value, item.flag);
                }
            }
        }
        // A function's `length`/`name` is synthesized from the `FuncInfo` with no
        // ordinary slot; redefining one must mutate a real slot (the update path
        // below unwraps `find_property`), so materialize it first. Then the
        // ordinary ValidateAndApply runs against the exotic descriptor's existing
        // attributes ({writable:false, configurable:true}), exactly as XS
        // redefines its real slot.
        self.materialize_function_meta_slot(inst, id);
        let current = self.ordinary_get_own_descriptor(inst, id);
        if current.is_none() {
            if !self.instance_extensible(inst) {
                return false;
            }
            let enumerable = descriptor.enumerable.unwrap_or(false);
            let configurable = descriptor.configurable.unwrap_or(false);
            let mut flag = 0u8;
            if !enumerable {
                flag |= XS_DONT_ENUM_FLAG;
            }
            if !configurable {
                flag |= XS_DONT_DELETE_FLAG;
            }
            let mut property = if descriptor.is_accessor() {
                flag |= XS_GETTER_FLAG | XS_SETTER_FLAG;
                self.accessors.insert(
                    (inst, id),
                    AccessorData {
                        get: descriptor.get.filter(|slot| slot.kind != Kind::Undefined),
                        set: descriptor.set.filter(|slot| slot.kind != Kind::Undefined),
                    },
                );
                Slot::undefined()
            } else {
                if !descriptor.writable.unwrap_or(false) {
                    flag |= XS_DONT_SET_FLAG;
                }
                descriptor.value.unwrap_or_else(Slot::undefined)
            };
            property.id = id;
            property.flag = flag;
            property.next = self.slots.get(inst).next;
            let index = self.slots.alloc(property);
            self.slots.get_mut(inst).next = index;
            if inst == self.global_obj {
                // The global object's property chain is also the backing set
                // for identifier resolution. Keep its fast index in lockstep
                // when an ordinary [[DefineOwnProperty]] creates a global via
                // `globalThis.x = value` or its computed equivalent.
                self.global_props.insert(id, index);
            }
            self.tick_property_create(id);
            return true;
        }

        let current = current.unwrap();
        let current_configurable = current.configurable.unwrap_or(false);
        if !current_configurable {
            if descriptor.configurable == Some(true)
                || descriptor
                    .enumerable
                    .is_some_and(|value| Some(value) != current.enumerable)
            {
                return false;
            }
        }
        let current_accessor = current.is_accessor();
        if (descriptor.is_accessor() || descriptor.is_data())
            && descriptor.is_accessor() != current_accessor
        {
            if !current_configurable {
                return false;
            }
        } else if !current_configurable {
            if !current_accessor && current.writable == Some(false) {
                if descriptor.writable == Some(true)
                    || descriptor
                        .value
                        .is_some_and(|value| !self.same_value(value, current.value.unwrap()))
                {
                    return false;
                }
            }
            if current_accessor {
                if descriptor
                    .get
                    .is_some_and(|value| !self.same_value(value, current.get.unwrap()))
                    || descriptor
                        .set
                        .is_some_and(|value| !self.same_value(value, current.set.unwrap()))
                {
                    return false;
                }
            }
        }

        let property = self.find_property(inst, id).unwrap();
        let old_flag = self.slots.get(property).flag;
        let target_accessor = if descriptor.is_accessor() || descriptor.is_data() {
            descriptor.is_accessor()
        } else {
            current_accessor
        };
        let enumerable = descriptor
            .enumerable
            .or(current.enumerable)
            .unwrap_or(false);
        let configurable = descriptor
            .configurable
            .or(current.configurable)
            .unwrap_or(false);
        let mut flag = old_flag
            & !(XS_DONT_ENUM_FLAG
                | XS_DONT_DELETE_FLAG
                | XS_DONT_SET_FLAG
                | XS_GETTER_FLAG
                | XS_SETTER_FLAG);
        if !enumerable {
            flag |= XS_DONT_ENUM_FLAG;
        }
        if !configurable {
            flag |= XS_DONT_DELETE_FLAG;
        }
        if target_accessor {
            flag |= XS_GETTER_FLAG | XS_SETTER_FLAG;
            let old = self.accessors.get(&(inst, id)).copied().unwrap_or_default();
            let get = descriptor
                .get
                .map(|slot| (slot.kind != Kind::Undefined).then_some(slot))
                .unwrap_or(old.get);
            let set = descriptor
                .set
                .map(|slot| (slot.kind != Kind::Undefined).then_some(slot))
                .unwrap_or(old.set);
            self.accessors.insert((inst, id), AccessorData { get, set });
            let slot = self.slots.get_mut(property);
            slot.kind = Kind::Undefined;
            slot.value = Payload::None;
            slot.flag = flag;
        } else {
            self.accessors.remove(&(inst, id));
            if !descriptor.writable.or(current.writable).unwrap_or(false) {
                flag |= XS_DONT_SET_FLAG;
            }
            let value = descriptor
                .value
                .or(current.value)
                .unwrap_or_else(Slot::undefined);
            let slot = self.slots.get_mut(property);
            slot.kind = value.kind;
            slot.value = value.value;
            slot.flag = flag;
        }
        true
    }

    /// Whether `id` resolves to an own or inherited property descriptor
    /// anywhere along `inst`'s prototype chain (used to distinguish a genuinely
    /// absent property from one bound to `undefined`). Proxies short-circuit to
    /// "present" — their `[[GetOwnProperty]]` trap decides, so the caller must
    /// not treat a proxy link as absence.
    pub(super) fn chain_has_descriptor(&mut self, inst: crate::value::SlotIndex, id: u16) -> bool {
        let mut owner = inst;
        while !owner.is_null() {
            if self.proxies.contains_key(&owner) {
                return true;
            }
            if self.ordinary_get_own_descriptor(owner, id).is_some() {
                return true;
            }
            owner = self.instance_prototype(owner);
        }
        false
    }

    /// Invoke an accessor `getter` with `receiver` as `this`. A user-function
    /// (or bound) getter runs through [`Self::run_callback`]; a **native-method**
    /// getter (the boot-installed `Intl.NumberFormat.prototype.format`) is
    /// dispatched directly through the native seam, since `run_callback`
    /// deliberately rejects native callees (`callback:non-user-function`). The
    /// native path builds the `[THIS, FUNCTION, RESULT, FRAME]` frame the call
    /// opcode would, dispatches with zero arguments, and pops the pushed result.
    pub(super) fn invoke_getter(
        &mut self,
        code: &[u8],
        getter: Slot,
        receiver: Slot,
    ) -> Result<Slot, Step> {
        if let Payload::Reference(f) = getter.value {
            // A `.call`/`.apply` or promise-resolving function used as an
            // accessor takes the abstract dispatcher, exactly as it does at
            // the `.call`/`.apply` trampolines: `call_native_method` refuses
            // those markers as "never reaches here".
            if self.needs_abstract_call(f, self.method_of(f)) {
                return self.invoke_value(code, getter, receiver, &[]);
            }
            if let Some(m) = self.method_of(f) {
                let base = self.stack.len();
                self.push(receiver);
                self.push(getter);
                self.push(Slot::undefined());
                self.push(Slot::of(Kind::Uninitialized, Payload::None));
                // On success `call_native_method` truncates to `base` and
                // pushes the result; on a throw it returns early WITHOUT
                // truncating, so restore the stack to `base` before
                // propagating — else the leaked frame corrupts the value stack.
                return match self.call_native_method(m, base, 0, code) {
                    Ok(()) => Ok(self.pop()),
                    Err(h) => {
                        self.stack.truncate(base);
                        Err(h)
                    }
                };
            }
        }
        self.run_callback(code, getter, receiver, &[])
    }

    /// Invoke an accessor setter with `receiver` as `this`. Boot accessors can
    /// carry native-method setters (the ES2025 Iterator prototype accessors),
    /// while guest accessors carry bytecode functions. Both paths deliberately
    /// discard the setter's return value.
    pub(super) fn invoke_setter(
        &mut self,
        code: &[u8],
        setter: Slot,
        receiver: Slot,
        value: Slot,
    ) -> Result<(), Step> {
        if let Payload::Reference(f) = setter.value {
            // The getter's rule, for the same reason.
            if self.needs_abstract_call(f, self.method_of(f)) {
                self.invoke_value(code, setter, receiver, &[value])?;
                return Ok(());
            }
            if let Some(m) = self.method_of(f) {
                let base = self.stack.len();
                self.push(receiver);
                self.push(setter);
                self.push(Slot::undefined());
                self.push(Slot::of(Kind::Uninitialized, Payload::None));
                self.push(value);
                return match self.call_native_method(m, base, 1, code) {
                    Ok(()) => {
                        let _ = self.pop();
                        Ok(())
                    }
                    Err(h) => {
                        self.stack.truncate(base);
                        Err(h)
                    }
                };
            }
        }
        let _ = self.run_callback(code, setter, receiver, &[value])?;
        Ok(())
    }

    pub(super) fn ordinary_get(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        id: u16,
        receiver: Slot,
    ) -> Result<Slot, Step> {
        let mut current = inst;
        loop {
            if let Some(descriptor) = self.ordinary_get_own_descriptor(current, id) {
                if descriptor.is_accessor() {
                    let getter = descriptor.get.unwrap_or_else(Slot::undefined);
                    if getter.kind == Kind::Undefined {
                        return Ok(Slot::undefined());
                    }
                    return self.invoke_getter(code, getter, receiver);
                }
                return Ok(descriptor.value.unwrap_or_else(Slot::undefined));
            }
            // OrdinaryGet step 4 delegates to the parent's full `[[Get]]`, not
            // to another ordinary slot-chain scan. This matters when the
            // prototype is a Proxy or carries Array/String/TypedArray exotic
            // own properties.
            let parent = self.instance_prototype(current);
            if parent.is_null() {
                return Ok(Slot::undefined());
            }
            let iterator_context_aimed_at_parent = self
                .array_iterator_proxy_get_context
                .is_some_and(|context| {
                    context.target == parent
                        && self.refresh_read_key(context.key) == ReadKey::Id(id)
                });
            if self.proxies.contains_key(&parent) || iterator_context_aimed_at_parent {
                return self.mop_get(code, parent, id, receiver);
            }
            // Every other parent's `[[Get]]` is `mop_get`'s non-Proxy path —
            // its exotic own surface, then this very algorithm — so perform
            // it in place, as XS's `fxGetProperty` loop does, rather than
            // nesting one native frame per prototype level (a `for` loop of
            // `Object.create`, or of `class extends`, builds a chain deep
            // enough to overflow the host stack that way). The exotic surface
            // is the one `mop_get_with_proxy_metering_inner` consults: a
            // TypedArray's integer index, then the side-table own data of an
            // array, function or String wrapper when no ordinary own slot
            // shadows it.
            if self.find_property(parent, id).is_none() {
                if let Some(&typed_array) = self.typed_arrays.get(&parent) {
                    if let Some(index) = self.ta_numeric_index_at(id, 0) {
                        return Ok(self.ta_indexed_element_get(typed_array, index));
                    }
                }
                if let Some(d) = self.exotic_own_descriptor(parent, id) {
                    if d.is_data() {
                        return Ok(d.value.unwrap_or_else(Slot::undefined));
                    }
                }
            }
            current = parent;
        }
    }

    pub(super) fn ordinary_set(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        id: u16,
        value: Slot,
        receiver: Slot,
    ) -> Result<bool, Step> {
        let mut current = inst;
        loop {
            // Functions keep their `length`, `name`, and (when constructable)
            // `prototype` own properties in side tables.  They participate in
            // OrdinarySet exactly like materialized own descriptors and must be
            // considered before an inherited non-writable property.
            let own = self
                .ordinary_get_own_descriptor(current, id)
                .or_else(|| self.exotic_own_descriptor(current, id));
            if let Some(descriptor) = own {
                if descriptor.is_accessor() {
                    let setter = descriptor.set.unwrap_or_else(Slot::undefined);
                    if setter.kind == Kind::Undefined {
                        return Ok(false);
                    }
                    self.invoke_setter(code, setter, receiver, value)?;
                    return Ok(true);
                }
                if descriptor.writable == Some(false) {
                    return Ok(false);
                }
                break;
            }
            // OrdinarySet delegates an own-property miss to the immediate
            // parent's complete `[[Set]]`. Do not flatten this into a
            // descriptor scan: a Proxy or integer-indexed exotic prototype
            // has behavior even when its own descriptor is absent.
            let parent = self.instance_prototype(current);
            if parent.is_null() {
                break;
            }
            // `mop_set` differs from this algorithm only for a Proxy and for a
            // TypedArray's integer-indexed element.
            let typed_array_element = self.typed_arrays.contains_key(&parent)
                && !self.is_symbol_key_id(id)
                && self
                    .scalar_key_text(id)
                    .and_then(|name| canonical_numeric_index_string(&name))
                    .is_some();
            if self.proxies.contains_key(&parent) || typed_array_element {
                return self.mop_set(code, parent, id, value, receiver);
            }
            // Any other parent's `[[Set]]` is this very algorithm (`mop_set`
            // would arrive back here): continue the walk in place rather than
            // nesting one native frame per prototype level, as `ordinary_get`
            // does.
            current = parent;
        }
        let receiver_inst = match receiver.value {
            Payload::Reference(receiver_inst) if receiver.kind == Kind::Reference => receiver_inst,
            _ => return Ok(false),
        };
        // When the receiver is itself a proxy (a trap-absent `[[Set]]` forwarded
        // to the target with the original proxy as Receiver), the final
        // create/update runs the receiver's own `[[GetOwnProperty]]` /
        // `[[DefineOwnProperty]]` (ECMA-262 OrdinarySetWithOwnDescriptor), so it
        // reaches the proxy's target — not the proxy's own inert instance slot.
        if self.proxies.contains_key(&receiver_inst) {
            if let Some(existing) = self.mop_get_own_property(code, receiver_inst, id)? {
                if existing.is_accessor() || existing.writable == Some(false) {
                    return Ok(false);
                }
                return self.mop_define_own_property(
                    code,
                    receiver_inst,
                    id,
                    OrdinaryDescriptor {
                        value: Some(value),
                        ..OrdinaryDescriptor::default()
                    },
                );
            }
            return self.mop_define_own_property(
                code,
                receiver_inst,
                id,
                OrdinaryDescriptor {
                    value: Some(value),
                    writable: Some(true),
                    enumerable: Some(true),
                    configurable: Some(true),
                    ..OrdinaryDescriptor::default()
                },
            );
        }
        let receiver_own = self
            .ordinary_get_own_descriptor(receiver_inst, id)
            .or_else(|| self.exotic_own_descriptor(receiver_inst, id));
        if let Some(existing) = receiver_own {
            if existing.is_accessor() || existing.writable == Some(false) {
                return Ok(false);
            }
            // OrdinarySetWithOwnDescriptor updates only [[Value]]. Preserve
            // the receiver property's existing attributes (notably a sealed
            // property's configurable:false bit).
            return self.mop_define_own_property(
                code,
                receiver_inst,
                id,
                OrdinaryDescriptor {
                    value: Some(value),
                    ..OrdinaryDescriptor::default()
                },
            );
        }
        let descriptor = OrdinaryDescriptor {
            value: Some(value),
            writable: Some(true),
            enumerable: Some(true),
            configurable: Some(true),
            ..OrdinaryDescriptor::default()
        };
        self.mop_define_own_property(code, receiver_inst, id, descriptor)
    }

    // =====================================================================
    // Proxy (ECMA-262 10.5) — exotic behavior over the object MOP.
    //
    // A proxy is a `Kind::Instance` slot recorded in `self.proxies`. Its
    // thirteen internal methods dispatch here: each looks up the handler trap
    // (`GetMethod`), and — trap absent — forwards to the target's corresponding
    // internal method through the `mop_*` dispatchers below, so a proxy over a
    // proxy (or over an ordinary object) composes. Every trap enforces the
    // spec's target-consistency invariants, throwing a realm-local, catchable
    // `TypeError` on violation. All ordinary/`Object.*`/`Reflect.*`/syntax
    // property operations route through the same `mop_*` seam so a trap cannot
    // be bypassed.
    // =====================================================================

    /// `new Proxy(target, handler)` / `Proxy.revocable` core: validate both
    /// operands are objects and mint the exotic (ECMA-262 10.5.1
    /// ProxyCreate). Returns the proxy reference slot.
    pub(super) fn make_proxy(&mut self, target: Slot, handler: Slot) -> Result<Slot, Step> {
        let target_inst = match target.value {
            Payload::Reference(t) if target.kind == Kind::Reference => t,
            _ => return Err(self.catchable_type_error_msg("target: not an object".into())),
        };
        let handler_inst = match handler.value {
            Payload::Reference(h) if handler.kind == Kind::Reference => h,
            _ => return Err(self.catchable_type_error_msg("handler: not an object".into())),
        };
        // A proxy instance has no identity prototype of its own (null proto);
        // its `[[Get]]`/`[[GetPrototypeOf]]` come from the traps/target.
        let inst = self
            .slots
            .alloc(Slot::instance(crate::value::SlotIndex::NULL));
        self.proxies.insert(
            inst,
            ProxyData {
                target: target_inst,
                handler: handler_inst,
                revoked: false,
            },
        );
        Ok(Slot::of(Kind::Reference, Payload::Reference(inst)))
    }

    /// The `(target, handler)` pair of a live proxy, or a `TypeError` if it has
    /// been revoked (every trap begins with this check, ECMA-262 10.5.*).
    pub(super) fn proxy_target_handler(
        &mut self,
        proxy: crate::value::SlotIndex,
        name: &str,
    ) -> Result<(crate::value::SlotIndex, crate::value::SlotIndex), Step> {
        self.meter.tick_raw(PROXY_INTERNAL_METHOD_METERING);
        self.meter.tick_builtin(); // target/handler validity check
        match self.proxies.get(&proxy) {
            Some(data) if !data.revoked => Ok((data.target, data.handler)),
            _ => Err(self.catchable_type_error_msg(format!("(proxy).{name}: no handler"))),
        }
    }

    /// `GetMethod(handler, name)` (ECMA-262 7.3.11): the trap function, `None`
    /// when it is `undefined`/`null`, a `TypeError` when present-but-uncallable.
    pub(super) fn proxy_trap(
        &mut self,
        code: &[u8],
        handler: crate::value::SlotIndex,
        name: &str,
    ) -> Result<Option<Slot>, Step> {
        let id = self.intern_key(name);
        let hslot = Slot::of(Kind::Reference, Payload::Reference(handler));
        let m = self.mop_get(code, handler, id, hslot)?;
        if m.kind == Kind::Undefined || m.kind == Kind::Null {
            return Ok(None);
        }
        if !self.is_callable_value(m) {
            return Err(self.catchable_type_error_msg(format!("(proxy).{name}: not a function")));
        }
        Ok(Some(m))
    }

    /// `CreateListFromArrayLike(value, «String, Symbol»)` (ECMA-262 7.3.18) —
    /// read `length`, then each indexed element, rejecting a non-string/symbol.
    pub(super) fn proxy_key_list(&mut self, code: &[u8], value: Slot) -> Result<Vec<Slot>, Step> {
        let inst = match value.value {
            Payload::Reference(i) if value.kind == Kind::Reference => i,
            _ if value.kind == Kind::Null => {
                return Err(self.catchable_type_error_msg("cannot coerce null to object".into()))
            }
            _ if value.kind == Kind::Undefined => {
                return Err(
                    self.catchable_type_error_msg("cannot coerce undefined to object".into())
                )
            }
            // The pinned XS boxes other primitives here; retain the ECMA
            // object requirement until that semantic divergence is resolved.
            _ => return Err(self.catchable_type_error()),
        };
        let length = self.arraylike_length(code, inst, value)?;
        let len = self.to_length_value(code, length)?;
        let mut out = Vec::new();
        for i in 0..len {
            self.meter.tick_builtin();
            if self.check_meter() == MeterCheck::Abort {
                return Err(Step::Host(Halt::MeterAbort));
            }
            let element = self.arraylike_index(code, inst, i, value)?;
            if element.kind != Kind::String && element.kind != Kind::Symbol {
                return Err(self.catchable_type_error_msg(
                    "(proxy).ownKeys: key is neither string nor symbol".into(),
                ));
            }
            out.push(element);
        }
        Ok(out)
    }

    /// `Get(arrayLike, "length")` honoring the exotic-array length accessor
    /// (which lives in the `arrays` side table, not an ordinary property).
    pub(super) fn arraylike_length(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        receiver: Slot,
    ) -> Result<Slot, Step> {
        if let Some(a) = self
            .arrays
            .get(&inst)
            .filter(|_| !self.arguments_objects.contains(&inst))
        {
            return Ok(Self::array_index_number(u64::from(a.length)));
        }
        if let Some(Slot {
            kind: Kind::String,
            value: Payload::String(off),
            ..
        }) = self.wrapper_data.get(&inst).copied()
        {
            return Ok(Slot::integer(self.str_len(off) as i32));
        }
        let length_id = self.intern_key("length");
        self.mop_get(code, inst, length_id, receiver)
    }

    /// `Get(arrayLike, ToString(index))` honoring exotic-array indexed elements.
    pub(super) fn arraylike_index(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        i: u64,
        receiver: Slot,
    ) -> Result<Slot, Step> {
        if let Some(item) = self
            .arrays
            .get(&inst)
            .and_then(|array| array.items().get(&(i as u32)).copied())
        {
            return Ok(self.array_item_value(inst, item));
        }
        if self.arrays.contains_key(&inst) {
            // A hole. The read still walks the prototype chain, but through
            // the shared non-interning probe: minting here made
            // `Array.from(sparse)` cost a name per hole.
            return self.arraylike_index_walk(code, inst, i, receiver);
        }
        if let Some(Slot {
            kind: Kind::String,
            value: Payload::String(off),
            ..
        }) = self.wrapper_data.get(&inst).copied()
        {
            if i < self.str_len(off) as u64 {
                return Ok(self.string_index_get(off, i as u32));
            }
        }
        self.arraylike_index_walk(code, inst, i, receiver)
    }

    /// `? Get(O, ToString(i))` for the array-like seam, index-safe.
    ///
    /// The name is minted only when some chain level can actually answer the
    /// index — the shared probe's contract. `Array.from({length: 70000})`
    /// reads 70,000 indices that no level answers; interning each one walked
    /// the `u16` id space into the saturation guard that poisons the machine,
    /// which made a one-line call a denial of service on the engine.
    pub(super) fn arraylike_index_walk(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        i: u64,
        receiver: Slot,
    ) -> Result<Slot, Step> {
        match self.array_generic_index_read_key(inst, i) {
            Some(key) => self.mop_get_read(code, inst, key, receiver),
            None => Ok(Slot::undefined()),
        }
    }

    /// `Object.fromEntries`'s `AddEntriesFromIterable`. Each yielded entry must
    /// be an object; its `"0"` and `"1"` properties are read through the
    /// ordinary/exotic array-like seam and the first is converted with
    /// `ToPropertyKey`. The result uses define semantics, so an inherited
    /// setter cannot intercept a new own property. Once an entry has been
    /// obtained, every abrupt entry-processing completion closes the iterator;
    /// failures while advancing the iterator itself do not.
    pub(super) fn object_from_entries(
        &mut self,
        code: &[u8],
        iterable: Slot,
    ) -> Result<Slot, Step> {
        let outcome = self.run_guest_under_native_try(CallerHandlers::Isolate, |machine| {
            machine.object_from_entries_inner(code, iterable)
        });
        match outcome {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error)) => Err(self.raise_js(error)),
            Err(halt) => Err(halt),
        }
    }

    pub(super) fn object_from_entries_inner(
        &mut self,
        code: &[u8],
        iterable: Slot,
    ) -> Result<Result<Slot, Slot>, Step> {
        let result = self.slots.alloc(Slot::instance(self.object_proto));

        if matches!(iterable.kind, Kind::Null | Kind::Undefined) {
            return Ok(Err(
                self.internal_error("TypeError", "invalid iterable".into())
            ));
        }

        let value_id = self.intern_key("value");
        let done_id = self.intern_key("done");
        self.value_id = Some(value_id);
        self.done_id = Some(done_id);

        let iterator_id = self
            .well_known_symbol_property_id("iterator")
            .expect("well-known iterator symbol");
        let mut iterator_method = Slot::undefined();
        match iterable.value {
            Payload::Reference(inst) if iterable.kind == Kind::Reference => {
                iterator_method = match self
                    .array_from_try(|this| this.mop_get(code, inst, iterator_id, iterable))?
                {
                    Ok(method) => method,
                    Err(error) => return Ok(Err(error)),
                };
            }
            _ => {
                let proto = match iterable.kind {
                    Kind::String => self.string_proto,
                    Kind::Integer | Kind::Number => self.number_proto,
                    Kind::Symbol => self.symbol_proto,
                    Kind::BigInt => self.bigint_proto,
                    Kind::Boolean => self
                        .intrinsics
                        .get("Boolean")
                        .and_then(|&c| self.ctor_prototype.get(&c).copied())
                        .unwrap_or(crate::value::SlotIndex::NULL),
                    _ => crate::value::SlotIndex::NULL,
                };
                if !proto.is_null() {
                    iterator_method = match self
                        .array_from_try(|this| this.mop_get(code, proto, iterator_id, iterable))?
                    {
                        Ok(method) => method,
                        Err(error) => return Ok(Err(error)),
                    };
                }
            }
        }
        if iterator_method.kind != Kind::Undefined
            && iterator_method.kind != Kind::Null
            && !self.is_callable_value(iterator_method)
        {
            return Ok(Err(
                self.internal_error("TypeError", "call: not a function".into())
            ));
        }

        let mut next_method = Slot::undefined();
        let iterator = if iterator_method.kind != Kind::Undefined
            && iterator_method.kind != Kind::Null
        {
            let iterator = match self
                .array_from_try(|this| this.call_any(code, iterator_method, iterable, &[]))?
            {
                Ok(iterator) => iterator,
                Err(error) => return Ok(Err(error)),
            };
            let inst = match iterator.value {
                Payload::Reference(inst) if iterator.kind == Kind::Reference => inst,
                _ => {
                    return Ok(Err(
                        self.internal_error("TypeError", "iterator: not an object".into())
                    ))
                }
            };
            let next_id = self.intern_key("next");
            next_method =
                match self.array_from_try(|this| this.mop_get(code, inst, next_id, iterator))? {
                    Ok(method) if self.is_callable_value(method) => method,
                    Ok(_) => {
                        return Ok(Err(
                            self.internal_error("TypeError", "call: not a function".into())
                        ))
                    }
                    Err(error) => return Ok(Err(error)),
                };
            Some(iterator)
        } else {
            None
        };
        let iterator = match iterator {
            Some(iterator) => iterator,
            None => {
                return Ok(Err(
                    self.internal_error("TypeError", "call: not a function".into())
                ))
            }
        };

        for _ in 0..1_000_000u64 {
            let iter_inst = match iterator.value {
                Payload::Reference(iter_inst) => iter_inst,
                _ => unreachable!(),
            };
            let _ = iter_inst;
            let step =
                self.array_from_try(|this| this.call_any(code, next_method, iterator, &[]))?;
            // IteratorStepValue failures are returned directly. The iterator
            // has not yielded an entry yet, so AddEntriesFromIterable does not
            // apply IteratorClose to these abrupt completions.
            let step = match step {
                Ok(step) => step,
                Err(error) => return Ok(Err(error)),
            };
            let step_inst = match step.value {
                Payload::Reference(step_inst) if step.kind == Kind::Reference => step_inst,
                _ => {
                    return Ok(Err(self.internal_error(
                        "TypeError",
                        "iterator result: not an object".into(),
                    )))
                }
            };
            let done =
                match self.array_from_try(|this| this.mop_get(code, step_inst, done_id, step))? {
                    Ok(done) => done,
                    Err(error) => return Ok(Err(error)),
                };
            if self.truthy(&done) {
                return Ok(Ok(Slot::of(Kind::Reference, Payload::Reference(result))));
            }
            let entry =
                match self.array_from_try(|this| this.mop_get(code, step_inst, value_id, step))? {
                    Ok(entry) => entry,
                    Err(error) => return Ok(Err(error)),
                };
            let entry_inst = match entry.value {
                Payload::Reference(inst) if entry.kind == Kind::Reference => inst,
                _ => {
                    let error = self.internal_error("TypeError", "item: not an object".into());
                    let error = self.array_from_close(code, iterator, error)?;
                    return Ok(Err(error));
                }
            };
            let key = match self
                .array_from_try(|this| this.arraylike_index(code, entry_inst, 0, entry))?
            {
                Ok(key) => key,
                Err(error) => {
                    let error = self.array_from_close(code, iterator, error)?;
                    return Ok(Err(error));
                }
            };
            let value = match self
                .array_from_try(|this| this.arraylike_index(code, entry_inst, 1, entry))?
            {
                Ok(value) => value,
                Err(error) => {
                    let error = self.array_from_close(code, iterator, error)?;
                    return Ok(Err(error));
                }
            };
            let id = match self.array_from_try(|this| this.to_property_id(code, key))? {
                Ok(id) => id,
                Err(error) => {
                    let error = self.array_from_close(code, iterator, error)?;
                    return Ok(Err(error));
                }
            };
            let descriptor = OrdinaryDescriptor {
                value: Some(value),
                writable: Some(true),
                enumerable: Some(true),
                configurable: Some(true),
                ..OrdinaryDescriptor::default()
            };
            // The fresh ordinary result cannot reject an all-true data
            // descriptor. XS does not expose an error diagnostic for this guard.
            if !self.ordinary_define_own_property(result, id, descriptor) {
                let error = self.build_error("TypeError", 0, 0);
                let error = self.array_from_close(code, iterator, error)?;
                return Ok(Err(error));
            }
        }
        Err(Step::Host(Halt::StepLimit(self.n_dispatched)))
    }

    // ---- the `mop_*` dispatchers: an object's internal method, proxy-aware ---
    //
    // Every internal method is a **light frame** of the native-recursion
    // budget: a Proxy with an absent trap forwards the same internal method
    // to its target, an exotic prototype (a Proxy, an array, a function, a
    // wrapper) is reached through the parent's full `[[Get]]`/`[[Set]]`, and
    // a trap that runs guest code comes back in through the same entries — so
    // each of these is where a guest-shaped chain recurses on the host stack.
    // The `_inner` body is the internal method; the guarded entry charges
    // [`LIGHT_FRAME_COST`] around it and halts with [`Halt::StackOverflow`]
    // past [`NATIVE_DEPTH_LIMIT`].

    /// `O.[[GetPrototypeOf]]()` as a slot (`Reference(proto)` or `Null`).
    pub(super) fn mop_get_prototype(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
    ) -> Result<Slot, Step> {
        self.with_native_frame(LIGHT_FRAME_COST, |vm| {
            vm.mop_get_prototype_inner(code, inst)
        })
    }

    pub(super) fn mop_get_prototype_inner(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
    ) -> Result<Slot, Step> {
        if self.proxies.contains_key(&inst) {
            return self.proxy_get_prototype(code, inst);
        }
        let proto = self.instance_prototype(inst);
        Ok(if proto.is_null() {
            Slot::null()
        } else {
            Slot::of(Kind::Reference, Payload::Reference(proto))
        })
    }

    /// `O.[[SetPrototypeOf]](V)` — `proto` is `Reference`/`Null`.
    /// OrdinarySetPrototypeOf's cycle refusal (ECMA-262 10.1.2 step 8):
    /// walk the ordinary prototype chain from the proposed prototype;
    /// reaching `inst` would close a cycle. A proxy in the chain ends the
    /// walk without failure — its `[[GetPrototypeOf]]` is not the ordinary
    /// one, so the spec's loop stops there.
    pub(super) fn prototype_chain_would_cycle(
        &self,
        inst: crate::value::SlotIndex,
        new_proto: crate::value::SlotIndex,
    ) -> bool {
        let mut p = new_proto;
        while !p.is_null() {
            if p == inst {
                return true;
            }
            if self.proxies.contains_key(&p) {
                return false;
            }
            p = self.instance_prototype(p);
        }
        false
    }

    pub(super) fn mop_set_prototype(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        proto: Slot,
    ) -> Result<bool, Step> {
        self.with_native_frame(LIGHT_FRAME_COST, |vm| {
            vm.mop_set_prototype_inner(code, inst, proto)
        })
    }

    pub(super) fn mop_set_prototype_inner(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        proto: Slot,
    ) -> Result<bool, Step> {
        if self.proxies.contains_key(&inst) {
            return self.proxy_set_prototype(code, inst, proto);
        }
        let new_proto = match proto.kind {
            Kind::Null => crate::value::SlotIndex::NULL,
            Kind::Reference => match proto.value {
                Payload::Reference(p) => p,
                _ => return Ok(false),
            },
            _ => return Ok(false),
        };
        let current = self.instance_prototype(inst);
        if current == new_proto {
            return Ok(true);
        }
        if !self.instance_extensible(inst) {
            return Ok(false);
        }
        if self.prototype_chain_would_cycle(inst, new_proto) {
            return Ok(false);
        }
        let slot = self.slots.get_mut(inst);
        slot.value = if new_proto.is_null() {
            Payload::None
        } else {
            Payload::Reference(new_proto)
        };
        Ok(true)
    }

    /// `O.[[IsExtensible]]()`.
    pub(super) fn mop_is_extensible(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
    ) -> Result<bool, Step> {
        self.with_native_frame(LIGHT_FRAME_COST, |vm| {
            vm.mop_is_extensible_inner(code, inst)
        })
    }

    pub(super) fn mop_is_extensible_inner(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
    ) -> Result<bool, Step> {
        if self.proxies.contains_key(&inst) {
            return self.proxy_is_extensible(code, inst);
        }
        Ok(self.instance_extensible(inst))
    }

    /// `O.[[PreventExtensions]]()`.
    pub(super) fn mop_prevent_extensions(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
    ) -> Result<bool, Step> {
        self.with_native_frame(LIGHT_FRAME_COST, |vm| {
            vm.mop_prevent_extensions_inner(code, inst)
        })
    }

    pub(super) fn mop_prevent_extensions_inner(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
    ) -> Result<bool, Step> {
        if self.proxies.contains_key(&inst) {
            return self.proxy_prevent_extensions(code, inst);
        }
        self.materialize_intrinsic_own_surface(inst);
        self.slots.get_mut(inst).flag |= XS_DONT_PATCH_FLAG;
        Ok(true)
    }

    /// `SetIntegrityLevel(O, sealed|frozen)` (ECMA-262 7.3.15). The own-key
    /// list is captured after preventing extensions; every key is then routed
    /// through the receiver's `[[GetOwnProperty]]` / `[[DefineOwnProperty]]`
    /// methods so arrays, TypedArrays, and proxies retain their exotic rules.
    pub(super) fn set_integrity_level(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        frozen: bool,
    ) -> Result<(), Step> {
        self.meter.tick_raw(INTEGRITY_APPLY_KEYS_BASE_METERING);
        if !self.mop_prevent_extensions(code, inst)? {
            return Err(self.catchable_type_error_msg("extensible object".into()));
        }
        let keys = self.mop_own_keys(code, inst)?;
        let proxy = self.proxies.contains_key(&inst);
        for key in keys {
            self.meter.tick_raw(INTEGRITY_APPLY_PER_KEY_METERING);
            // Stamping flags OBSERVES the key set and rewrites existing
            // entries; it creates no name, so an index is not minted.
            let key = self.to_read_key(code, key)?;
            let current = if frozen || !proxy {
                self.mop_get_own_property_read(code, inst, key)?
            } else {
                None
            };
            // String-exotic indices and `length` are already frozen. Avoid
            // manufacturing ordinary shadow properties for those synthetic
            // descriptors; proxies still receive every mandated define trap.
            if !proxy
                && current.as_ref().is_some_and(|descriptor| {
                    descriptor.configurable == Some(false)
                        && (!frozen
                            || descriptor.is_accessor()
                            || descriptor.writable == Some(false))
                })
            {
                continue;
            }
            let desc = if frozen {
                match current {
                    None => continue,
                    Some(descriptor) if descriptor.is_accessor() => OrdinaryDescriptor {
                        configurable: Some(false),
                        ..OrdinaryDescriptor::default()
                    },
                    Some(_) => OrdinaryDescriptor {
                        configurable: Some(false),
                        writable: Some(false),
                        ..OrdinaryDescriptor::default()
                    },
                }
            } else {
                OrdinaryDescriptor {
                    configurable: Some(false),
                    ..OrdinaryDescriptor::default()
                }
            };
            // The descriptor read above can run a proxy trap that names this
            // index; refresh before the define.
            let key = self.refresh_read_key(key);
            if !self.mop_define_own_property_read(code, inst, key, desc)? {
                return Err(self.catchable_type_error_msg("cannot configure property".into()));
            }
        }
        Ok(())
    }

    /// `TestIntegrityLevel(O, sealed|frozen)` (ECMA-262 7.3.16).
    pub(super) fn test_integrity_level(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        frozen: bool,
    ) -> Result<bool, Step> {
        self.meter.tick_raw(IS_EXTENSIBLE_RESIDUAL_METERING);
        if self.mop_is_extensible(code, inst)? {
            return Ok(false);
        }
        self.meter.tick_raw(INTEGRITY_QUERY_KEYS_BASE_METERING);
        for key in self.mop_own_keys(code, inst)? {
            self.meter.tick_raw(INTEGRITY_QUERY_PER_KEY_METERING);
            let key = self.to_read_key(code, key)?;
            if let Some(descriptor) = self.mop_get_own_property_read(code, inst, key)? {
                if descriptor.configurable != Some(false)
                    || (frozen && descriptor.is_data() && descriptor.writable == Some(true))
                {
                    return Ok(false);
                }
            }
        }
        Ok(true)
    }

    /// `O.[[GetOwnProperty]](P)`.
    pub(super) fn mop_get_own_property(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        id: u16,
    ) -> Result<Option<OrdinaryDescriptor>, Step> {
        self.with_native_frame(LIGHT_FRAME_COST, |vm| {
            vm.mop_get_own_property_inner(code, inst, id)
        })
    }

    pub(super) fn mop_get_own_property_inner(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        id: u16,
    ) -> Result<Option<OrdinaryDescriptor>, Step> {
        if self.proxies.contains_key(&inst) {
            return self.proxy_get_own_property(code, inst, id);
        }
        if let Some(&ta) = self.typed_arrays.get(&inst) {
            if let Some(index) = self.ta_numeric_index_at(id, 0) {
                return Ok(self.ta_index_own_descriptor(ta, index));
            }
        }
        if self.find_property(inst, id).is_none() {
            if let Some(d) = self.exotic_own_descriptor(inst, id) {
                return Ok(Some(d));
            }
        }
        Ok(self.ordinary_get_own_descriptor(inst, id))
    }

    /// `Object.prototype.hasOwnProperty(V)` (ECMA-262 20.1.3.2). Matches XS's
    /// `fx_Object_prototype_hasOwnProperty`: coerce the receiver first (so a
    /// `null`/`undefined` `this` throws a TypeError before the key is
    /// stringified), then `? ToPropertyKey(V)`, then whether the resulting
    /// object has `P` as an OWN property — `O.[[GetOwnProperty]](P) is not
    /// undefined`, never consulting the prototype chain.
    pub(super) fn object_has_own_property(
        &mut self,
        code: &[u8],
        this: Slot,
        arg0: Slot,
    ) -> Result<Slot, Step> {
        // `? ToObject(this)`: `null`/`undefined` throw (XS's `fxToInstance`); a
        // primitive boxes to its wrapper, whose own-property set is computed
        // directly below without materializing the wrapper.
        if matches!(this.kind, Kind::Null | Kind::Undefined) {
            return Err(self.catchable_type_error_msg(
                if this.kind == Kind::Null {
                    "cannot coerce null to object"
                } else {
                    "cannot coerce undefined to object"
                }
                .into(),
            ));
        }
        // `? ToPropertyKey(V)` (XS's `fxAt`): a symbol resolves to its stable
        // key id; a non-index string interns as a name; any other primitive
        // coerces through ToPrimitive → ToString first (a number key renders
        // and meters its result chunk). A canonical index stays an index and
        // mints nothing — an own-property PROBE creates no property.
        let key = self.to_read_key(code, arg0)?;
        // The `mxBehaviorGetOwnProperty` probe native-body residual, metered
        // once per call exactly as the pre-existing string-key path did.
        self.meter.tick_raw(METHOD_HAS_OWN_PROPERTY_METERING);
        let present = match this.value {
            Payload::Reference(o) if this.kind == Kind::Reference => match key {
                ReadKey::Id(id) => self.object_own_property_present(code, o, id)?,
                ReadKey::Index(index) => self.uninterned_index_own_present(code, o, index)?,
            },
            // A String primitive's boxed wrapper exposes its canonical integer
            // indices `[0, length)` and `length` as own properties (the
            // String-exotic `[[GetOwnProperty]]`, ECMA-262 10.4.3.5).
            Payload::String(off) if this.kind == Kind::String => {
                let len = self.str_len(off);
                match key {
                    ReadKey::Id(id) => {
                        let name = self.scalar_key_text(id);
                        let index = name.as_deref().and_then(string_to_index);
                        self.string_exotic_has_own(len, name.as_deref(), index)
                    }
                    ReadKey::Index(index) => self.string_exotic_has_own(len, None, Some(index)),
                }
            }
            // Every other primitive (Number/Boolean/Symbol/BigInt) boxes to a
            // fresh wrapper with no own properties of its own.
            _ => false,
        };
        Ok(Slot::boolean(present))
    }

    /// `Object.assign(target, ...sources)` (ECMA-262 20.1.2.1). The key list
    /// for each source is snapshotted once, but its descriptor and value are
    /// read live before a throwing `Set` on the target. Nullish sources are
    /// skipped; every other primitive is boxed through the same ToObject path
    /// used by generic Array methods.
    pub(super) fn object_assign(
        &mut self,
        code: &[u8],
        target: Slot,
        sources: &[Slot],
    ) -> Result<Slot, Step> {
        let to = self.array_to_object(target)?;
        let Payload::Reference(target_inst) = to.value else {
            unreachable!("ToObject target")
        };
        for source in sources {
            if matches!(source.kind, Kind::Null | Kind::Undefined) {
                continue;
            }
            let from = self.array_to_object(*source)?;
            let Payload::Reference(source_inst) = from.value else {
                unreachable!("ToObject source")
            };
            let keys = self.mop_own_keys(code, source_inst)?;
            for key in keys {
                // Reading the SOURCE creates nothing, so an index key is read
                // by index. Every own key of a 70,000-element array reaches
                // here; naming each one to ask whether it is enumerable spent
                // the `u16` id space on properties this call may well skip.
                let key = self.to_read_key(code, key)?;
                let Some(descriptor) = self.mop_get_own_property_read(code, source_inst, key)?
                else {
                    continue;
                };
                if descriptor.enumerable != Some(true) {
                    continue;
                }
                // The descriptor read can have run a trap that names the
                // index; the value read below must use the same property.
                let key = self.refresh_read_key(key);
                let value = self.mop_get_read(code, source_inst, key, from)?;
                // Writing the TARGET creates a property — but an ordinary
                // object's index property is created BY INDEX, so this no
                // longer has to mint a name. Minting here is what kept
                // `Object.assign({}, bigArray)` exhausting the key space
                // after the write opcode itself had stopped.
                let key = self.refresh_read_key(key);
                match key {
                    ReadKey::Index(index) if self.indexes_by_index(target_inst) => {
                        match self.ordinary_index_set(code, target_inst, index, value, to)? {
                            Some(true) => {}
                            // Rejected by the index store. Reported BY INDEX:
                            // the name half of this diagnostic renders as `?`
                            // for any index-shaped key, so interning one to
                            // build the message would buy nothing and would
                            // mint on a throw path a guest can drive in a loop.
                            Some(false) => {
                                return Err(self.failed_index_set_error(
                                    target_inst,
                                    index,
                                    "C: xsSet",
                                ))
                            }
                            // The narrow shapes the index walk defers on (an
                            // accessor, a Proxy or TypedArray prototype whose
                            // behaviour must observe the key).
                            None => {
                                let id = self.read_key_intern(key);
                                if !self.mop_set(code, target_inst, id, value, to)? {
                                    return Err(self.failed_set_error(target_inst, id, "C: xsSet"));
                                }
                            }
                        }
                    }
                    _ => {
                        let id = self.read_key_intern(key);
                        if !self.mop_set(code, target_inst, id, value, to)? {
                            return Err(self.failed_set_error(target_inst, id, "C: xsSet"));
                        }
                    }
                }
            }
        }
        Ok(to)
    }

    /// Whether object `o` has `id` as an own property — `O.[[GetOwnProperty]]`
    /// projected to presence, dispatched on the receiver's exotic shape. Exotic
    /// own names (`length`/`name`/`prototype`, integer indices) are matched by
    /// the key's resolved *name* rather than a cached program-symbol id, because
    /// a key that reaches `hasOwnProperty` only as a string literal (never as a
    /// `.length` access) is interned under a fresh runtime id that the boot
    /// `length_id`/`name_id` caches never equal.
    pub(super) fn object_own_property_present(
        &mut self,
        code: &[u8],
        o: crate::value::SlotIndex,
        id: u16,
    ) -> Result<bool, Step> {
        // A Proxy routes through its `getOwnProperty` trap and the invariant
        // checks the MOP enforces.
        if self.proxies.contains_key(&o) {
            return Ok(self.mop_get_own_property(code, o, id)?.is_some());
        }
        // The key's string name (a symbol key resolves to `None` — never an
        // exotic index / `length` / `name`), and the canonical integer index it
        // names, if any.
        let name = self.scalar_key_text(id);
        let index = name.as_deref().and_then(string_to_index);
        // A TypedArray's integer-indexed exotic `[[GetOwnProperty]]` projected
        // to presence: a canonical numeric index is own iff it is a valid
        // integer index; a non-index name is an ordinary expando probe (a
        // canonical-but-non-integer / negative / `-0` string is not an index —
        // `string_to_index` rejects it — and correctly misses).
        if let Some(&ta) = self.typed_arrays.get(&o) {
            if let Some(idx) = index {
                return Ok(self.ta_valid_index(ta, idx as f64).is_some());
            }
            return Ok(self.find_property(o, id).is_some());
        }
        if self.array_buffers.contains_key(&o) || self.data_views.contains_key(&o) {
            // ArrayBuffer and DataView have no integer-indexed exotic
            // behavior. Numeric-looking keys are ordinary expandos, just like
            // every other string key on these objects.
            return Ok(self.find_property(o, id).is_some());
        }
        // An Array's exotic own properties: the present integer indices (kept in
        // the item side table, not the slot chain) and `length`; named expandos
        // live in the slot chain.
        if let Some(a) = self.arrays.get(&o) {
            if name.as_deref() == Some("length") {
                return Ok(
                    !self.arguments_objects.contains(&o) || self.find_property(o, id).is_some()
                );
            }
            if let Some(idx) = index {
                if a.items().contains_key(&idx) {
                    return Ok(true);
                }
            }
            return Ok(self.find_property(o, id).is_some());
        }
        // A String wrapper (`new String("ab")`) exposes the same exotic string
        // indices + `length` as a primitive string, plus any ordinary expando
        // own slots. Every other wrapper (Number/Boolean/Symbol) has only its
        // ordinary own slots (the boxed primitive is internal, not an own
        // property).
        if let Some(prim) = self.wrapper_data.get(&o).copied() {
            if let (Kind::String, Payload::String(off)) = (prim.kind, prim.value) {
                let len = self.str_len(off);
                if self.string_exotic_has_own(len, name.as_deref(), index) {
                    return Ok(true);
                }
            }
            return Ok(self.find_property(o, id).is_some());
        }
        // A Function's exotic own properties: `length` and `name` (always), and
        // `prototype` for a constructor that carries one; named expandos live in
        // the slot chain.
        if self.functions.contains_key(&o) {
            match name.as_deref() {
                // `length`/`name` are own unless the guest has `delete`d them
                // (tombstoned) or shadowed them with an ordinary slot.
                Some("length") | Some("name") => {
                    return Ok(self.find_property(o, id).is_some()
                        || !self.deleted_fn_meta.contains(&(o, id)));
                }
                _ => return Ok(self.find_property(o, id).is_some()),
            }
        }
        // Ordinary object: named properties live in the slot chain, and
        // integer-indexed ones in the index store.
        //
        // Consulting only the chain made this answer depend on whether some
        // unrelated code had interned the index's NAME: an uninterned key
        // reaches `uninterned_index_own_present`, which reads the store, while
        // an interned one arrives here and missed. `'0' in o` was therefore
        // true or false depending on history, and
        // `Array.prototype.map.call({length: 2, 0: 'a'}, f)` — whose internals
        // intern the name — read every element as a hole.
        if let Some(index) = index {
            if self.index_prop_item(o, index).is_some() {
                return Ok(true);
            }
        }
        Ok(self.find_property(o, id).is_some())
    }

    /// Whether a String-exotic receiver of code-unit length `len` has the key
    /// (its resolved `name` and canonical `index`, if any) as an own property:
    /// its integer indices `[0, len)` and the non-configurable `length`
    /// (String-exotic `[[GetOwnProperty]]`).
    pub(super) fn string_exotic_has_own(
        &self,
        len: usize,
        name: Option<&str>,
        index: Option<u32>,
    ) -> bool {
        if name == Some("length") {
            return true;
        }
        matches!(index, Some(idx) if (idx as usize) < len)
    }

    /// `O.[[DefineOwnProperty]](P, Desc)`.
    pub(super) fn mop_define_own_property(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        id: u16,
        desc: OrdinaryDescriptor,
    ) -> Result<bool, Step> {
        self.with_native_frame(LIGHT_FRAME_COST, |vm| {
            vm.mop_define_own_property_inner(code, inst, id, desc)
        })
    }

    pub(super) fn mop_define_own_property_inner(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        id: u16,
        desc: OrdinaryDescriptor,
    ) -> Result<bool, Step> {
        if self.proxies.contains_key(&inst) {
            return self.proxy_define_own_property(code, inst, id, desc);
        }
        if let Some(&ta) = self.typed_arrays.get(&inst) {
            if let Some(index) = self.ta_numeric_index_at(id, 0) {
                return self.ta_index_define(code, ta, index, desc);
            }
        }
        if self.arrays.contains_key(&inst) {
            return self.array_define_own_property(code, inst, id, desc);
        }
        // A String wrapper's synthetic indices and `length` are immutable
        // non-configurable own properties. A compatible no-op definition is
        // accepted, but no ordinary shadow slot may be manufactured for them.
        let string_wrapper = self
            .wrapper_data
            .get(&inst)
            .is_some_and(|value| value.kind == Kind::String);
        if string_wrapper && self.find_property(inst, id).is_none() {
            if let Some(current) = self.exotic_own_descriptor(inst, id) {
                return Ok(self.is_compatible_descriptor(false, &desc, Some(&current)));
            }
        }
        Ok(self.ordinary_define_own_property(inst, id, desc))
    }

    /// `O.[[HasProperty]](P)`.
    pub(super) fn mop_has(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        id: u16,
    ) -> Result<bool, Step> {
        Ok(self.mop_has_with_recursions(code, inst, id)?.0)
    }

    /// `O.[[HasProperty]](P)` plus the number of `fxOrdinaryHasProperty`
    /// **frames** the walk runs — every level that does not find the property
    /// own, which is `d` for a hit at depth `d` and one *more* than the number
    /// of prototype hops for a miss off the end of an ordinary chain. Callers
    /// meter one [`ORDINARY_HAS_PROPERTY_FRAME_METERING`] per frame. Each level dispatches through the
    /// object's MOP: a Proxy in an ordinary object's prototype chain must run
    /// its `has` trap, and an absent outer Proxy trap must forward to an inner
    /// Proxy target rather than treating either proxy as an ordinary slot
    /// chain. Exotic own properties are likewise checked at every level.
    pub(super) fn mop_has_with_recursions(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        id: u16,
    ) -> Result<(bool, u64), Step> {
        self.with_native_frame(LIGHT_FRAME_COST, |vm| {
            vm.mop_has_with_recursions_inner(code, inst, id)
        })
    }

    pub(super) fn mop_has_with_recursions_inner(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        id: u16,
    ) -> Result<(bool, u64), Step> {
        let mut current = inst;
        let mut frames = 0u64;
        loop {
            if self.proxies.contains_key(&current) {
                // A Proxy answers through `fxProxyHasProperty`, which does not
                // run the ordinary push/pop at its own level.
                return Ok((self.proxy_has(code, current, id)?, frames));
            }
            if self.object_own_property_present(code, current, id)? {
                // Found own: `fxOrdinaryHasProperty` returns before its push.
                return Ok((true, frames));
            }
            // This level did not find the property own, so XS's
            // `fxOrdinaryHasProperty` ran its `mxPushUndefined`/`mxPop` pair
            // here before recurring. Counting *these* rather than prototype
            // hops is what makes the hit and total-miss paths one formula: a
            // miss off the end of an ordinary chain pays a pair at the last
            // object too, where there is no hop.
            frames += 1;
            let prototype = self.instance_prototype(current);
            if prototype.is_null() {
                return Ok((false, frames));
            }
            current = prototype;
        }
    }

    /// `O.[[Get]](P, Receiver)`.
    pub(super) fn mop_get(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        id: u16,
        receiver: Slot,
    ) -> Result<Slot, Step> {
        if let Some(context) = self
            .array_iterator_proxy_get_context
            .filter(|context| context.target == inst)
            .filter(|context| self.refresh_read_key(context.key) == ReadKey::Id(id))
        {
            return self.mop_get_with_proxy_metering(
                code,
                inst,
                ReadKey::Id(id),
                receiver,
                context.trap_metering,
                context.meter_terminal_wrapper,
                false,
                true,
            );
        }
        self.mop_get_with_proxy_metering(
            code,
            inst,
            ReadKey::Id(id),
            receiver,
            0,
            false,
            false,
            false,
        )
    }

    /// `O.[[Get]](P, Receiver)` with a caller-owned residual for each Proxy
    /// trap actually taken. The wrapper flag charges a terminal primitive
    /// wrapper reached through transparent Proxy forwarding.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn mop_get_with_proxy_metering(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        key: ReadKey,
        receiver: Slot,
        proxy_trap_metering: u64,
        meter_terminal_wrapper: bool,
        meter_forwarded_target: bool,
        after_active_trap: bool,
    ) -> Result<Slot, Step> {
        self.with_native_frame(LIGHT_FRAME_COST, |vm| {
            vm.mop_get_with_proxy_metering_inner(
                code,
                inst,
                key,
                receiver,
                proxy_trap_metering,
                meter_terminal_wrapper,
                meter_forwarded_target,
                after_active_trap,
            )
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn mop_get_with_proxy_metering_inner(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        key: ReadKey,
        receiver: Slot,
        proxy_trap_metering: u64,
        meter_terminal_wrapper: bool,
        meter_forwarded_target: bool,
        after_active_trap: bool,
    ) -> Result<Slot, Step> {
        if self.proxies.contains_key(&inst) {
            return self.proxy_get_with_metering(
                code,
                inst,
                key,
                receiver,
                proxy_trap_metering,
                meter_terminal_wrapper,
                meter_forwarded_target,
                after_active_trap,
            );
        }
        if meter_forwarded_target {
            let terminal_is_wrapper = self.wrapper_data.contains_key(&inst);
            self.charge_and_check(if after_active_trap {
                if proxy_trap_metering == ARRAY_ITERATOR_PROXY_VALUE_METERING {
                    ARRAY_ITERATOR_PROXY_VALUE_ACTIVE_FORWARD_TARGET_METERING
                } else {
                    ARRAY_ITERATOR_PROXY_ACTIVE_FORWARD_TARGET_METERING
                }
            } else if proxy_trap_metering == ARRAY_ITERATOR_PROXY_VALUE_METERING
                && !terminal_is_wrapper
            {
                ARRAY_ITERATOR_PROXY_VALUE_FORWARD_TARGET_METERING
            } else {
                ARRAY_ITERATOR_PROXY_FORWARD_TARGET_METERING
            })?;
        }
        if meter_terminal_wrapper {
            if let Some(value) = self.wrapper_data.get(&inst) {
                if value.kind == Kind::String {
                    self.charge_and_check(if meter_forwarded_target {
                        ARRAY_ITERATOR_PROXY_STRING_RECEIVER_METERING
                    } else {
                        ARRAY_ITERATOR_STRING_RECEIVER_METERING
                    })?;
                } else if matches!(value.kind, Kind::Symbol | Kind::BigInt) {
                    self.meter
                        .tick_raw(ARRAY_ITERATOR_WIDE_PRIMITIVE_RECEIVER_METERING);
                }
            }
        }
        // Past the metering, which is charged for either spelling. An index
        // with no name resolves through the same uninterned walk every other
        // index-keyed read uses; it reaches the identical exotic storages the
        // id tail below consults (array items, TypedArray elements, String
        // wrapper units) and then the prototype chain.
        let id = match key {
            ReadKey::Id(id) => id,
            ReadKey::Index(index) => return self.uninterned_index_get(code, inst, index, receiver),
        };
        // An exotic-array / function target's `length` / integer-index / `name`
        // / `prototype` own values live in side tables, not the slot chain (they
        // are not visible to `ordinary_get`), so honor them when a proxy
        // forwards `[[Get]]` here — but only if the target does not carry an
        // ordinary own slot for the same id (a user-defined override wins).
        if self.find_property(inst, id).is_none() {
            if let Some(&typed_array) = self.typed_arrays.get(&inst) {
                if let Some(index) = self.ta_numeric_index_at(id, 0) {
                    return Ok(self.ta_indexed_element_get(typed_array, index));
                }
            }
            if let Some(d) = self.exotic_own_descriptor(inst, id) {
                if d.is_data() {
                    return Ok(d.value.unwrap_or_else(Slot::undefined));
                }
            }
        }
        self.ordinary_get(code, inst, id, receiver)
    }

    /// Whether a RegExp property lookup reaches the VM's implicit intrinsic
    /// accessor without encountering an observable own/inherited override.
    /// The default `source` and `flags` accessors are represented by the
    /// RegExp side table rather than ordinary property slots, so constructor
    /// copy semantics use this gate before reading that side table directly.
    pub(super) fn regexp_getter_uses_default(
        &self,
        inst: crate::value::SlotIndex,
        id: u16,
    ) -> bool {
        let mut current = inst;
        while !current.is_null() {
            if self.proxies.contains_key(&current) || self.find_property(current, id).is_some() {
                return false;
            }
            if current == self.regexp_proto {
                return true;
            }
            current = self.instance_prototype(current);
        }
        false
    }

    /// The exotic own descriptor for an array (`length` / index) or function
    /// (`length` / `name` / `prototype`) target `id`, or `None` — so a proxy
    /// forwarding an internal method to an exotic target honors the exotic own
    /// properties the opcode dispatch materializes.
    pub(super) fn exotic_own_descriptor(
        &mut self,
        inst: crate::value::SlotIndex,
        id: u16,
    ) -> Option<OrdinaryDescriptor> {
        if let Some(d) = self.array_own_descriptor(inst, id) {
            return Some(d);
        }
        // A String wrapper has non-writable, non-configurable own UTF-16 index
        // properties plus a non-enumerable `length`. Other primitive wrappers
        // have no exotic own properties (their wrapped value is internal).
        if let Some(Slot {
            kind: Kind::String,
            value: Payload::String(off),
            ..
        }) = self.wrapper_data.get(&inst).copied()
        {
            let name = self.scalar_key_text(id);
            if name.as_deref() == Some("length") {
                return Some(OrdinaryDescriptor {
                    value: Some(Slot::integer(self.str_len(off) as i32)),
                    writable: Some(false),
                    enumerable: Some(false),
                    configurable: Some(false),
                    ..OrdinaryDescriptor::default()
                });
            }
            if let Some(index) = name.as_deref().and_then(string_to_index) {
                let value = self.string_index_get(off, index);
                if value.kind != Kind::Undefined {
                    return Some(OrdinaryDescriptor {
                        value: Some(value),
                        writable: Some(false),
                        enumerable: Some(true),
                        configurable: Some(false),
                        ..OrdinaryDescriptor::default()
                    });
                }
            }
        }
        let fi = self.functions.get(&inst)?;
        if self.scalar_key_text(id).as_deref() == Some("length") {
            return Some(OrdinaryDescriptor {
                value: Some(Slot::integer(fi.arity as i32)),
                writable: Some(false),
                enumerable: Some(false),
                configurable: Some(true),
                ..OrdinaryDescriptor::default()
            });
        }
        if Some(id) == self.name_id {
            return Some(OrdinaryDescriptor {
                value: Some(Slot::of(Kind::String, Payload::String(fi.name_chunk))),
                writable: Some(false),
                enumerable: Some(false),
                configurable: Some(true),
                ..OrdinaryDescriptor::default()
            });
        }
        if let Some(&proto) = self.ctor_prototype.get(&inst) {
            let prototype_id = self.symbol_ids.get("prototype").copied();
            if Some(id) == prototype_id {
                return Some(OrdinaryDescriptor {
                    value: Some(Slot::of(Kind::Reference, Payload::Reference(proto))),
                    writable: Some(true),
                    enumerable: Some(false),
                    configurable: Some(false),
                    ..OrdinaryDescriptor::default()
                });
            }
        }
        None
    }

    /// The exotic-array own descriptor for `id` (`length` or an in-range index),
    /// or `None` when the id is neither — so `mop_get_own_property` /
    /// `mop_own_keys` see an array target's exotic own properties.
    pub(super) fn array_own_descriptor(
        &self,
        inst: crate::value::SlotIndex,
        id: u16,
    ) -> Option<OrdinaryDescriptor> {
        let a = self.arrays.get(&inst)?;
        if self.scalar_key_text(id).as_deref() == Some("length")
            && !self.arguments_objects.contains(&inst)
        {
            return Some(OrdinaryDescriptor {
                value: Some(Self::array_index_number(u64::from(a.length))),
                writable: Some(self.array_length_writable(inst)),
                enumerable: Some(false),
                configurable: Some(false),
                ..OrdinaryDescriptor::default()
            });
        }
        let idx = self.scalar_key_text(id).and_then(|n| string_to_index(&n))?;
        let s = a.items().get(&idx).copied()?;
        let value = self.array_item_value(inst, s);
        Some(OrdinaryDescriptor {
            value: Some(value),
            writable: Some(s.flag & XS_DONT_SET_FLAG == 0),
            enumerable: Some(s.flag & XS_DONT_ENUM_FLAG == 0),
            configurable: Some(s.flag & XS_DONT_DELETE_FLAG == 0),
            ..OrdinaryDescriptor::default()
        })
    }

    /// `O.[[Set]](P, V, Receiver)`.
    /// XS fxIDToString (xsSymbol.c), used by native property diagnostics.
    /// Index keys carry XS_NO_ID in XS, and therefore print `?`, not the index.
    pub(super) fn property_debug_name(&self, id: u16) -> String {
        let name = if let Some(name) = self.scalar_key_text(id) {
            if string_to_index(&name).is_some() {
                "?".to_string()
            } else {
                name
            }
        } else if let Some((&descriptor, _)) =
            self.symbol_key_ids.iter().find(|(_, key)| **key == id)
        {
            let description = match self.slots.get(descriptor).value {
                Payload::String(offset) => self.str_text(offset),
                _ => String::new(),
            };
            format!("[{description}]")
        } else {
            "?".to_string()
        };
        // nameBuffer[256] is populated by snprintf, including a final NUL.
        let bytes = name.as_bytes();
        let end = bytes
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(bytes.len())
            .min(255);
        String::from_utf8_lossy(&bytes[..end]).into_owned()
    }

    /// Explain an ordinary [[Set]] rejection without invoking another getter
    /// or Proxy trap. XS native setters use fxSetAll's caller-specific prefix.
    pub(super) fn failed_set_error(
        &mut self,
        inst: crate::value::SlotIndex,
        id: u16,
        prefix: &str,
    ) -> Step {
        let error = self.failed_set_error_value(inst, id, prefix);
        self.raise_js(error)
    }

    pub(super) fn failed_set_error_value(
        &mut self,
        inst: crate::value::SlotIndex,
        id: u16,
        prefix: &str,
    ) -> Slot {
        let mut current = inst;
        let mut reason = "not extensible";
        while !current.is_null() {
            if self.proxies.contains_key(&current) {
                // A false Proxy set result has different behavior in the
                // pinned XS C setter; do not fabricate a parity diagnostic.
                return self.internal_error("TypeError", String::new());
            }
            let descriptor = self
                .ordinary_get_own_descriptor(current, id)
                .or_else(|| self.exotic_own_descriptor(current, id));
            if let Some(descriptor) = descriptor {
                if descriptor.is_accessor() {
                    reason = "no setter";
                } else if descriptor.writable == Some(false) {
                    reason = "not writable";
                }
                break;
            }
            current = self.instance_prototype(current);
        }
        let name = self.property_debug_name(id);
        self.internal_error("TypeError", format!("{prefix} {name}: {reason}"))
    }

    /// [`Self::failed_set_error`] for a write the index store itself rejected,
    /// reported without interning the index's name. The reason walk is the
    /// same one, over the index-aware descriptor triple
    /// [`Self::ordinary_index_set`] consults; the name half is `?` because
    /// [`Self::property_debug_name`] renders every index-shaped key that way,
    /// so the message is byte-identical to the interned path's.
    pub(super) fn failed_index_set_error(
        &mut self,
        inst: crate::value::SlotIndex,
        index: u32,
        prefix: &str,
    ) -> Step {
        let mut current = inst;
        let mut reason = "not extensible";
        while !current.is_null() {
            if self.proxies.contains_key(&current) {
                // A false Proxy set result has different behavior in the
                // pinned XS C setter; do not fabricate a parity diagnostic.
                let error = self.internal_error("TypeError", String::new());
                return self.raise_js(error);
            }
            let descriptor = self
                .index_prop_descriptor(current, index)
                .or_else(|| self.named_index_descriptor(current, index))
                .or_else(|| self.exotic_index_own_descriptor(current, index));
            if let Some(descriptor) = descriptor {
                if descriptor.is_accessor() {
                    reason = "no setter";
                } else if descriptor.writable == Some(false) {
                    reason = "not writable";
                }
                break;
            }
            current = self.instance_prototype(current);
        }
        let error = self.internal_error("TypeError", format!("{prefix} ?: {reason}"));
        self.raise_js(error)
    }

    /// XS fxDeleteAll reports a failed native deletion by key identity.
    pub(super) fn failed_delete_error(&mut self, id: u16) -> Step {
        let name = self.property_debug_name(id);
        self.catchable_type_error_msg(format!("delete {name}: not configurable"))
    }

    pub(super) fn mop_set(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        id: u16,
        value: Slot,
        receiver: Slot,
    ) -> Result<bool, Step> {
        self.with_native_frame(LIGHT_FRAME_COST, |vm| {
            vm.mop_set_inner(code, inst, id, value, receiver)
        })
    }

    pub(super) fn mop_set_inner(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        id: u16,
        value: Slot,
        receiver: Slot,
    ) -> Result<bool, Step> {
        if self.proxies.contains_key(&inst) {
            return self.proxy_set(code, inst, id, value, receiver);
        }
        if let Some(&ta) = self.typed_arrays.get(&inst) {
            let numeric_index = if self.is_symbol_key_id(id) {
                None
            } else {
                self.scalar_key_text(id)
                    .and_then(|name| canonical_numeric_index_string(&name))
            };
            if let Some(index) = numeric_index {
                let target = Slot::of(Kind::Reference, Payload::Reference(inst));
                if self.same_value(target, receiver) {
                    self.ta_indexed_element_set(code, ta, index, value)?;
                    return Ok(true);
                }
                if self.ta_valid_index(ta, index).is_none() {
                    return Ok(true);
                }
                let key = self.property_key_slot(id)?;
                return self.set_data_on_receiver(code, receiver, key, value);
            }
        }
        self.ordinary_set(code, inst, id, value, receiver)
    }

    /// `O.[[Delete]](P)`.
    pub(super) fn mop_delete(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        id: u16,
    ) -> Result<bool, Step> {
        self.with_native_frame(LIGHT_FRAME_COST, |vm| vm.mop_delete_inner(code, inst, id))
    }

    pub(super) fn mop_delete_inner(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        id: u16,
    ) -> Result<bool, Step> {
        if self.proxies.contains_key(&inst) {
            return self.proxy_delete(code, inst, id);
        }
        if let Some(&ta) = self.typed_arrays.get(&inst) {
            if let Some(index) = self.ta_numeric_index_at(id, 0) {
                return Ok(self.ta_valid_index(ta, index).is_none());
            }
        }
        if self.arrays.contains_key(&inst) {
            let name = self.scalar_key_text(id);
            if name.as_deref() == Some("length") && !self.arguments_objects.contains(&inst) {
                return Ok(false);
            }
            if let Some(index) = name.as_deref().and_then(string_to_index) {
                if let Some(item) = self.arrays[&inst].items().get(&index) {
                    if item.flag & XS_DONT_DELETE_FLAG != 0 {
                        return Ok(false);
                    }
                    self.arrays
                        .get_mut(&inst)
                        .unwrap()
                        .remove_item(&index, &mut self.side_refs);
                    return Ok(true);
                }
            }
        }
        // String-exotic indices and `length` are non-configurable. Ordinary
        // expandos remain deletable through the ordinary path below.
        let string_wrapper = self
            .wrapper_data
            .get(&inst)
            .is_some_and(|value| value.kind == Kind::String);
        if string_wrapper
            && self.find_property(inst, id).is_none()
            && self.exotic_own_descriptor(inst, id).is_some()
        {
            return Ok(false);
        }
        // An index property named here lives in the index store, not the slot
        // chain, so `delete_own_property` would not find it.
        if let Some(index) = self.index_prop_index_of_id(inst, id) {
            if self
                .index_prop_item(inst, index)
                .is_some_and(|item| item.flag & XS_DONT_DELETE_FLAG != 0)
            {
                return Ok(false);
            }
            self.index_prop_remove(inst, index);
            return Ok(true);
        }
        Ok(self.delete_own_property(inst, id))
    }

    /// `O.[[OwnPropertyKeys]]()` as a list of key slots (string / symbol),
    /// in the spec integer→string→symbol order for an ordinary object.
    pub(super) fn mop_own_keys(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
    ) -> Result<Vec<Slot>, Step> {
        // Keep the large materialization frame out of a forwarding Proxy chain.
        self.with_native_frame(LIGHT_FRAME_COST, |vm| {
            if vm.proxies.contains_key(&inst) {
                vm.proxy_own_keys(code, inst)
            } else {
                vm.mop_own_keys_inner(inst)
            }
        })
    }

    #[inline(never)]
    pub(super) fn mop_own_keys_inner(
        &mut self,
        inst: crate::value::SlotIndex,
    ) -> Result<Vec<Slot>, Step> {
        self.materialize_intrinsic_own_surface(inst);
        // An exotic-array target: integer indices ascending, then the Array's
        // exotic `length` (ordinary and deletable for an arguments object),
        // then the remaining ordinary string keys and symbol keys.
        if self.arrays.contains_key(&inst) {
            let mut out = Vec::new();
            let is_arguments = self.arguments_objects.contains(&inst);
            let count = self.arrays[&inst].items().len();
            let buffer = self.reserve_work_scratch(count)?;
            let mut idxs = Self::fill_scratch(buffer, self.arrays[&inst].items().keys().copied());
            let ordinary_ids = self.ordered_own_key_ids(inst);
            self.admit_scratch::<u32>(idxs.len() + ordinary_ids.len())?;
            idxs.try_reserve(ordinary_ids.len())
                .map_err(|_| Step::Host(Halt::HeapExhausted))?;
            self.charge_builtin_work((ordinary_ids.len() + idxs.len()) as u64)?;
            idxs.extend(ordinary_ids.iter().filter_map(|id| {
                self.scalar_key_text(*id)
                    .and_then(|name| string_to_index(&name))
            }));
            idxs.sort_unstable();
            idxs.dedup();
            for i in idxs {
                // The key is SPELLED from the index, never interned: XS's
                // `fxKeyAt` builds it from `value.at.index`, and minting one
                // per element walked the shared `u16` id space into its
                // saturation guard — `Object.keys(a)` over a 70,000-element
                // array poisoned the machine.
                self.charge_builtin_work(1)?;
                let key = self.read_key_slot(ReadKey::Index(i))?;
                self.push_prepaid_scratch(&mut out, key)?;
            }
            let length_id = self.intern_key("length");
            if !is_arguments {
                self.charge_builtin_work(1)?;
                let key = self.property_key_slot(length_id)?;
                self.push_prepaid_scratch(&mut out, key)?;
            }
            for id in ordinary_ids {
                if (!is_arguments && id == length_id)
                    || self
                        .scalar_key_text(id)
                        .is_some_and(|name| string_to_index(&name).is_some())
                {
                    continue;
                }
                self.charge_builtin_work(1)?;
                let key = self.property_key_slot(id)?;
                self.push_prepaid_scratch(&mut out, key)?;
            }
            return Ok(out);
        }
        // Integer-indexed TypedArray own keys: each live element index in
        // ascending order, then ordinary string and symbol expandos. A
        // detached view has zero observable indexed keys.
        if let Some(&ta) = self.typed_arrays.get(&inst) {
            let length = if self.detached_buffers.contains(&ta.buffer) {
                0
            } else {
                ta.length
            };
            let mut out = Vec::new();
            for index in 0..length {
                self.charge_builtin_work(1)?;
                let key = self.read_key_slot(ReadKey::Index(index))?;
                self.push_prepaid_scratch(&mut out, key)?;
            }
            for id in self.ordered_own_key_ids(inst) {
                if self
                    .scalar_key_text(id)
                    .is_some_and(|name| string_to_index(&name).is_some())
                {
                    continue;
                }
                self.charge_builtin_work(1)?;
                let key = self.property_key_slot(id)?;
                self.push_prepaid_scratch(&mut out, key)?;
            }
            return Ok(out);
        }
        // A boxed String exposes UTF-16 indices followed by its non-enumerable
        // `length`, then any ordinary expandos. Other primitive wrappers have
        // only their ordinary own-property chain.
        if let Some(Slot {
            kind: Kind::String,
            value: Payload::String(offset),
            ..
        }) = self.wrapper_data.get(&inst).copied()
        {
            let mut out = Vec::new();
            let units = self.str_len(offset);
            for index in 0..units {
                self.charge_builtin_work(1)?;
                let key = self.read_key_slot(ReadKey::Index(index as u32))?;
                self.push_prepaid_scratch(&mut out, key)?;
            }
            // An expando whose name is a canonical index BEYOND the string's
            // length is a real own property, and XS lists it right here:
            // `fxStringOwnKeys` (`xsString.c`) queues the units, then the
            // instance's own index keys via `fxQueueIndexKeys`, then `length`,
            // then the named chain.
            //
            // Dropping every index-named expando instead made `s[5] = 'x'` on
            // a two-unit wrapper invisible to every key walk, so `harden(s)`
            // never froze it while `Object.isFrozen(s)` still answered `true` —
            // a hardened object carrying a writable, configurable, deletable
            // property, and an unhardened referent when the value was an
            // object.
            let ordinary_ids = self.ordered_own_key_ids(inst);
            let mut index_expandos: Vec<(u32, u16)> = ordinary_ids
                .iter()
                .filter_map(|&id| {
                    let index = string_to_index(&self.scalar_key_text(id)?)?;
                    (index as usize >= units).then_some((index, id))
                })
                .collect();
            index_expandos.sort_unstable_by_key(|&(index, _)| index);
            for (_, id) in index_expandos {
                self.charge_builtin_work(1)?;
                let key = self.property_key_slot(id)?;
                self.push_prepaid_scratch(&mut out, key)?;
            }
            let length_id = self.intern_key("length");
            self.charge_builtin_work(1)?;
            let key = self.property_key_slot(length_id)?;
            self.push_prepaid_scratch(&mut out, key)?;
            for id in ordinary_ids {
                // Every index-named expando is already placed above, in range
                // as a unit and out of range as its own key.
                if id == length_id
                    || self
                        .scalar_key_text(id)
                        .is_some_and(|name| string_to_index(&name).is_some())
                {
                    continue;
                }
                self.charge_builtin_work(1)?;
                let key = self.property_key_slot(id)?;
                self.push_prepaid_scratch(&mut out, key)?;
            }
            return Ok(out);
        }
        // A function target: `length`, `name`, `prototype` (if it has one),
        // then later-created ordinary own keys. The non-configurable key
        // ownKeys invariants require a proxy trap result to preserve them.
        if self.functions.contains_key(&inst) {
            let mut out = Vec::new();
            let length_id = self.intern_key("length");
            let name_id = self.intern_key("name");
            let prototype_id = self.intern_key("prototype");
            let has_proto = self.ctor_prototype.contains_key(&inst);
            let ordinary_ids = self.ordered_own_key_ids(inst);
            for &id in &ordinary_ids {
                if !self.is_symbol_key_id(id)
                    && self
                        .scalar_key_text(id)
                        .is_some_and(|name| string_to_index(&name).is_some())
                {
                    self.charge_builtin_work(1)?;
                    let key = self.property_key_slot(id)?;
                    self.push_prepaid_scratch(&mut out, key)?;
                }
            }
            self.charge_builtin_work(1)?;
            let key = self.property_key_slot(length_id)?;
            self.push_prepaid_scratch(&mut out, key)?;
            self.charge_builtin_work(1)?;
            let key = self.property_key_slot(name_id)?;
            self.push_prepaid_scratch(&mut out, key)?;
            if has_proto {
                self.charge_builtin_work(1)?;
                let key = self.property_key_slot(prototype_id)?;
                self.push_prepaid_scratch(&mut out, key)?;
            }
            let intrinsic_ids = self.intrinsic_own_string_order(inst).unwrap_or_default();
            for &id in &intrinsic_ids {
                if ordinary_ids.contains(&id) {
                    self.charge_builtin_work(1)?;
                    let key = self.property_key_slot(id)?;
                    self.push_prepaid_scratch(&mut out, key)?;
                }
            }
            for id in ordinary_ids {
                if id == length_id
                    || id == name_id
                    || (has_proto && id == prototype_id)
                    || intrinsic_ids.contains(&id)
                    || (!self.is_symbol_key_id(id)
                        && self
                            .scalar_key_text(id)
                            .is_some_and(|name| string_to_index(&name).is_some()))
                {
                    continue;
                }
                self.charge_builtin_work(1)?;
                let key = self.property_key_slot(id)?;
                self.push_prepaid_scratch(&mut out, key)?;
            }
            return Ok(out);
        }
        let ids = self.ordered_own_key_ids(inst);
        let mut out = self.reserve_scratch(ids.len())?;
        // Index keys ascending, then the named chain — `fxOrdinaryOwnKeys`
        // queues the internal index chunk before `fxQueueIDKeys`. These keys
        // are spelled from the index, so listing them mints nothing.
        for index in self.index_prop_indices(inst) {
            self.charge_builtin_work(1)?;
            let key = self.read_key_slot(ReadKey::Index(index))?;
            self.push_prepaid_scratch(&mut out, key)?;
        }
        for id in ids {
            self.charge_builtin_work(1)?;
            let key = self.property_key_slot(id)?;
            self.push_prepaid_scratch(&mut out, key)?;
        }
        Ok(out)
    }

    /// An ordinary object's own key ids in `[[OwnPropertyKeys]]` order:
    /// array-index keys ascending, then other string keys in creation order,
    /// then symbol keys in creation order.
    pub(super) fn ordered_own_key_ids(&self, inst: crate::value::SlotIndex) -> Vec<u16> {
        let mut ids: Vec<u16> = self
            .own_property_slots(inst)
            .into_iter()
            .map(|property| self.slots.get(property).id)
            .collect();
        ids.sort_by_key(|id| {
            if self.is_symbol_key_id(*id) {
                (2u8, 0u32)
            } else {
                self.scalar_key_text(*id)
                    .and_then(|name| string_to_index(&name))
                    .map(|index| (0u8, index))
                    .unwrap_or((1u8, 0))
            }
        });
        ids
    }

    // -------------------------- the thirteen traps -----------------------

    /// `[[GetPrototypeOf]]` (ECMA-262 10.5.1).
    pub(super) fn proxy_get_prototype(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
    ) -> Result<Slot, Step> {
        let (target, handler) = self.proxy_target_handler(proxy, "getPrototypeOf")?;
        // Inline GetMethod here because its non-callable rejection has a
        // distinct XS meter outcome from a throwing getter. Other proxy traps
        // continue to share `proxy_trap`.
        let trap_id = self.intern_key("getPrototypeOf");
        let handler_slot = Slot::of(Kind::Reference, Payload::Reference(handler));
        let trap = self.mop_get(code, handler, trap_id, handler_slot)?;
        if trap.kind == Kind::Undefined || trap.kind == Kind::Null {
            self.charge_and_check(if self.proxies.contains_key(&target) {
                PROXY_GET_PROTOTYPE_FORWARD_PROXY_METERING
            } else {
                PROXY_GET_PROTOTYPE_FORWARD_TARGET_METERING
            })?;
            return self.mop_get_prototype(code, target);
        }
        if !self.is_callable_value(trap) {
            self.meter
                .untick_raw(PROXY_GET_PROTOTYPE_NONCALLABLE_CREDIT);
            return Err(
                self.catchable_type_error_msg("(proxy).getPrototypeOf: not a function".into())
            );
        };
        let target_slot = Slot::of(Kind::Reference, Payload::Reference(target));
        let result = match self.invoke_value(code, trap, handler_slot, &[target_slot]) {
            Ok(result) => result,
            Err(error) => {
                self.meter.tick_raw(PROXY_GET_PROTOTYPE_THROW_METERING);
                return Err(error);
            }
        };
        if result.kind != Kind::Reference && result.kind != Kind::Null {
            self.meter.tick_raw(PROXY_GET_PROTOTYPE_PRIMITIVE_METERING);
            return Err(self.catchable_type_error_msg(
                "(proxy).getPrototypeOf: neither object nor null".into(),
            ));
        }
        if self.mop_is_extensible(code, target)? {
            self.meter.tick_raw(PROXY_GET_PROTOTYPE_TRAP_METERING);
            return Ok(result);
        }
        let target_proto = self.mop_get_prototype(code, target)?;
        if !self.same_value(result, target_proto) {
            self.meter
                .tick_raw(PROXY_GET_PROTOTYPE_INVARIANT_REJECT_METERING);
            return Err(self.catchable_type_error_msg(
                "(proxy).getPrototypeOf: different prototype for non-extensible object".into(),
            ));
        }
        self.meter
            .tick_raw(PROXY_GET_PROTOTYPE_FIXED_SUCCESS_METERING);
        Ok(result)
    }

    /// `[[SetPrototypeOf]]` (ECMA-262 10.5.2).
    pub(super) fn proxy_set_prototype(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
        proto: Slot,
    ) -> Result<bool, Step> {
        let (target, handler) = self.proxy_target_handler(proxy, "setPrototypeOf")?;
        let trap = match self.proxy_trap(code, handler, "setPrototypeOf")? {
            Some(t) => t,
            None => return self.mop_set_prototype(code, target, proto),
        };
        let handler_slot = Slot::of(Kind::Reference, Payload::Reference(handler));
        let target_slot = Slot::of(Kind::Reference, Payload::Reference(target));
        let result = self.invoke_value(code, trap, handler_slot, &[target_slot, proto])?;
        if !self.truthy(&result) {
            return Ok(false);
        }
        if self.mop_is_extensible(code, target)? {
            return Ok(true);
        }
        let target_proto = self.mop_get_prototype(code, target)?;
        if !self.same_value(proto, target_proto) {
            return Err(self.catchable_type_error_msg(
                "(proxy).setPrototypeOf: true for non-extensible object with different prototype"
                    .into(),
            ));
        }
        Ok(true)
    }

    /// `[[IsExtensible]]` (ECMA-262 10.5.3).
    pub(super) fn proxy_is_extensible(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
    ) -> Result<bool, Step> {
        let (target, handler) = self.proxy_target_handler(proxy, "isExtensible")?;
        let trap = match self.proxy_trap(code, handler, "isExtensible")? {
            Some(t) => t,
            None => return self.mop_is_extensible(code, target),
        };
        let handler_slot = Slot::of(Kind::Reference, Payload::Reference(handler));
        let target_slot = Slot::of(Kind::Reference, Payload::Reference(target));
        let result = self.invoke_value(code, trap, handler_slot, &[target_slot])?;
        let boolean = self.truthy(&result);
        let target_result = self.mop_is_extensible(code, target)?;
        if boolean != target_result {
            return Err(self.catchable_type_error_msg(
                if boolean {
                    "(proxy).isExtensible: true for non-extensible object"
                } else {
                    "(proxy).isExtensible: false for extensible object"
                }
                .into(),
            ));
        }
        Ok(boolean)
    }

    /// `[[PreventExtensions]]` (ECMA-262 10.5.4).
    pub(super) fn proxy_prevent_extensions(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
    ) -> Result<bool, Step> {
        let (target, handler) = self.proxy_target_handler(proxy, "preventExtensions")?;
        let trap = match self.proxy_trap(code, handler, "preventExtensions")? {
            Some(t) => t,
            None => return self.mop_prevent_extensions(code, target),
        };
        let handler_slot = Slot::of(Kind::Reference, Payload::Reference(handler));
        let target_slot = Slot::of(Kind::Reference, Payload::Reference(target));
        let result = self.invoke_value(code, trap, handler_slot, &[target_slot])?;
        let boolean = self.truthy(&result);
        if boolean && self.mop_is_extensible(code, target)? {
            return Err(self.catchable_type_error_msg(
                "(proxy).preventExtensions: true for extensible object".into(),
            ));
        }
        Ok(boolean)
    }

    /// `[[GetOwnProperty]]` (ECMA-262 10.5.5).
    pub(super) fn proxy_get_own_property(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
        id: u16,
    ) -> Result<Option<OrdinaryDescriptor>, Step> {
        let (target, handler) = self.proxy_target_handler(proxy, "getOwnPropertyDescriptor")?;
        let trap = match self.proxy_trap(code, handler, "getOwnPropertyDescriptor")? {
            Some(t) => t,
            None => return self.mop_get_own_property(code, target, id),
        };
        self.proxy_get_own_property_trapped(code, target, handler, trap, ReadKey::Id(id))
    }

    /// The `getOwnPropertyDescriptor` trap call and its invariant checks,
    /// shared by the id-keyed path and by
    /// [`Self::uninterned_index_proxy_own_descriptor`]. The trap is passed in
    /// ALREADY RESOLVED: looking it up a second time would re-run a handler's
    /// accessor and double-meter the lookup.
    pub(super) fn proxy_get_own_property_trapped(
        &mut self,
        code: &[u8],
        target: crate::value::SlotIndex,
        handler: crate::value::SlotIndex,
        trap: Slot,
        key_id: ReadKey,
    ) -> Result<Option<OrdinaryDescriptor>, Step> {
        let handler_slot = Slot::of(Kind::Reference, Payload::Reference(handler));
        let target_slot = Slot::of(Kind::Reference, Payload::Reference(target));
        let key = self.read_key_slot(key_id)?;
        let trap_result = self.invoke_value(code, trap, handler_slot, &[target_slot, key])?;
        if trap_result.kind != Kind::Undefined && trap_result.kind != Kind::Reference {
            return Err(self.catchable_type_error_msg("descriptor: not an object".into()));
        }
        // The trap may have named this index mid-flight (see
        // `refresh_read_key`); a stale `Index` would miss the very property
        // the invariant check exists to find.
        let key_id = self.refresh_read_key(key_id);
        let target_desc = self.mop_get_own_property_read(code, target, key_id)?;
        if trap_result.kind == Kind::Undefined {
            match target_desc {
                None => return Ok(None),
                Some(d) => {
                    if d.configurable == Some(false) {
                        return Err(self.catchable_type_error_msg("(proxy).getOwnPropertyDescriptor: no descriptor for non-configurable property".into()));
                    }
                    if !self.mop_is_extensible(code, target)? {
                        return Err(self.catchable_type_error_msg("(proxy).getOwnPropertyDescriptor: no descriptor for existent property of non-extensible object".into()));
                    }
                    return Ok(None);
                }
            }
        }
        let obj = match trap_result.value {
            Payload::Reference(o) => o,
            _ => return Err(self.catchable_type_error_msg("descriptor: not an object".into())),
        };
        let result_desc = self.descriptor_from_object(code, obj)?;
        let result_desc = complete_descriptor(result_desc);
        let extensible = self.mop_is_extensible(code, target)?;
        if !self.is_compatible_descriptor(extensible, &result_desc, target_desc.as_ref()) {
            let message = if target_desc.is_some() {
                "(proxy).getOwnPropertyDescriptor: incompatible descriptor for existent property"
            } else {
                "(proxy).getOwnPropertyDescriptor: descriptor for non-existent property of non-extensible object"
            };
            return Err(self.catchable_type_error_msg(message.into()));
        }
        if result_desc.configurable == Some(false) {
            match &target_desc {
                None => return Err(self.catchable_type_error_msg("(proxy).getOwnPropertyDescriptor: non-configurable descriptor for non-existent property".into())),
                Some(d) if d.configurable != Some(false) => return Err(self.catchable_type_error_msg("(proxy).getOwnPropertyDescriptor: non-configurable descriptor for configurable property".into())),
                Some(d) => {
                    // A non-configurable non-writable target data property may
                    // not be reported writable.
                    if result_desc.is_data()
                        && result_desc.writable == Some(false)
                        && d.is_data()
                        && d.writable == Some(true)
                    {
                        return Err(self.catchable_type_error_msg("(proxy).getOwnPropertyDescriptor: true with non-writable descriptor for non-configurable writable property".into()));
                    }
                }
            }
        }
        Ok(Some(result_desc))
    }

    /// `[[DefineOwnProperty]]` (ECMA-262 10.5.6).
    pub(super) fn proxy_define_own_property(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
        id: u16,
        desc: OrdinaryDescriptor,
    ) -> Result<bool, Step> {
        let (target, handler) = self.proxy_target_handler(proxy, "defineProperty")?;
        let trap = match self.proxy_trap(code, handler, "defineProperty")? {
            Some(t) => t,
            None => return self.mop_define_own_property(code, target, id, desc),
        };
        let handler_slot = Slot::of(Kind::Reference, Payload::Reference(handler));
        let target_slot = Slot::of(Kind::Reference, Payload::Reference(target));
        let key = self.property_key_slot(id)?;
        let desc_obj = self.descriptor_object(desc);
        let result = self.invoke_value(code, trap, handler_slot, &[target_slot, key, desc_obj])?;
        if !self.truthy(&result) {
            return Ok(false);
        }
        let target_desc = self.mop_get_own_property(code, target, id)?;
        let extensible = self.mop_is_extensible(code, target)?;
        let setting_config_false = desc.configurable == Some(false);
        match &target_desc {
            None => {
                if !extensible {
                    return Err(self.catchable_type_error_msg("(proxy).defineProperty: true with descriptor for non-existent property of non-extensible object".into()));
                }
                if setting_config_false {
                    return Err(self.catchable_type_error_msg("(proxy).defineProperty: true with non-configurable descriptor for non-existent property".into()));
                }
            }
            Some(d) => {
                if !self.is_compatible_descriptor(extensible, &desc, Some(d)) {
                    return Err(self.catchable_type_error_msg("(proxy).defineProperty: true with incompatible descriptor for existent property".into()));
                }
                if setting_config_false && d.configurable != Some(false) {
                    return Err(self.catchable_type_error_msg("(proxy).defineProperty: true with non-configurable descriptor for configurable property".into()));
                }
                if d.is_data()
                    && d.configurable == Some(false)
                    && d.writable == Some(true)
                    && desc.writable == Some(false)
                {
                    return Err(self.catchable_type_error_msg("(proxy).defineProperty: true with non-writable descriptor for non-configurable writable property".into()));
                }
            }
        }
        Ok(true)
    }

    /// `[[HasProperty]]` (ECMA-262 10.5.7).
    pub(super) fn proxy_has(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
        id: u16,
    ) -> Result<bool, Step> {
        let (target, handler) = self.proxy_target_handler(proxy, "has")?;
        let trap = match self.proxy_trap(code, handler, "has")? {
            Some(t) => t,
            None => return self.mop_has(code, target, id),
        };
        let handler_slot = Slot::of(Kind::Reference, Payload::Reference(handler));
        let target_slot = Slot::of(Kind::Reference, Payload::Reference(target));
        let key = self.property_key_slot(id)?;
        let result = self.invoke_value(code, trap, handler_slot, &[target_slot, key])?;
        let boolean = self.truthy(&result);
        if !boolean {
            if let Some(d) = self.mop_get_own_property(code, target, id)? {
                if d.configurable == Some(false) {
                    return Err(self.catchable_type_error_msg(
                        "(proxy).has: false for non-configurable property".into(),
                    ));
                }
                if !self.mop_is_extensible(code, target)? {
                    return Err(self.catchable_type_error_msg(
                        "(proxy).has: false for property of not extensible object".into(),
                    ));
                }
            }
        }
        Ok(boolean)
    }

    /// `[[Get]]` (ECMA-262 10.5.8).
    pub(super) fn proxy_get(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
        id: u16,
        receiver: Slot,
    ) -> Result<Slot, Step> {
        self.proxy_get_with_metering(
            code,
            proxy,
            ReadKey::Id(id),
            receiver,
            0,
            false,
            false,
            false,
        )
    }

    pub(super) fn proxy_get_with_metering(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
        key: ReadKey,
        receiver: Slot,
        proxy_trap_metering: u64,
        meter_terminal_wrapper: bool,
        meter_forwarded_target: bool,
        after_active_trap: bool,
    ) -> Result<Slot, Step> {
        let (target, handler) = self.proxy_target_handler(proxy, "get")?;
        let trap = match self.proxy_trap(code, handler, "get")? {
            Some(t) => t,
            None => {
                if proxy_trap_metering != 0 {
                    self.meter.tick_raw(ARRAY_ITERATOR_PROXY_FORWARD_METERING);
                }
                return self.mop_get_with_proxy_metering(
                    code,
                    target,
                    key,
                    receiver,
                    proxy_trap_metering,
                    meter_terminal_wrapper,
                    meter_forwarded_target || proxy_trap_metering != 0,
                    after_active_trap,
                );
            }
        };
        self.proxy_get_trapped(
            code,
            target,
            handler,
            trap,
            key,
            receiver,
            proxy_trap_metering,
            meter_forwarded_target,
            meter_terminal_wrapper,
        )
    }

    /// The `get` trap call of `[[Get]]` (ECMA-262 10.5.8 steps 7-10) and its
    /// non-configurable-target invariant checks, shared by the id-keyed read
    /// and by [`Self::uninterned_index_proxy_get`], whose key has no id.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn proxy_get_trapped(
        &mut self,
        code: &[u8],
        target: crate::value::SlotIndex,
        handler: crate::value::SlotIndex,
        trap: Slot,
        key_id: ReadKey,
        receiver: Slot,
        proxy_trap_metering: u64,
        meter_forwarded_target: bool,
        meter_terminal_wrapper: bool,
    ) -> Result<Slot, Step> {
        if meter_forwarded_target {
            self.charge_and_check(
                if proxy_trap_metering == ARRAY_ITERATOR_PROXY_VALUE_METERING {
                    ARRAY_ITERATOR_PROXY_VALUE_FORWARD_ACTIVE_METERING
                } else {
                    ARRAY_ITERATOR_PROXY_FORWARD_ACTIVE_METERING
                },
            )?;
        }
        self.charge_and_check(proxy_trap_metering)?;
        let handler_slot = Slot::of(Kind::Reference, Payload::Reference(handler));
        let target_slot = Slot::of(Kind::Reference, Payload::Reference(target));
        // Built here, after the trap's metering, so the id-keyed read keeps
        // the order it had before this arm was shared. An index with no id
        // spells its own key, exactly as XS's `fxKeyAt` does for `XS_NO_ID`.
        let key = self.read_key_slot(key_id)?;
        let saved_context = self.array_iterator_proxy_get_context;
        // Installed for an INDEX key as well as an id. It used to be id-only,
        // on the invariant that "the uninterned-index arm always meters zero"
        // — true while every ordinary object's index property carried an
        // interned name, so an Array Iterator read of one arrived here as an
        // `Id`. With those properties kept by index that read is index-keyed,
        // and skipping the residual made
        // `Array.prototype.values.call(new Proxy(new Proxy({length:1,0:7},{}),
        // {get(t,k,r){return Reflect.get(t,k,r)}}))` cost four computrons less
        // than the oracle charges.
        if proxy_trap_metering != 0 && self.proxies.contains_key(&target) {
            self.array_iterator_proxy_get_context = Some(ArrayIteratorProxyGetContext {
                target,
                key: key_id,
                trap_metering: proxy_trap_metering,
                meter_terminal_wrapper,
            });
        }
        let trap_result =
            self.invoke_value(code, trap, handler_slot, &[target_slot, key, receiver]);
        self.array_iterator_proxy_get_context = saved_context;
        let trap_result = trap_result?;
        // Ask the target by INDEX when the table still has no name for it: an
        // array / TypedArray / String-wrapper / proxy target answers out of
        // its side table, so `new Proxy([], handler)[i]` needs no name. But
        // the trap has just run and may itself have NAMED this index —
        // promoting it to an ordinary slot the index arm cannot see — so
        // refresh first, or the invariant check is silently skipped.
        let key_id = self.refresh_read_key(key_id);
        if let Some(d) = self.mop_get_own_property_read(code, target, key_id)? {
            if d.configurable == Some(false) {
                if d.is_data()
                    && d.writable == Some(false)
                    && !self.same_value(trap_result, d.value.unwrap_or_else(Slot::undefined))
                {
                    return Err(self.catchable_type_error_msg(
                        "(proxy).get: different value for non-configurable, non-writable property"
                            .into(),
                    ));
                }
                if d.is_accessor()
                    && d.get.map(|g| g.kind == Kind::Undefined).unwrap_or(true)
                    && trap_result.kind != Kind::Undefined
                {
                    return Err(self.catchable_type_error_msg(
                        "(proxy).get: different getter for non-configurable property".into(),
                    ));
                }
            }
        }
        Ok(trap_result)
    }

    /// `[[Set]]` (ECMA-262 10.5.9).
    pub(super) fn proxy_set(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
        id: u16,
        value: Slot,
        receiver: Slot,
    ) -> Result<bool, Step> {
        let (target, handler) = self.proxy_target_handler(proxy, "set")?;
        let trap = match self.proxy_trap(code, handler, "set")? {
            Some(t) => t,
            None => return self.mop_set(code, target, id, value, receiver),
        };
        let handler_slot = Slot::of(Kind::Reference, Payload::Reference(handler));
        let target_slot = Slot::of(Kind::Reference, Payload::Reference(target));
        let key = self.property_key_slot(id)?;
        let result = self.invoke_value(
            code,
            trap,
            handler_slot,
            &[target_slot, key, value, receiver],
        )?;
        if !self.truthy(&result) {
            return Ok(false);
        }
        if let Some(d) = self.mop_get_own_property(code, target, id)? {
            if d.configurable == Some(false) {
                if d.is_data()
                    && d.writable == Some(false)
                    && !self.same_value(value, d.value.unwrap_or_else(Slot::undefined))
                {
                    return Err(self.catchable_type_error_msg("(proxy).set: true for non-configurable, non-writable property with different value".into()));
                }
                if d.is_accessor() && d.set.map(|s| s.kind == Kind::Undefined).unwrap_or(true) {
                    return Err(self.catchable_type_error_msg(
                        "(proxy).set: true for non-configurable property with different setter"
                            .into(),
                    ));
                }
            }
        }
        Ok(true)
    }

    /// `[[Delete]]` (ECMA-262 10.5.10).
    pub(super) fn proxy_delete(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
        id: u16,
    ) -> Result<bool, Step> {
        let (target, handler) = self.proxy_target_handler(proxy, "deleteProperty")?;
        let trap = match self.proxy_trap(code, handler, "deleteProperty")? {
            Some(t) => t,
            None => return self.mop_delete(code, target, id),
        };
        self.proxy_delete_trapped(code, target, handler, trap, ReadKey::Id(id))
    }

    /// The `deleteProperty` trap call and its invariant checks, shared by the
    /// id-keyed path and by [`Self::uninterned_index_proxy_delete`]. The trap
    /// arrives ALREADY RESOLVED, for the same reason as
    /// [`Self::proxy_get_own_property_trapped`].
    pub(super) fn proxy_delete_trapped(
        &mut self,
        code: &[u8],
        target: crate::value::SlotIndex,
        handler: crate::value::SlotIndex,
        trap: Slot,
        key_id: ReadKey,
    ) -> Result<bool, Step> {
        let handler_slot = Slot::of(Kind::Reference, Payload::Reference(handler));
        let target_slot = Slot::of(Kind::Reference, Payload::Reference(target));
        let key = self.read_key_slot(key_id)?;
        let result = self.invoke_value(code, trap, handler_slot, &[target_slot, key])?;
        if !self.truthy(&result) {
            return Ok(false);
        }
        // The trap may have named this index mid-flight (see
        // `refresh_read_key`); a stale `Index` would miss the very property
        // the invariant check exists to find.
        let key_id = self.refresh_read_key(key_id);
        let target_desc = self.mop_get_own_property_read(code, target, key_id)?;
        match target_desc {
            None => Ok(true),
            Some(d) => {
                if d.configurable == Some(false) {
                    return Err(self.catchable_type_error_msg(
                        "(proxy).deleteProperty: true for non-configurable property".into(),
                    ));
                }
                if !self.mop_is_extensible(code, target)? {
                    return Err(self.catchable_type_error_msg(
                        "(proxy).deleteProperty: true for non-extensible object".into(),
                    ));
                }
                Ok(true)
            }
        }
    }

    /// `[[OwnPropertyKeys]]` (ECMA-262 10.5.11).
    pub(super) fn proxy_own_keys(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
    ) -> Result<Vec<Slot>, Step> {
        let (target, handler) = self.proxy_target_handler(proxy, "ownKeys")?;
        let trap = match self.proxy_trap(code, handler, "ownKeys")? {
            Some(t) => t,
            None => return self.mop_own_keys(code, target),
        };
        let handler_slot = Slot::of(Kind::Reference, Payload::Reference(handler));
        let target_slot = Slot::of(Kind::Reference, Payload::Reference(target));
        let trap_result_array = self.invoke_value(code, trap, handler_slot, &[target_slot])?;
        let trap_keys = self.proxy_key_list(code, trap_result_array)?;
        // The invariant checks below only COMPARE key sets; they create
        // nothing. Naming each key to compare it made
        // `Object.getOwnPropertyNames(new Proxy(bigArray, {ownKeys}))` — and
        // the object spread that reaches the same trap — spend one id per
        // element of the target, which walks the `u16` space into the
        // saturation guard that poisons the machine.
        //
        // No duplicate keys allowed in the trap result.
        let mut seen: Vec<ReadKey> = self.reserve_scratch(trap_keys.len())?;
        for k in &trap_keys {
            let key = self.to_read_key(code, *k)?;
            self.charge_builtin_work(seen.len() as u64)?;
            if seen.contains(&key) {
                return Err(self.catchable_type_error_msg("(proxy).ownKeys: duplicate key".into()));
            }
            seen.push(key);
        }
        let extensible = self.mop_is_extensible(code, target)?;
        let target_keys = self.mop_own_keys(code, target)?;
        let mut target_configurable: Vec<ReadKey> = Vec::new();
        let mut target_nonconfigurable: Vec<ReadKey> = Vec::new();
        for tk in &target_keys {
            self.meter.tick_builtin();
            let key = self.to_read_key(code, *tk)?;
            match self.mop_get_own_property_read(code, target, key)? {
                Some(d) if d.configurable == Some(false) => target_nonconfigurable.push(key),
                _ => target_configurable.push(key),
            }
        }
        if extensible && target_nonconfigurable.is_empty() {
            return Ok(trap_keys);
        }
        // Every descriptor read above could have run a trap that names an
        // index, so an `Index` captured before one of them and an `Id` derived
        // after it can be the same property spelled two ways. Canonicalize
        // both sides HERE, at the point of comparison — after the last guest
        // code that could have changed the answer, and before the first
        // equality test that depends on it.
        for key in seen
            .iter_mut()
            .chain(&mut target_nonconfigurable)
            .chain(&mut target_configurable)
        {
            *key = self.refresh_read_key(*key);
        }
        let mut unchecked = seen.clone();
        for tid in &target_nonconfigurable {
            self.charge_builtin_work(unchecked.len() as u64)?;
            match unchecked.iter().position(|u| u == tid) {
                Some(pos) => {
                    unchecked.remove(pos);
                }
                None => {
                    return Err(self.catchable_type_error_msg(
                        "(proxy).ownKeys: no key for non-configurable property".into(),
                    ))
                }
            }
        }
        if extensible {
            return Ok(trap_keys);
        }
        for tid in &target_configurable {
            self.charge_builtin_work(unchecked.len() as u64)?;
            match unchecked.iter().position(|u| u == tid) {
                Some(pos) => {
                    unchecked.remove(pos);
                }
                None => {
                    return Err(self.catchable_type_error_msg(
                        "(proxy).ownKeys: no key for property of non-extensible object".into(),
                    ))
                }
            }
        }
        if !unchecked.is_empty() {
            return Err(self.catchable_type_error_msg(
                "(proxy).ownKeys: key for non-existent property of non-extensible object".into(),
            ));
        }
        Ok(trap_keys)
    }

    /// `[[Call]]` (ECMA-262 10.5.12). A light frame of the native-recursion
    /// budget, like the `mop_*` entries: a proxy over a callable proxy
    /// forwards `[[Call]]` here once per layer.
    pub(super) fn proxy_call(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
        this: Slot,
        args: &[Slot],
    ) -> Result<Slot, Step> {
        self.with_native_frame(LIGHT_FRAME_COST, |vm| {
            vm.proxy_call_inner(code, proxy, this, args)
        })
    }

    pub(super) fn proxy_call_inner(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
        this: Slot,
        args: &[Slot],
    ) -> Result<Slot, Step> {
        let (target, handler) = self.proxy_target_handler(proxy, "apply")?;
        let target_slot = Slot::of(Kind::Reference, Payload::Reference(target));
        let trap = match self.proxy_trap(code, handler, "apply")? {
            Some(t) => t,
            None => {
                let metering = if self.proxies.contains_key(&target) {
                    PROXY_CALL_FORWARD_PROXY_METERING
                } else if self.bound_functions.contains_key(&target) {
                    PROXY_CALL_FORWARD_BOUND_METERING
                } else if self.native_of(target).is_some() {
                    PROXY_CALL_FORWARD_NATIVE_METERING
                } else if let Some(method) = self.method_of(target) {
                    if matches!(
                        method,
                        NativeMethod::CollForEach
                            | NativeMethod::CollEntries
                            | NativeMethod::CollKeys
                            | NativeMethod::CollValues
                            | NativeMethod::CollClear
                    ) {
                        PROXY_CALL_FORWARD_METHOD_METERING
                    } else {
                        PROXY_CALL_FORWARD_NATIVE_METERING
                    }
                } else {
                    PROXY_CALL_FORWARD_USER_METERING
                };
                self.charge_and_check(metering)?;
                return self.invoke_value(code, target_slot, this, args);
            }
        };
        self.meter.tick_raw(PROXY_CALL_TRAP_METERING);
        let handler_slot = Slot::of(Kind::Reference, Payload::Reference(handler));
        let arg_array = self.array_from_slots(args);
        self.invoke_value(code, trap, handler_slot, &[target_slot, this, arg_array])
    }

    /// `[[Construct]]` (ECMA-262 10.5.13). A light frame of the
    /// native-recursion budget, like [`Self::proxy_call`].
    pub(super) fn proxy_construct(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
        args: &[Slot],
        new_target: Slot,
    ) -> Result<Slot, Step> {
        self.with_native_frame(LIGHT_FRAME_COST, |vm| {
            vm.proxy_construct_inner(code, proxy, args, new_target)
        })
    }

    pub(super) fn proxy_construct_inner(
        &mut self,
        code: &[u8],
        proxy: crate::value::SlotIndex,
        args: &[Slot],
        new_target: Slot,
    ) -> Result<Slot, Step> {
        let (target, handler) = self.proxy_target_handler(proxy, "construct")?;
        let target_slot = Slot::of(Kind::Reference, Payload::Reference(target));
        let trap = match self.proxy_trap(code, handler, "construct")? {
            Some(t) => t,
            None => return self.construct_value(code, target_slot, args, new_target),
        };
        let handler_slot = Slot::of(Kind::Reference, Payload::Reference(handler));
        let arg_array = self.array_from_slots(args);
        let result = self.invoke_value(
            code,
            trap,
            handler_slot,
            &[target_slot, arg_array, new_target],
        )?;
        if result.kind != Kind::Reference {
            return Err(self.catchable_type_error_msg("(proxy).construct: not an object".into()));
        }
        Ok(result)
    }

    /// Dispatch an `Object.*` static whose object operand is a **proxy**
    /// (ECMA-262 20.1.2.*), routing through the proxy-aware `mop_*` internal
    /// methods so the traps run and their invariants hold.
    pub(super) fn object_static_proxy(
        &mut self,
        m: NativeMethod,
        proxy: crate::value::SlotIndex,
        base: usize,
        argc: usize,
        code: &[u8],
    ) -> Result<Slot, Step> {
        let proxy_slot = Slot::of(Kind::Reference, Payload::Reference(proxy));
        let arg = |slf: &Self, i: usize| -> Slot {
            slf.stack
                .get(base + 4 + i)
                .copied()
                .unwrap_or_else(Slot::undefined)
        };
        match m {
            NativeMethod::ObjectIsExtensible => {
                Ok(Slot::boolean(self.mop_is_extensible(code, proxy)?))
            }
            NativeMethod::ObjectPreventExtensions => {
                if !self.mop_prevent_extensions(code, proxy)? {
                    return Err(self.catchable_type_error_msg("extensible object".into()));
                }
                Ok(proxy_slot)
            }
            NativeMethod::ObjectGetOwnPropertyDescriptor => {
                let key = self.to_read_key(code, arg(self, 1))?;
                match self.mop_get_own_property_read(code, proxy, key)? {
                    Some(d) => Ok(self.descriptor_object(d)),
                    None => Ok(Slot::undefined()),
                }
            }
            NativeMethod::ObjectGetOwnPropertyDescriptors => {
                let keys = self.mop_own_keys(code, proxy)?;
                let result = self.slots.alloc(Slot::instance(self.object_proto));
                for key in keys {
                    let id = self.to_property_id(code, key)?;
                    if let Some(d) = self.mop_get_own_property(code, proxy, id)? {
                        let desc = self.descriptor_object(d);
                        self.define_descriptor_field_slot(result, key, desc);
                    }
                }
                Ok(Slot::of(Kind::Reference, Payload::Reference(result)))
            }
            NativeMethod::ObjectGetOwnPropertyNames => {
                let mut strings = self.mop_own_keys(code, proxy)?;
                strings.retain(|key| key.kind == Kind::String);
                Ok(self.array_from_slots(&strings))
            }
            NativeMethod::ObjectGetOwnPropertySymbols => {
                let mut symbols = self.mop_own_keys(code, proxy)?;
                symbols.retain(|key| key.kind == Kind::Symbol);
                Ok(self.array_from_slots(&symbols))
            }
            NativeMethod::ObjectKeys | NativeMethod::ObjectValues | NativeMethod::ObjectEntries => {
                // EnumerableOwnPropertyNames: string keys whose own descriptor
                // is enumerable; then keys / values / [key,value] entries.
                let keys = self.mop_own_keys(code, proxy)?;
                let mut out = self.reserve_scratch(keys.len())?;
                for key in keys {
                    if key.kind != Kind::String {
                        continue;
                    }
                    // Pure observation: this asks whether the descriptor is
                    // enumerable and then reads the value, and the array it
                    // builds is keyed by POSITION, not by name. Naming each
                    // key to ask made `Object.keys(new Proxy(bigArray, {}))`
                    // — the common spelling, where
                    // `getOwnPropertyNames(proxy)` is the rare one — walk the
                    // `u16` id space into the guard that poisons the machine.
                    let read_key = self.to_read_key(code, key)?;
                    match self.mop_get_own_property_read(code, proxy, read_key)? {
                        Some(d) if d.enumerable == Some(true) => d,
                        _ => continue,
                    };
                    // The descriptor trap is guest code and can have named
                    // this index before the value read below.
                    let read_key = self.refresh_read_key(read_key);
                    match m {
                        NativeMethod::ObjectKeys => out.push(key),
                        NativeMethod::ObjectValues => {
                            out.push(self.mop_get_read(code, proxy, read_key, proxy_slot)?)
                        }
                        _ => {
                            let value = self.mop_get_read(code, proxy, read_key, proxy_slot)?;
                            let pair = self.array_from_slots(&[key, value]);
                            out.push(pair);
                        }
                    }
                }
                Ok(self.array_from_slots(&out))
            }
            NativeMethod::ObjectDefineProperty => {
                let id = self.to_property_id(code, arg(self, 1))?;
                let descref = match arg(self, 2).value {
                    Payload::Reference(d) if arg(self, 2).kind == Kind::Reference => d,
                    _ => return Err(self.catchable_type_error_msg("invalid descriptor".into())),
                };
                let desc = self.descriptor_from_object(code, descref)?;
                if !self.mop_define_own_property(code, proxy, id, desc)? {
                    return Err(self.catchable_type_error_msg("invalid descriptor".into()));
                }
                Ok(proxy_slot)
            }
            NativeMethod::ObjectDefineProperties => {
                if arg(self, 1).kind == Kind::Undefined {
                    return Err(self.catchable_type_error_msg("invalid properties".into()));
                }
                let props = self.array_to_object(arg(self, 1))?;
                let Payload::Reference(props) = props.value else {
                    unreachable!("ToObject returns a reference")
                };
                if !self.define_properties_from_object(code, proxy, props)? {
                    return Err(self.catchable_type_error_msg("invalid descriptor".into()));
                }
                Ok(proxy_slot)
            }
            NativeMethod::ObjectSeal | NativeMethod::ObjectFreeze => {
                let frozen = matches!(m, NativeMethod::ObjectFreeze);
                self.set_integrity_level(code, proxy, frozen)?;
                Ok(proxy_slot)
            }
            NativeMethod::ObjectIsSealed | NativeMethod::ObjectIsFrozen => {
                let frozen = matches!(m, NativeMethod::ObjectIsFrozen);
                Ok(Slot::boolean(
                    self.test_integrity_level(code, proxy, frozen)?,
                ))
            }
            _ => {
                let _ = argc;
                Err(Step::Host(Halt::EngineInvariant(
                    "Object-static:unexpected-proxy",
                )))
            }
        }
    }

    /// Add one own enumerable data property with a **key slot** (string or
    /// symbol) — the symbol-keyed analogue of [`Self::define_descriptor_field`].
    pub(super) fn define_descriptor_field_slot(
        &mut self,
        inst: crate::value::SlotIndex,
        key: Slot,
        value: Slot,
    ) {
        let id = match self.to_property_id(&[], key) {
            Ok(id) => id,
            Err(_) => return,
        };
        let head = self.slots.get(inst).next;
        let mut prop = value;
        prop.id = id;
        prop.flag = 0;
        prop.next = head;
        let idx = self.slots.alloc(prop);
        self.slots.get_mut(inst).next = idx;
    }

    /// Build a dense `Array` from a slot list (`CreateArrayFromList`).
    pub(super) fn array_from_slots(&mut self, items: &[Slot]) -> Slot {
        self.meter.tick_raw(ARRAY_CREATE_METERING);
        self.meter
            .tick_raw(self.array_chunk_size_metering(items.len() as u32));
        let inst = self.slots.alloc(Slot::instance(self.array_proto));
        let mut data = ArrayData::default();
        data.length = items.len() as u32;
        for (i, s) in items.iter().enumerate() {
            data.insert_item(i as u32, *s, &mut self.side_refs);
        }
        self.arrays.insert(inst, data);
        Slot::of(Kind::Reference, Payload::Reference(inst))
    }

    /// `ValidateAndApplyPropertyDescriptor(undefined, P, extensible, Desc,
    /// current)` reduced to its boolean validity result (ECMA-262 10.1.6.3 with
    /// `O` undefined — `IsCompatiblePropertyDescriptor`). `Desc` is a completed
    /// descriptor; `current` is the target's own descriptor (or `None`).
    pub(super) fn is_compatible_descriptor(
        &mut self,
        extensible: bool,
        desc: &OrdinaryDescriptor,
        current: Option<&OrdinaryDescriptor>,
    ) -> bool {
        self.meter.tick_builtin(); // ordinary and Proxy descriptor invariant work
        let current = match current {
            None => return extensible,
            Some(c) => c,
        };
        if current.configurable == Some(false) {
            if desc.configurable == Some(true) {
                return false;
            }
            if desc.enumerable.is_some() && desc.enumerable != current.enumerable {
                return false;
            }
            let desc_generic = !desc.is_accessor() && !desc.is_data();
            if desc_generic {
                return true;
            }
            if desc.is_accessor() != current.is_accessor() {
                return false;
            }
            if current.is_accessor() {
                if let Some(g) = desc.get {
                    if !self.same_value(g, current.get.unwrap_or_else(Slot::undefined)) {
                        return false;
                    }
                }
                if let Some(s) = desc.set {
                    if !self.same_value(s, current.set.unwrap_or_else(Slot::undefined)) {
                        return false;
                    }
                }
            } else if current.writable == Some(false) {
                if desc.writable == Some(true) {
                    return false;
                }
                if let Some(v) = desc.value {
                    if !self.same_value(v, current.value.unwrap_or_else(Slot::undefined)) {
                        return false;
                    }
                }
            }
        }
        true
    }

    pub(super) fn descriptor_from_object(
        &mut self,
        code: &[u8],
        descriptor: crate::value::SlotIndex,
    ) -> Result<OrdinaryDescriptor, Step> {
        let mut out = OrdinaryDescriptor::default();
        for name in [
            "enumerable",
            "configurable",
            "value",
            "writable",
            "get",
            "set",
        ] {
            // ToPropertyDescriptor performs HasProperty for all six standard
            // names even when the current program has never mentioned one.
            // Intern each key here rather than letting the symbol table's
            // incidental contents suppress observable Proxy traps.
            let id = self.intern_key(name);
            if !self.mop_has(code, descriptor, id)? {
                continue;
            }
            let receiver = Slot::of(Kind::Reference, Payload::Reference(descriptor));
            let value = self.mop_get(code, descriptor, id, receiver)?;
            match name {
                // ToBoolean via `truthy`, not the bare `to_boolean`: an
                // attribute given as `""` or `0n` is falsy, and only the
                // machine can read the string/bigint payload to know it.
                "enumerable" => out.enumerable = Some(self.truthy(&value)),
                "configurable" => out.configurable = Some(self.truthy(&value)),
                "value" => out.value = Some(value),
                "writable" => out.writable = Some(self.truthy(&value)),
                "get" => out.get = Some(value),
                "set" => out.set = Some(value),
                _ => unreachable!(),
            }
        }
        // XS fxDescriptorToSlot reads every field before validating getter
        // and setter combinations, so later accessors can still throw first.
        for (name, accessor) in [("get", out.get), ("set", out.set)] {
            if let Some(value) = accessor {
                if out.value.is_some() {
                    return Err(self.catchable_type_error_msg(format!(
                        "descriptor: {name} and value properties"
                    )));
                }
                if out.writable.is_some() {
                    return Err(self.catchable_type_error_msg(format!(
                        "descriptor: {name} and writable properties"
                    )));
                }
                if value.kind == Kind::Null {
                    return Err(
                        self.catchable_type_error_msg("cannot coerce null to object".into())
                    );
                }
                if value.kind != Kind::Undefined && !self.is_callable_value(value) {
                    return Err(
                        self.catchable_type_error_msg(format!("descriptor.{name}: not a function"))
                    );
                }
            }
        }
        Ok(out)
    }

    /// `ToPropertyKey(argument)`: preserve a Symbol's identity; otherwise use
    /// the string-hint `ToPrimitive` path followed by metered `ToString`.
    /// Keeping the resulting string slot separate from interning lets callers
    /// apply receiver-specific checks (canonical numeric indices and the
    /// boot-default soundness gate) before the name enters `symbol_ids`.
    pub(super) fn to_property_key(&mut self, code: &[u8], key: Slot) -> Result<Slot, Step> {
        if key.kind == Kind::Symbol {
            return Ok(key);
        }
        let primitive = self.to_primitive(code, key, true)?;
        if primitive.kind == Kind::Symbol {
            return Ok(primitive);
        }
        Ok(self.to_string_slot_metered(primitive))
    }

    pub(super) fn to_property_id(&mut self, code: &[u8], key: Slot) -> Result<u16, Step> {
        if let Payload::At(id, index) = key.value {
            return Ok(if id == crate::value::XS_NO_ID {
                self.intern_key(index.to_string())
            } else {
                id
            });
        }
        let property_key = self.to_property_key(code, key)?;
        if property_key.kind == Kind::Symbol {
            return match property_key.value {
                Payload::Reference(descriptor) => Ok(self.intern_symbol_key(descriptor)),
                // A `Kind::Symbol` slot always carries its descriptor
                // reference; anything else is a port invariant break, not
                // guest behavior.
                _ => Err(Step::Host(Halt::EngineInvariant(
                    "to_property_id:symbol-without-descriptor",
                ))),
            };
        }
        let name = match property_key.value {
            Payload::String(offset) => SymbolName::from_units(&self.str_units(offset)),
            // `to_property_key` returns a string or a symbol; anything else
            // is a port invariant break.
            _ => {
                return Err(Step::Host(Halt::EngineInvariant(
                    "to_property_id:non-string-key",
                )))
            }
        };
        let id = self.intern_key(&name);
        // A runtime-computed key can be the first observation of a standard
        // global or intrinsic member. `intern_key` makes the global itself
        // visible immediately; complete the ordinary create-only install pass
        // before the reflective operation continues so that constructor is
        // not observably hollow for the rest of this crank. The name floor
        // prevents an already-considered guest deletion or monkeypatch from
        // being resurrected.
        self.install_pending_intrinsics();
        Ok(id)
    }

    pub(super) fn property_key_slot(&mut self, id: u16) -> Result<Slot, Step> {
        if let Some((&descriptor, _)) = self
            .symbol_key_ids
            .iter()
            .find(|(_, property_id)| **property_id == id)
        {
            return Ok(Slot::of(Kind::Symbol, Payload::Reference(descriptor)));
        }
        let name = self
            .symbol_ids
            .iter()
            .find_map(|(name, property_id)| (*property_id == id).then_some(name))
            .ok_or(Step::Host(Halt::EngineInvariant(
                "ordinary-ownKeys:unknown-key",
            )))?;
        // Canonical CESU-8 has one leading byte per UTF-16 code unit.
        let count = name
            .as_bytes()
            .iter()
            .filter(|b| **b & 0xc0 != 0x80)
            .count();
        self.charge_and_check(string_chunk_cost(count as u64))?;
        self.admit_scratch::<u16>(count)?;
        let units = self
            .symbol_ids
            .iter()
            .find_map(|(name, property_id)| (*property_id == id).then(|| name.to_units()))
            .expect("admission does not change symbol identities");
        let offset = self.chunks.alloc(&units_to_be16(&units));
        Ok(Slot::of(Kind::String, Payload::String(offset)))
    }

    pub(super) fn define_properties_from_object(
        &mut self,
        code: &[u8],
        target: crate::value::SlotIndex,
        descriptors: crate::value::SlotIndex,
    ) -> Result<bool, Step> {
        let receiver = Slot::of(Kind::Reference, Payload::Reference(descriptors));
        let keys = self.mop_own_keys(code, descriptors)?;
        let mut pending = self.reserve_scratch(keys.len())?;
        for key in keys {
            let id = self.to_property_id(code, key)?;
            let enumerable = self
                .mop_get_own_property(code, descriptors, id)?
                .is_some_and(|descriptor| descriptor.enumerable == Some(true));
            if !enumerable {
                continue;
            }
            let value = self.mop_get(code, descriptors, id, receiver)?;
            let descriptor_object = match value.value {
                Payload::Reference(object) if value.kind == Kind::Reference => object,
                _ => return Err(self.catchable_type_error_msg("descriptor: not an object".into())),
            };
            pending.push((id, self.descriptor_from_object(code, descriptor_object)?));
        }
        for (id, descriptor) in pending {
            if !self.mop_define_own_property(code, target, id, descriptor)? {
                return Ok(false);
            }
        }
        Ok(true)
    }

    pub(super) fn alloc_descriptor_instance(&mut self) -> crate::value::SlotIndex {
        self.meter.tick_slot_alloc();
        self.slots.alloc(Slot::instance(self.object_proto))
    }

    pub(super) fn descriptor_object(&mut self, descriptor: OrdinaryDescriptor) -> Slot {
        let object = self.alloc_descriptor_instance();
        if descriptor.is_accessor() {
            self.define_descriptor_field(
                object,
                "get",
                descriptor.get.unwrap_or_else(Slot::undefined),
            );
            self.define_descriptor_field(
                object,
                "set",
                descriptor.set.unwrap_or_else(Slot::undefined),
            );
        } else {
            self.define_descriptor_field(
                object,
                "value",
                descriptor.value.unwrap_or_else(Slot::undefined),
            );
            self.define_descriptor_field(
                object,
                "writable",
                Slot::boolean(descriptor.writable.unwrap_or(false)),
            );
        }
        self.define_descriptor_field(
            object,
            "enumerable",
            Slot::boolean(descriptor.enumerable.unwrap_or(false)),
        );
        self.define_descriptor_field(
            object,
            "configurable",
            Slot::boolean(descriptor.configurable.unwrap_or(false)),
        );
        Slot::of(Kind::Reference, Payload::Reference(object))
    }

    pub(super) fn instance_put(
        &mut self,
        inst: crate::value::SlotIndex,
        id: u16,
        value: Slot,
    ) -> bool {
        if let Some(p) = self.find_property(inst, id) {
            let s = self.slots.get_mut(p);
            s.kind = value.kind;
            s.value = value.value;
            false
        } else {
            self.tick_property_create_flat(); // fxNewSlot + property-table growth (536)
            if inst == self.global_obj {
                // A new own property of the global object — a `globalThis.x = 1`
                // (or computed `globalThis["x"] = 1`) creating a binding — is a
                // new *global*, which identifier resolution and every later
                // `var`/sloppy-global op must see. Route it through
                // `create_global_property`, the sole writer of the
                // `global_props` fast index, so the index and the chain stay
                // one-to-one (the invariant `rebuild_global_props` relies on).
                // The metering is already charged above, exactly as for any
                // other property create; `create_global_property` itself does
                // not meter.
                self.create_global_property(id, (value.kind, value.value));
            } else {
                let head = self.slots.get(inst).next;
                let mut prop = value;
                prop.id = id;
                prop.flag = 0;
                prop.next = head;
                let idx = self.slots.alloc(prop);
                self.slots.get_mut(inst).next = idx;
            }
            true
        }
    }

    /// Delete own property `id` from instance `inst` (XS's
    /// `mxBehaviorDeleteProperty` for an ordinary object): unlink the
    /// property slot from the owner's `next`-linked list and free it.
    /// Returns `true` when the property was configurable-and-removed or was
    /// absent (both are `true` for `delete`); the covered grammar creates
    /// only configurable own data properties, so this is always `true`. No
    /// allocation, so — like XS's ordinary delete — it meters only its
    /// dispatch.
    pub(super) fn delete_own_property(&mut self, inst: crate::value::SlotIndex, id: u16) -> bool {
        // A function's exotic `length`/`name` own data property is configurable
        // (`{configurable:true}`), but ironhorse synthesizes it from the
        // `FuncInfo` rather than an ordinary slot, so there is nothing in the
        // chain to unlink. When no ordinary slot shadows the id, record a
        // tombstone (XS unlinks the real slot) so the reflective paths report it
        // absent thereafter, and report the delete as succeeded.
        if self.functions.contains_key(&inst)
            && (Some(id) == self.length_id || Some(id) == self.name_id)
            && self.find_property(inst, id).is_none()
        {
            self.deleted_fn_meta.insert((inst, id));
            return true;
        }
        let deleted_index_limit = self
            .is_ordinary_object(inst)
            .then(|| {
                self.scalar_key_text(id)
                    .as_deref()
                    .and_then(string_to_index)
            })
            .flatten()
            .map(|index| index.saturating_add(1));
        let mut prev = inst;
        let mut cur = self.slots.get(inst).next;
        while !cur.is_null() {
            let s = self.slots.get(cur);
            if s.id == id {
                // A non-configurable own property (`XS_DONT_DELETE_FLAG` — the
                // state `seal`/`freeze`/`defineProperty(configurable:false)`
                // stamps) refuses deletion: `mxBehaviorDeleteProperty` returns
                // `false`, leaving the property in place (a strict `delete`
                // throws on the `false`; a sloppy one yields `false`).
                if s.flag & XS_DONT_DELETE_FLAG != 0 {
                    return false;
                }
                // XS retains an ordinary object's resident indexed-array
                // high-water mark after deleting a visible indexed property.
                // Reuse the deleted property slot as an internal numeric
                // tombstone: heap snapshots and SQLite pages then carry the
                // state without a new side-table/schema row. Ordinary
                // property enumeration filters internal slots.
                let retained_here = if let Some(limit) = deleted_index_limit {
                    let existing = self.internal_indexed_limit_slot(inst);
                    if let Some(tombstone) = existing {
                        let retained = self.internal_indexed_limit(inst).max(limit);
                        self.slots.get_mut(tombstone).value = Payload::Number(f64::from(retained));
                        false
                    } else {
                        let tombstone = self.slots.get_mut(cur);
                        tombstone.id = crate::value::XS_NO_ID;
                        tombstone.flag = XS_INTERNAL_FLAG;
                        tombstone.kind = Kind::Number;
                        tombstone.value = Payload::Number(f64::from(limit));
                        true
                    }
                } else {
                    false
                };
                if !retained_here {
                    // Unlink `cur` from the chain and free its slot.
                    self.slots.get_mut(prev).next = s.next;
                    self.slots.free(cur);
                }
                // Keep the global-object fast index one-to-one with the chain:
                // `delete globalThis.x` (or `delete` of a sloppy global) must
                // drop the `global_props` entry too, else identifier resolution
                // would keep reading the now-freed slot. Only the global object
                // carries a fast index; every other instance has none.
                if inst == self.global_obj {
                    self.global_props.remove(&id);
                }
                self.accessors.remove(&(inst, id));
                return true;
            }
            prev = cur;
            cur = s.next;
        }
        true
    }

    /// Find the internal ordinary-indexed-storage high-water tombstone.
    /// `XS_NO_ID + XS_INTERNAL_FLAG + Number` is unobservable as a property
    /// and mirrors the internal slot shape XS itself keeps on indexed objects.
    pub(super) fn internal_indexed_limit_slot(
        &self,
        inst: crate::value::SlotIndex,
    ) -> Option<crate::value::SlotIndex> {
        let mut cur = self.slots.get(inst).next;
        while !cur.is_null() {
            let slot = self.slots.get(cur);
            if slot.id == crate::value::XS_NO_ID
                && slot.flag & XS_INTERNAL_FLAG != 0
                && slot.kind == Kind::Number
            {
                return Some(cur);
            }
            cur = slot.next;
        }
        None
    }

    pub(super) fn internal_indexed_limit(&self, inst: crate::value::SlotIndex) -> u32 {
        self.internal_indexed_limit_slot(inst)
            .and_then(|slot| match self.slots.get(slot).value {
                Payload::Number(limit) if limit >= 0.0 && limit <= f64::from(u32::MAX) => {
                    Some(limit as u32)
                }
                _ => None,
            })
            .unwrap_or(0)
    }

    /// Read a **named** property `id` of a primitive string (XS's string
    /// behavior boxing to `%String.prototype%`): `.length` is the UTF-16
    /// code-unit count (an unmetered accessor, like `arr.length`); any other
    /// name is the full `[[Get]]` up the `%String.prototype%` chain, with the
    /// primitive `receiver` as the accessor's `this` (see [`Interp::
    /// ordinary_get`]). A getter that throws returns `Err`, which the callers
    /// route to the enclosing `catch`.
    pub(super) fn string_property_get(
        &mut self,
        code: &[u8],
        off: crate::value::ChunkOffset,
        id: u16,
        receiver: Slot,
    ) -> Result<Slot, Step> {
        if Some(id) == self.length_id {
            // `length` is O(1) over UTF-16 storage: half the stored byte payload.
            return Ok(Slot::integer(self.str_len(off) as i32));
        }
        let proto = self.string_proto;
        if proto.is_null() {
            return Ok(Slot::undefined());
        }
        self.ordinary_get(code, proto, id, receiver)
    }

    /// Read a computed index of a primitive string (`str[i]`): the one-unit
    /// string at UTF-16 code-unit index `index` (direct, O(1) — no boundary
    /// walk), or `undefined` past the end. Allocates the one-unit result chunk
    /// (`fxStringGetProperty` → `fxNewChunk`), metered via
    /// [`Interp::new_string_units`].
    pub(super) fn string_index_get(&mut self, off: crate::value::ChunkOffset, index: u32) -> Slot {
        match self.str_unit_at(off, index) {
            Some(unit) => self.new_string_units(&[unit]),
            None => Slot::undefined(),
        }
    }

    /// Read own property `id` of instance `inst` (or `undefined` when
    /// absent — the covered grammar has a null prototype, so there is no
    /// prototype walk yet).
    pub(super) fn instance_get(&self, inst: crate::value::SlotIndex, id: u16) -> Slot {
        // Walk the prototype chain (XS's `mxBehaviorGetProperty`): own first,
        // then each prototype, to the root. Metering is unchanged — a chain
        // walk meters no built-in step, exactly as an own read. The prototype
        // objects carry data only for names the program references (the
        // linked intrinsic methods), so this stays invisible to reads of
        // ordinary objects with no matching inherited property.
        let mut cur = inst;
        while !cur.is_null() {
            if let Some(p) = self.find_property(cur, id) {
                let s = self.slots.get(p);
                return Slot::of(s.kind, s.value);
            }
            cur = self.instance_prototype(cur);
        }
        Slot::undefined()
    }

    /// Does `inst` have property `id` as an own-or-inherited property (XS's
    /// `mxBehaviorHasProperty` chain walk, the `fxHasAll` half of `fxHasAt`)?
    /// Returns `(present, recursions)` where `recursions` is the number of
    /// prototype levels descended past the receiver — exactly the count of
    /// recursive `fxOrdinaryHasProperty` calls XS makes, each of which meters
    /// one `XS_CODE_METERING`: `0` when found own, `k` when found on the
    /// k-th prototype, and the full chain length minus one on a total miss.
    /// The prototype objects carry data only for names the program references,
    /// so a `false` here is only *sound* for a name that cannot be an unlinked
    /// inherited built-in — the caller (`XS_CODE_IN`) gates on `default_keys`.
    pub(super) fn instance_has(&self, inst: crate::value::SlotIndex, id: u16) -> (bool, u64) {
        let mut cur = inst;
        let mut recursions = 0u64;
        loop {
            if self.find_property(cur, id).is_some() {
                return (true, recursions);
            }
            let proto = self.instance_prototype(cur);
            if proto.is_null() {
                return (false, recursions);
            }
            cur = proto;
            recursions += 1;
        }
    }
}
