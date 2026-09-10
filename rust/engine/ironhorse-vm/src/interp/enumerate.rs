//! Property enumeration and prototype-chain method probes.
use super::*;

impl Interp {
    /// Build a for-in enumerator over `obj` (XS's `fx_Enumerator`): collect the
    /// object's enumerable own-then-inherited string keys in XS enumeration
    /// order (integer indices ascending, then string keys in insertion order,
    /// per prototype level, skipping shadowed keys), and record them as an
    /// enumerator [`IterState`] (kind 3) whose `next()` yields each as a
    /// string. Meters the creation cluster ([`FOR_IN_ENUMERATOR_METERING`]);
    /// each yielded key's string allocation is metered in `next()`.
    pub(super) fn make_enumerator(&mut self, obj: crate::value::SlotIndex) -> Slot {
        self.meter.tick_raw(FOR_IN_ENUMERATOR_METERING);
        if self.arrays.contains_key(&obj) {
            self.meter.tick_raw(ARRAY_FOR_IN_EXTRA_METERING);
        }
        let keys = self.enumerable_keys(obj);
        let result = self.slots.alloc(Slot::instance(self.object_proto));
        if let Some(vid) = self.value_id {
            self.set_own_unmetered(result, vid, Slot::undefined());
        }
        if let Some(did) = self.done_id {
            self.set_own_unmetered(result, did, Slot::boolean(false));
        }
        let iter = self.slots.alloc(Slot::instance(self.array_iterator_proto));
        self.iterators.insert(
            iter,
            IterState {
                iterable: obj,
                index: 0,
                kind: 3,
                generation: 0,
                result,
                done: false,
                enum_keys: std::rc::Rc::new(keys),
                str_bytes: std::rc::Rc::default(),
            },
        );
        Slot::of(Kind::Reference, Payload::Reference(iter))
    }

    /// The enumerable own-then-inherited string keys of `obj` in XS for-in
    /// order, as `(id, index)` pairs (`id == XS_NO_ID` ⇒ an array index). For
    /// an array: the present item indices ascending. For an ordinary object:
    /// its own string-named properties in insertion order. The prototype chain
    /// is walked (skipping already-seen keys), but the covered grammar's
    /// prototypes (`%Object.prototype%` / `%Array.prototype%`) carry no
    /// enumerable data properties, so only own keys appear.
    pub(super) fn enumerable_keys(&self, obj: crate::value::SlotIndex) -> Vec<(u16, u32)> {
        let mut out: Vec<(u16, u32)> = Vec::new();
        let mut seen: std::collections::HashSet<(u16, u32)> = std::collections::HashSet::new();
        let mut cur = obj;
        while !cur.is_null() {
            // A String wrapper's units and a TypedArray's elements are
            // enumerable own keys, and XS queues them ahead of the named chain
            // (`fxStringOwnKeys`, `fxTypedArrayOwnKeys`). Neither had an arm
            // here, so `for (k in new String('ab'))` and `for (k in new
            // Uint8Array(2))` yielded nothing at all — while `Object.keys` on
            // the same receiver answered correctly, which is the same one
            // property, two answers split that the index-read work has been
            // closing everywhere else.
            if let Some(Slot {
                kind: Kind::String,
                value: Payload::String(offset),
                ..
            }) = self.wrapper_data.get(&cur).copied()
            {
                for index in 0..self.str_len(offset) as u32 {
                    let k = (crate::value::XS_NO_ID, index);
                    if seen.insert(k) {
                        out.push(k);
                    }
                }
            }
            if let Some(&ta) = self.typed_arrays.get(&cur) {
                let length = if self.detached_buffers.contains(&ta.buffer) {
                    0
                } else {
                    ta.length
                };
                for index in 0..length {
                    let k = (crate::value::XS_NO_ID, index);
                    if seen.insert(k) {
                        out.push(k);
                    }
                }
            }
            // An ordinary object's index properties, ascending, ahead of its
            // named chain — the enumeration order `fxOrdinaryOwnKeys` gives.
            if let Some(props) = self.index_props.get(&cur) {
                for (&index, item) in props.items() {
                    if item.flag & XS_DONT_ENUM_FLAG != 0 {
                        continue;
                    }
                    let k = (crate::value::XS_NO_ID, index);
                    if seen.insert(k) {
                        out.push(k);
                    }
                }
            }
            // Array index keys first (ascending), then string keys.
            if let Some(a) = self.arrays.get(&cur) {
                // A non-enumerable ITEM is skipped, exactly as the
                // non-enumerable named property below is. Items could not
                // carry `XS_DONT_ENUM_FLAG` in practice while
                // `array_define_index` promoted an attributed element out of
                // the map, so the filter was never needed here; now that such
                // an element stays an item, `for-in` over
                // `Object.defineProperty(a, '1', {enumerable: false})` would
                // otherwise yield the key that `Object.keys` correctly omits.
                let mut idxs: Vec<u32> = a
                    .items()
                    .iter()
                    .filter(|(_, item)| item.flag & XS_DONT_ENUM_FLAG == 0)
                    .map(|(index, _)| *index)
                    .collect();
                idxs.sort_unstable();
                for i in idxs {
                    let k = (crate::value::XS_NO_ID, i);
                    if seen.insert(k) {
                        out.push(k);
                    }
                }
            }
            // Own string-named properties, in insertion order. The property
            // list is prepend-ordered (newest first), so collect and reverse.
            let mut names: Vec<(u16, u32)> = Vec::new();
            let mut p = self.slots.get(cur).next;
            while !p.is_null() {
                let s = self.slots.get(p);
                // Symbol-keyed properties are excluded from for-in per
                // EnumerateObjectProperties (and XS agrees); before this
                // filter a symbol-keyed enumerable own property yielded a
                // phantom "" key (the unmapped id rendered empty).
                if s.id != crate::value::XS_NO_ID
                    && s.flag & XS_DONT_ENUM_FLAG == 0
                    && !self.is_symbol_key_id(s.id)
                {
                    names.push((s.id, 0));
                }
                p = s.next;
            }
            names.reverse();
            for k in names {
                if seen.insert(k) {
                    out.push(k);
                }
            }
            cur = self.instance_prototype(cur);
        }
        out
    }

    /// `fx_Enumerator_prototype_next` for a for-in enumerator: yield the next
    /// enumerable key as a string, mutating and returning the reused result
    /// object. Meters the per-`next()` base plus the yielded key's string
    /// allocation.
    pub(super) fn enumerator_next(&mut self, iter: crate::value::SlotIndex) -> Slot {
        let st = self.iterators[&iter].clone();
        let result = st.result;
        let (new_value, new_done, next_index): (Slot, bool, u32) =
            if st.done || (st.index as usize) >= st.enum_keys.len() {
                (Slot::undefined(), true, st.index)
            } else {
                self.meter.tick_raw(ENUMERATOR_NEXT_METERING);
                let (id, idx) = st.enum_keys[st.index as usize];
                // The key string: an array index renders as a fresh decimal
                // (`fxKeyAt` allocates it, metered per byte + NUL); a named key
                // reuses its interned symbol name (no run-time allocation in
                // XS, so ironhorse allocates the chunk it needs to produce the
                // value but does NOT meter it).
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
                (
                    Slot::of(Kind::String, Payload::String(off)),
                    false,
                    st.index + 1,
                )
            };
        if let Some(s) = self.iterators.get_mut(&iter) {
            s.index = next_index;
            s.done = new_done;
        }
        if let Some(vid) = self.value_id {
            self.set_own_unmetered(result, vid, Slot::of(new_value.kind, new_value.value));
        }
        if let Some(did) = self.done_id {
            self.set_own_unmetered(result, did, Slot::boolean(new_done));
        }
        Slot::of(Kind::Reference, Payload::Reference(result))
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
