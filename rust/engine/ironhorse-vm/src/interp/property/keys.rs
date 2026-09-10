//! Property keys operations.
use crate::interp::*;

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
    pub(in crate::interp) fn intern_key_reserved(&mut self, name: impl Into<SymbolName>) -> u16 {
        let name: SymbolName = name.into();
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

    /// Keep 1,024 ids for bounded engine bookkeeping and error construction.
    /// Guest-driven novel names must stop before the irreversible hard latch;
    /// already-interned names remain usable at the soft ceiling.
    pub(in crate::interp) fn admit_guest_key_count(&mut self, count: usize) -> Result<(), Step> {
        if !self.has_guest_key_capacity(count) {
            return Err(self.catchable_range_error_msg("property key space exhausted".into()));
        }
        Ok(())
    }

    pub(in crate::interp) fn has_guest_key_capacity(&self, count: usize) -> bool {
        count == 0
            || self
                .symbol_names
                .len()
                .saturating_add(count)
                .saturating_add(PROPERTY_KEY_RESERVE)
                < self.next_symbol_key_id as usize
    }

    fn admit_guest_key(&mut self, name: &SymbolName) -> Result<(), Step> {
        self.admit_guest_key_count(usize::from(!self.symbol_ids.contains_key(name)))
    }

    pub(in crate::interp) fn intern_key(
        &mut self,
        name: impl Into<SymbolName>,
    ) -> Result<u16, Step> {
        let name: SymbolName = name.into();
        self.admit_guest_key(&name)?;
        Ok(self.intern_key_reserved(name))
    }

    pub(in crate::interp) fn intern_key_unmetered(
        &mut self,
        name: impl Into<SymbolName>,
    ) -> Result<u16, Step> {
        let name: SymbolName = name.into();
        self.admit_guest_key(&name)?;
        if let Some(&id) = self.symbol_ids.get(&name) {
            return Ok(id);
        }
        Ok(self.append_name_key(name))
    }

    /// Only the engine's bounded, static vocabulary may use reserved ids.
    pub(in crate::interp) fn intern_static_key(&mut self, name: &'static str) -> u16 {
        self.intern_key_reserved(name)
    }

    /// Append a novel string key to the name table and hand out its id (the
    /// new table position). The table IS the persisted id→name map (the NAME
    /// row), so a key interned here round-trips a snapshot with its id — the
    /// unification that retired the string-key half of the old runtime-intern
    /// persistence refusal. Saturates at the symbol-key floor when the two id
    /// spaces meet (the exhaustion hazard documented on
    /// [`Self::next_symbol_key_id`]).
    pub(in crate::interp) fn append_name_key(&mut self, name: impl Into<SymbolName>) -> u16 {
        let name: SymbolName = name.into();
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
    pub(in crate::interp) fn intern_static_key_unmetered(&mut self, name: &'static str) -> u16 {
        let name: SymbolName = name.into();
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
    pub(in crate::interp) fn intern_symbol_key_reserved(
        &mut self,
        desc: crate::value::SlotIndex,
    ) -> u16 {
        let (id, newly_interned) = if let Some(&id) = self.symbol_key_ids.get(&desc) {
            (id, false)
        } else if (self.next_symbol_key_id as usize) <= self.symbol_names.len().saturating_add(1) {
            // Same poison latch as `append_name_key`: the placeholder id
            // aliases, but the loop-top halt fires before the next
            // instruction, so it never leaks to a completed crank.
            self.id_space_exhausted = true;
            let id = self.next_symbol_key_id;
            (id, false)
        } else {
            let id = self.next_symbol_key_id;
            self.snapshot_dirt.mark(SnapshotSection::Symbols.mask());
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

    pub(in crate::interp) fn intern_symbol_key(
        &mut self,
        desc: crate::value::SlotIndex,
    ) -> Result<u16, Step> {
        self.admit_guest_key_count(usize::from(!self.symbol_key_ids.contains_key(&desc)))?;
        Ok(self.intern_symbol_key_reserved(desc))
    }

    /// Resolve a realm well-known symbol to the property id used by ordinary
    /// object lookup. The descriptor identity, rather than its description,
    /// is the key, so a guest-created `Symbol("iterator")` remains distinct
    /// from `Symbol.iterator`.
    pub(in crate::interp) fn well_known_symbol_property_id(&mut self, name: &str) -> Option<u16> {
        let descriptor = self
            .well_known_symbols
            .iter()
            .find_map(|(symbol_name, value)| (*symbol_name == name).then_some(value.value))?;
        match descriptor {
            Payload::Reference(descriptor) => Some(self.intern_symbol_key_reserved(descriptor)),
            _ => None,
        }
    }

    /// Materialize symbol-keyed boot properties whose function identity was
    /// minted below `boot_slot_count` but whose property id must remain lazy.
    pub(in crate::interp) fn install_well_known_symbol_property(
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
                let key = self.intern_static_key_unmetered(name);
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
    pub(in crate::interp) fn is_symbol_key_id(&self, id: u16) -> bool {
        self.symbol_key_ids.descriptor(id).is_some()
    }

    /// Scalar-only dispatch for array indices and built-in names.
    /// Guest-visible keys must use `property_key_slot` instead.
    pub(in crate::interp) fn scalar_key_text(&self, id: u16) -> Option<String> {
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
    pub(in crate::interp) fn property_key_id(
        &mut self,
        key: Slot,
        gate_default: bool,
    ) -> Result<Option<u16>, Step> {
        Ok(match key.kind {
            Kind::Symbol => match key.value {
                Payload::Reference(desc) => Some(self.intern_symbol_key(desc)?),
                _ => None,
            },
            Kind::String => {
                let s = match key.value {
                    Payload::String(off) => SymbolName::from_units(&self.str_units(off)),
                    _ => return Ok(None),
                };
                if gate_default
                    && !self.symbol_ids.contains_key(&s)
                    && s.as_str().is_some_and(|s| self.default_keys.contains(s))
                {
                    return Ok(None);
                }
                Some(self.intern_key(&s)?)
            }
            _ => None,
        })
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
    pub(in crate::interp) fn resolve_at_key(&mut self, key: Slot) -> Result<Option<Slot>, Step> {
        Ok(match key.kind {
            Kind::At => Some(key),
            Kind::Integer => {
                let i = match key.value {
                    Payload::Integer(i) => i,
                    _ => return Ok(None),
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
                    let id = self.intern_key(&name)?;
                    Some(Slot::of(Kind::At, Payload::At(id, 0)))
                }
            }
            Kind::Number => {
                let n = match key.value {
                    Payload::Number(n) => n,
                    _ => return Ok(None),
                };
                if n >= 0.0 && n.fract() == 0.0 && n < 4294967295.0 {
                    Some(Slot::of(
                        Kind::At,
                        Payload::At(crate::value::XS_NO_ID, n as u32),
                    ))
                } else {
                    let name = number_to_ecma_string(n);
                    let id = self.intern_key(&name)?;
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
                        _ => return Ok(None),
                    },
                    Kind::BigInt => match key.value {
                        Payload::BigInt(off) => {
                            let (negative, magnitude) = self.read_bigint(off);
                            bi_to_decimal(negative, &magnitude)
                        }
                        _ => return Ok(None),
                    },
                    _ => unreachable!(),
                };
                // None of these primitive spellings names a standard inherited
                // object property. In particular, `undefined` is a global own
                // property, not an `%Object.prototype%` property, so the broad
                // boot-default ambiguity gate used for arbitrary strings does
                // not apply here.
                let id = self.intern_key(&name)?;
                Some(Slot::of(Kind::At, Payload::At(id, 0)))
            }
            // A symbol key (`o[sym]`): resolve its descriptor-slot identity to
            // the interned property id (XS's `mxID(symbol)`). No index branch —
            // a symbol never string-coerces to an array index.
            Kind::Symbol => match key.value {
                Payload::Reference(desc) => {
                    let id = self.intern_symbol_key(desc)?;
                    Some(Slot::of(Kind::At, Payload::At(id, 0)))
                }
                _ => None,
            },
            Kind::String => {
                let content = match key.value {
                    Payload::String(off) => SymbolName::from_units(&self.str_units(off)),
                    _ => return Ok(None),
                };
                let s = content;
                if let Some(idx) = s.as_str().and_then(string_to_index) {
                    // An index-valued string routes to the item; XS meters the
                    // `fxStringToIndex` success two extra code units.
                    self.meter.tick_code_n(2);
                    Some(Slot::of(Kind::At, Payload::At(crate::value::XS_NO_ID, idx)))
                } else {
                    let id = self.intern_key(&s)?;
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
        })
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
    pub(in crate::interp) fn index_read_key_id(&self, index: u32) -> Option<u16> {
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
    pub(in crate::interp) fn refresh_read_key(&self, key: ReadKey) -> ReadKey {
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
    pub(in crate::interp) fn read_key_is_index(&self, key: ReadKey) -> bool {
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
    pub(in crate::interp) fn read_key_intern(&mut self, key: ReadKey) -> Result<u16, Step> {
        Ok(match key {
            ReadKey::Id(id) => id,
            ReadKey::Index(index) => self.intern_key_unmetered(index.to_string())?,
        })
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
    pub(in crate::interp) fn to_read_key(
        &mut self,
        code: &[u8],
        key: Slot,
    ) -> Result<ReadKey, Step> {
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
                    Ok(ReadKey::Id(self.intern_symbol_key(descriptor)?))
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
        let id = self.intern_key(&name)?;
        self.install_pending_intrinsics();
        Ok(ReadKey::Id(id))
    }

    /// The key as the string/symbol slot a Proxy trap is handed. An `Index`
    /// spells its own canonical numeric string, exactly as XS's `fxKeyAt`
    /// does for `XS_NO_ID`, without interning it.
    pub(in crate::interp) fn read_key_slot(&mut self, key: ReadKey) -> Result<Slot, Step> {
        match key {
            ReadKey::Id(id) => self.property_key_slot(id),
            ReadKey::Index(index) => {
                let offset = self.alloc_str_text_metered(index.to_string().as_bytes())?;
                Ok(Slot::of(Kind::String, Payload::String(offset)))
            }
        }
    }

    /// `ToPropertyKey(argument)`: preserve a Symbol's identity; otherwise use
    /// the string-hint `ToPrimitive` path followed by metered `ToString`.
    /// Keeping the resulting string slot separate from interning lets callers
    /// apply receiver-specific checks (canonical numeric indices and the
    /// boot-default soundness gate) before the name enters `symbol_ids`.
    pub(in crate::interp) fn to_property_key(
        &mut self,
        code: &[u8],
        key: Slot,
    ) -> Result<Slot, Step> {
        if key.kind == Kind::Symbol {
            return Ok(key);
        }
        let primitive = self.to_primitive(code, key, true)?;
        if primitive.kind == Kind::Symbol {
            return Ok(primitive);
        }
        Ok(self.to_string_slot_metered(primitive))
    }

    pub(in crate::interp) fn to_property_id(
        &mut self,
        code: &[u8],
        key: Slot,
    ) -> Result<u16, Step> {
        if let Payload::At(id, index) = key.value {
            return Ok(if id == crate::value::XS_NO_ID {
                self.intern_key(index.to_string())?
            } else {
                id
            });
        }
        let property_key = self.to_property_key(code, key)?;
        if property_key.kind == Kind::Symbol {
            return match property_key.value {
                Payload::Reference(descriptor) => Ok(self.intern_symbol_key(descriptor)?),
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
        let id = self.intern_key(&name)?;
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

    pub(in crate::interp) fn property_key_slot(&mut self, id: u16) -> Result<Slot, Step> {
        if let Some(descriptor) = self.symbol_key_ids.descriptor(id) {
            return Ok(Slot::of(Kind::Symbol, Payload::Reference(descriptor)));
        }
        let name = self
            .symbol_names
            .get(usize::from(id).wrapping_sub(1))
            .filter(|name| self.symbol_ids.get(*name) == Some(&id))
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
        // Admission cannot change interned identities. Resolve the same
        // forward-table position again without allocating before admission.
        let units = self.symbol_names[usize::from(id) - 1].to_units();
        let offset = self.chunks.alloc(&units_to_be16(&units));
        Ok(Slot::of(Kind::String, Payload::String(offset)))
    }
}
