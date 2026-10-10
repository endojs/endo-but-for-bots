//! Property enumeration and prototype-chain method probes.
use super::*;

/// A for-in key that was gone when its turn came: never a key, since no
/// array index is `u32::MAX`.
pub(super) const FOR_IN_GONE: (u16, u32) = (crate::value::XS_NO_ID, u32::MAX);

impl Interp {
    /// Build a for-in enumerator over `obj` (XS's `fx_Enumerator`): record
    /// the receiver's own string keys as an enumerator [`IterState`] (kind 3)
    /// that [`Self::enumerator_next`] steps through, one prototype level at a
    /// time. Meters the creation cluster ([`FOR_IN_ENUMERATOR_METERING`]);
    /// each yielded key's string allocation is metered in `next()`.
    pub(super) fn make_enumerator(
        &mut self,
        code: &[u8],
        obj: crate::value::SlotIndex,
    ) -> Result<Slot, Step> {
        self.meter.tick_raw(if obj.is_null() {
            FOR_IN_NULLISH_ENUMERATOR_METERING
        } else {
            FOR_IN_ENUMERATOR_METERING
        });
        if self.arrays.contains_key(&obj) {
            self.meter.tick_raw(ARRAY_FOR_IN_EXTRA_METERING);
        }
        // A `NULL` object is `for (k in null)`: no keys, and done before the
        // first step. The record still names a real object, as every
        // persisted and traced iterator does.
        let (keys, iterable, done) = if obj.is_null() {
            (Vec::new(), self.object_proto, true)
        } else {
            (self.for_in_level_keys(code, obj)?, obj, false)
        };
        let result = self.new_reused_iterator_result();
        // XS steps a for-in through the private prototype of
        // `mxEnumeratorFunction`, which inherits `%IteratorPrototype%` and
        // owns the enumerator's `next`: a `return` there closes the loop on a
        // `break`, and one on `%ArrayIteratorPrototype%` does not.
        let iter = self.slots.alloc(Slot::instance(self.enumerator_proto));
        self.iterators.insert(
            iter,
            IterState {
                iterable,
                index: 0,
                kind: 3,
                generation: 0,
                result,
                done,
                enum_keys: std::rc::Rc::new(keys),
                str_bytes: std::rc::Rc::default(),
                enum_visited: Some(std::rc::Rc::default()),
            },
        );
        Ok(Slot::of(Kind::Reference, Payload::Reference(iter)))
    }

    /// One level's own string keys for for-in, as `(id, index)` pairs
    /// (`id == XS_NO_ID` ⇒ an array index): what XS's `fx_Enumerator` and
    /// `fx_Enumerator_prototype_next` collect with `mxBehaviorOwnKeys(…,
    /// XS_EACH_NAME_FLAG, …)`. Enumerable or not — a non-enumerable key is
    /// passed over at its turn but still hides the same key on a later
    /// level, and one made enumerable before its turn is yielded. A Proxy
    /// level runs its `ownKeys` trap.
    fn for_in_level_keys(
        &mut self,
        code: &[u8],
        level: crate::value::SlotIndex,
    ) -> Result<Vec<(u16, u32)>, Step> {
        if !self.proxies.contains_key(&level) {
            return Ok(self.own_enumeration_keys(level));
        }
        let mut keys = Vec::new();
        for key in self.proxy_own_keys(code, level)? {
            if key.kind == Kind::Symbol {
                continue;
            }
            keys.push(match self.to_read_key(code, key)? {
                ReadKey::Index(index) => (crate::value::XS_NO_ID, index),
                ReadKey::Id(id) => match self.key_id_index(id) {
                    Some(index) => (crate::value::XS_NO_ID, index),
                    None => (id, 0),
                },
            });
        }
        Ok(keys)
    }

    /// An ordinary object's own string keys in XS's own-key order: its
    /// array-index keys ascending, then its names — the ones an exotic
    /// object synthesizes (an Array's or String wrapper's `length`, a
    /// function's `length`, `name` and `prototype`) ahead of the stored ones
    /// in insertion order.
    pub(super) fn own_enumeration_keys(&self, cur: crate::value::SlotIndex) -> Vec<(u16, u32)> {
        // The array-index keys, whichever store holds them — the order
        // `fxOrdinaryOwnKeys` gives, since XS keeps every index key in the
        // one indexed chunk. Every one is recorded as `(XS_NO_ID, index)`,
        // including an index NAMED by a promoted accessor or an exotic
        // shape's expando, so a stored index and a named one are the single
        // property they are.
        let mut indices: Vec<u32> = Vec::new();
        // A String wrapper's units and a TypedArray's elements are own keys,
        // and XS queues them ahead of the named chain (`fxStringOwnKeys`,
        // `fxTypedArrayOwnKeys`).
        if let Some(Slot {
            kind: Kind::String,
            value: Payload::String(offset),
            ..
        }) = self.wrapper_data.get(&cur).copied()
        {
            indices.extend(0..self.str_len(offset) as u32);
        }
        if let Some(&ta) = self.typed_arrays.get(&cur) {
            let length = if self.detached_buffers.contains(&ta.buffer) {
                0
            } else {
                ta.length
            };
            indices.extend(0..length);
        }
        if let Some(props) = self.index_props.get(&cur) {
            indices.extend(props.items().keys().copied());
        }
        if let Some(a) = self.arrays.get(&cur) {
            indices.extend(a.items().keys().copied());
        }
        // Own string-named properties, in insertion order. The property list
        // is prepend-ordered (newest first), so collect and reverse. Symbol
        // keys are not for-in keys (EnumerateObjectProperties, and XS).
        let mut names: Vec<(u16, u32)> = Vec::new();
        let mut p = self.slots.get(cur).next;
        while !p.is_null() {
            let s = self.slots.get(p);
            if s.id != crate::value::XS_NO_ID && !self.is_symbol_key_id(s.id) {
                match self.key_id_index(s.id) {
                    Some(index) => indices.push(index),
                    None => names.push((s.id, 0)),
                }
            }
            p = s.next;
        }
        names.reverse();
        indices.sort_unstable();
        indices.dedup();
        let mut out: Vec<(u16, u32)> = indices
            .into_iter()
            .map(|index| (crate::value::XS_NO_ID, index))
            .collect();
        // A stored name can repeat only a synthesized one (at most three).
        let synthesized = self.synthesized_own_name_keys(cur);
        out.extend(synthesized.iter().copied());
        out.extend(names.into_iter().filter(|key| !synthesized.contains(key)));
        out
    }

    /// The non-enumerable own string keys `inst` synthesizes without a slot
    /// in its property chain, as `(id, 0)` enumeration keys. A name the table
    /// has never interned cannot name an inherited property either, so it is
    /// simply absent.
    fn synthesized_own_name_keys(&self, inst: crate::value::SlotIndex) -> Vec<(u16, u32)> {
        let id = |name: &str| self.symbol_ids.get(name).copied();
        let mut keys = Vec::new();
        let has_exotic_length = (self.arrays.contains_key(&inst)
            && !self.arguments_objects.contains(&inst))
            || matches!(
                self.wrapper_data.get(&inst),
                Some(Slot {
                    kind: Kind::String,
                    ..
                })
            );
        if has_exotic_length {
            keys.extend(id("length"));
        }
        if self.functions.contains_key(&inst) {
            for name in ["length", "name"] {
                if let Some(name_id) = id(name) {
                    if self.function_meta_own_descriptor(inst, name_id).is_some() {
                        keys.push(name_id);
                    }
                }
            }
            if self.ctor_prototype.contains_key(&inst) {
                keys.extend(id("prototype"));
            }
        }
        keys.into_iter().map(|id| (id, 0)).collect()
    }

    /// `fx_Enumerator_prototype_next` for a for-in enumerator: yield the next
    /// enumerable key as a string, mutating and returning the reused result
    /// object. Meters the per-`next()` base plus the yielded key's string
    /// allocation.
    ///
    /// As XS does, each key's own property is read on the level that listed
    /// it when its turn comes: a key that is gone is passed over and stays
    /// unvisited, one that is present is visited, and yielded if it is
    /// enumerable then. A level is listed only when the one before it is
    /// done, through the prototype it has at that moment. A key a nearer
    /// level visited is passed over, so a non-enumerable own property hides
    /// an inherited enumerable one of the same name.
    ///
    /// `enum_keys` holds the levels listed so far and `iterable` the level
    /// being stepped. A key that was gone at its turn becomes
    /// [`FOR_IN_GONE`], so the keys before the cursor that are not
    /// [`FOR_IN_GONE`] are exactly XS's visited list, which `enum_visited`
    /// holds as a set.
    pub(super) fn enumerator_next(
        &mut self,
        code: &[u8],
        iter: crate::value::SlotIndex,
    ) -> Result<Slot, Step> {
        let result = self.iterators[&iter].result;
        // Guest code can run below (a Proxy level's traps, which may step
        // this same enumerator), so after each trap the record is read again
        // and the step starts over if the cursor moved.
        let yielded = loop {
            let st = &self.iterators[&iter];
            if st.done {
                break None;
            }
            let (level, index) = (st.iterable, st.index as usize);
            if index >= st.enum_keys.len() {
                // The level is done: list the prototype it has now.
                let proto = if self.proxies.contains_key(&level) {
                    match self.mop_get_prototype(code, level)?.value {
                        Payload::Reference(proto) => proto,
                        _ => crate::value::SlotIndex::NULL,
                    }
                } else {
                    self.instance_prototype(level)
                };
                if !self.enumerator_at(iter, level, index) {
                    continue;
                }
                if proto.is_null() {
                    if let Some(s) = self.iterators.get_mut(&iter) {
                        s.done = true;
                    }
                    break None;
                }
                let mut keys = self.for_in_level_keys(code, proto)?;
                if !self.enumerator_at(iter, level, index) {
                    continue;
                }
                self.ensure_enumerator_visited(iter);
                let Some(s) = self.iterators.get_mut(&iter) else {
                    break None;
                };
                let visited = s.enum_visited.as_deref().expect("visited keys");
                if !self.proxies.contains_key(&proto) {
                    // An ordinary level's visited keys are passed over at
                    // their turn whatever they hold then, and reading them
                    // observes nothing, so they are dropped now.
                    keys.retain(|key| !visited.contains(key));
                }
                // Gone keys and a Proxy level's repeats only accumulate:
                // once they outgrow the visited keys, keep just those, first
                // occurrence first, so a Proxy cycle stays bounded.
                if s.enum_keys.len() > 2 * visited.len() + 16 {
                    let mut kept = std::collections::HashSet::new();
                    let compact: Vec<(u16, u32)> = s
                        .enum_keys
                        .iter()
                        .copied()
                        .filter(|&key| key != FOR_IN_GONE && kept.insert(key))
                        .collect();
                    s.index = compact.len() as u32;
                    s.enum_keys = std::rc::Rc::new(compact);
                }
                s.iterable = proto;
                std::rc::Rc::make_mut(&mut s.enum_keys).extend(keys);
                continue;
            }
            let key = st.enum_keys[index];
            // An index an accessor promoted, or an exotic shape's index
            // expando, lives in a named slot: refresh to its name when it has
            // one.
            let read_key = self.refresh_read_key(if key.0 == crate::value::XS_NO_ID {
                ReadKey::Index(key.1)
            } else {
                ReadKey::Id(key.0)
            });
            let descriptor = self.mop_get_own_property_read(code, level, read_key)?;
            if !self.enumerator_at(iter, level, index) {
                continue;
            }
            self.ensure_enumerator_visited(iter);
            let Some(s) = self.iterators.get_mut(&iter) else {
                break None;
            };
            s.index += 1;
            let Some(descriptor) = descriptor else {
                std::rc::Rc::make_mut(&mut s.enum_keys)[index] = FOR_IN_GONE;
                continue;
            };
            // A key a nearer level visited is passed over. Only a Proxy
            // level's keys can repeat one: an ordinary level dropped them when
            // it was listed, but a Proxy's `getOwnPropertyDescriptor` trap
            // runs first, as in XS.
            let visited = s.enum_visited.as_mut().expect("visited keys");
            if !std::rc::Rc::make_mut(visited).insert(key) {
                continue;
            }
            if descriptor.enumerable != Some(false) {
                break Some(key);
            }
        };
        let (new_value, new_done) = match yielded {
            None => (Slot::undefined(), true),
            Some((id, idx)) => {
                self.meter.tick_raw(ENUMERATOR_NEXT_METERING);
                // The key string: an array index renders as a fresh decimal
                // (`fxKeyAt` allocates it, metered per byte + NUL); a named
                // key reuses its interned symbol name (no run-time allocation
                // in XS, so ironhorse allocates the chunk it needs to produce
                // the value but does NOT meter it).
                let bytes: Vec<u8> = if id == crate::value::XS_NO_ID {
                    let b = number_to_ecma_string(idx as f64).into_bytes();
                    self.meter.tick_string(b.len() as u64);
                    b
                } else {
                    self.symbol_names
                        .get(id as usize - 1)
                        .cloned()
                        .unwrap_or_default()
                        .as_bytes()
                        .to_vec()
                };
                let off = self.chunks.alloc(&units_to_be16(&cesu8_to_units(&bytes)));
                (Slot::of(Kind::String, Payload::String(off)), false)
            }
        };
        let (vid, did) = self.iterator_result_ids();
        self.set_own_unmetered(result, vid, new_value);
        self.set_own_unmetered(result, did, Slot::boolean(new_done));
        Ok(Slot::of(Kind::Reference, Payload::Reference(result)))
    }

    /// Whether enumerator `iter` is still stepping `level` at `index`: guest
    /// code may have stepped or finished it meanwhile.
    fn enumerator_at(
        &self,
        iter: crate::value::SlotIndex,
        level: crate::value::SlotIndex,
        index: usize,
    ) -> bool {
        self.iterators
            .get(&iter)
            .is_some_and(|s| !s.done && s.iterable == level && s.index as usize == index)
    }

    /// Rebuild an enumerator's visited set after a restore: the keys before
    /// its cursor that were present at their turn.
    fn ensure_enumerator_visited(&mut self, iter: crate::value::SlotIndex) {
        let Some(s) = self.iterators.get_mut(&iter) else {
            return;
        };
        if s.enum_visited.is_none() {
            let visited = s.enum_keys[..s.index as usize]
                .iter()
                .copied()
                .filter(|&key| key != FOR_IN_GONE)
                .collect();
            s.enum_visited = Some(std::rc::Rc::new(visited));
        }
    }

    /// Whether an ordinary prototype walk reaches exactly the expected native
    /// data method before any Proxy or other property. This is the conservative
    /// gate for fast paths that would otherwise bypass an observable `Get`.
    pub(super) fn chain_resolves_native_data_method(
        &self,
        inst: crate::value::SlotIndex,
        id: u16,
        expected: NativeMethod,
    ) -> bool {
        let mut current = inst;
        while !current.is_null() {
            if self.proxies.contains_key(&current) {
                return false;
            }
            if let Some(property) = self.find_property(current, id) {
                return match self.slots.get(property).value {
                    Payload::Reference(function) => self.method_of(function) == Some(expected),
                    _ => false,
                };
            }
            current = self.instance_prototype(current);
        }
        false
    }
}
