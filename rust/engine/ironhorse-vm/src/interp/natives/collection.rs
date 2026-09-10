//! VM-facing collection builtin algorithms.
use super::super::*;

impl Interp {
    /// Dispatch a Map/Set/WeakMap/WeakSet mutator or query method (xsMapSet.c).
    /// The receiver `this` names the collection; argument 0 is the key/value
    /// (`stack[base + 4]`), argument 1 the value for `Map.set`
    /// (`stack[base + 5]`). Metering is purely allocation-driven — xsMapSet.c
    /// calls no `mxMeter` — so a new entry charges its `fxNewSlot`s (and, for a
    /// Map/Set, any `fxResizeEntries` rehash chunk) while a query or an
    /// in-place update is allocation-free; each carries only the calibrated
    /// native-frame residual. Wrong receiver brands and invalid weak keys
    /// produce real catchable TypeErrors with the corresponding XS diagnostic.
    pub(in crate::interp) fn collection_brand_error(
        &mut self,
        kind: CollKind,
        readonly: bool,
    ) -> Step {
        let name = match kind {
            CollKind::Map => "Map",
            CollKind::Set => "Set",
            CollKind::WeakMap => "WeakMap",
            CollKind::WeakSet => "WeakSet",
        };
        let state = if readonly { "read-only" } else { "not a" };
        self.catchable_type_error_msg(format!("this: {state} {name} instance"))
    }

    pub(in crate::interp) fn call_collection(
        &mut self,
        m: NativeMethod,
        this: Slot,
        base: usize,
        argc: usize,
    ) -> Result<Slot, Step> {
        let _ = argc;
        let arg0 = self
            .stack
            .get(base + 4)
            .copied()
            .unwrap_or_else(Slot::undefined);
        let expected_kind = match m {
            NativeMethod::MapSet
            | NativeMethod::MapGet
            | NativeMethod::MapHas
            | NativeMethod::MapDelete => CollKind::Map,
            NativeMethod::WeakMapSet
            | NativeMethod::WeakMapGet
            | NativeMethod::WeakMapHas
            | NativeMethod::WeakMapDelete => CollKind::WeakMap,
            NativeMethod::SetAdd | NativeMethod::SetHas | NativeMethod::SetDelete => CollKind::Set,
            NativeMethod::WeakSetAdd | NativeMethod::WeakSetHas | NativeMethod::WeakSetDelete => {
                CollKind::WeakSet
            }
            _ => {
                return Err(Step::Host(Halt::EngineInvariant(
                    "collection:unexpected-method",
                )))
            }
        };
        let inst = match self.collection_ref(this) {
            Some(i) => i,
            None => return Err(self.collection_brand_error(expected_kind, false)),
        };
        let kind = self.collections[&inst].kind;
        if kind != expected_kind {
            return Err(self.collection_brand_error(expected_kind, false));
        }
        if matches!(
            m,
            NativeMethod::MapSet
                | NativeMethod::WeakMapSet
                | NativeMethod::SetAdd
                | NativeMethod::WeakSetAdd
                | NativeMethod::MapDelete
                | NativeMethod::WeakMapDelete
                | NativeMethod::SetDelete
                | NativeMethod::WeakSetDelete
        ) && self.slots.get(inst).flag & XS_DONT_MODIFY_FLAG != 0
        {
            return Err(self.collection_brand_error(expected_kind, true));
        }
        let weak = matches!(kind, CollKind::WeakMap | CollKind::WeakSet);
        match m {
            NativeMethod::MapSet | NativeMethod::WeakMapSet => {
                let val = self
                    .stack
                    .get(base + 5)
                    .copied()
                    .unwrap_or_else(Slot::undefined);
                let key = self.normalize_coll_key(arg0);
                if weak && key.kind != Kind::Reference {
                    return Err(self.catchable_type_error_msg("key: not an object".into()));
                }
                match self.collection_find(inst, &key) {
                    Some(p) => {
                        self.collections.get_mut(&inst).unwrap().set_entry_value(
                            p,
                            val,
                            &mut self.side_refs,
                        );
                    }
                    None => {
                        // `fxSetEntry`/`fxSetWeakEntry` new key: three slots
                        // (Map: key + value + entry; WeakMap: keyEntry +
                        // listEntry + closure).
                        self.charge_new_entry_slots(3);
                        self.collections.get_mut(&inst).unwrap().push_entry(
                            key,
                            val,
                            &mut self.side_refs,
                        );
                        self.collection_table_resize(inst);
                    }
                }
                Ok(this)
            }
            NativeMethod::SetAdd | NativeMethod::WeakSetAdd => {
                let key = self.normalize_coll_key(arg0);
                if weak && key.kind != Kind::Reference {
                    return Err(self.catchable_type_error_msg("value: not an object".into()));
                }
                if self.collection_find(inst, &key).is_none() {
                    // `fxSetEntry` with no pair → two slots (value + entry);
                    // `fxSetWeakEntry` → three (keyEntry + listEntry + closure).
                    let n = if weak { 3 } else { 2 };
                    self.charge_new_entry_slots(n);
                    self.collections.get_mut(&inst).unwrap().push_entry(
                        key,
                        Slot::undefined(),
                        &mut self.side_refs,
                    );
                    self.collection_table_resize(inst);
                }
                Ok(this)
            }
            NativeMethod::MapGet | NativeMethod::WeakMapGet => {
                let key = self.normalize_coll_key(arg0);
                let v = self
                    .collection_find(inst, &key)
                    .map(|p| self.collections[&inst].entries()[p].unwrap().1)
                    .unwrap_or_else(Slot::undefined);
                Ok(v)
            }
            NativeMethod::MapHas | NativeMethod::WeakMapHas => {
                let key = self.normalize_coll_key(arg0);
                Ok(Slot::boolean(self.collection_find(inst, &key).is_some()))
            }
            NativeMethod::SetHas | NativeMethod::WeakSetHas => {
                let key = self.normalize_coll_key(arg0);
                Ok(Slot::boolean(self.collection_find(inst, &key).is_some()))
            }
            NativeMethod::MapDelete
            | NativeMethod::WeakMapDelete
            | NativeMethod::SetDelete
            | NativeMethod::WeakSetDelete => {
                let key = self.normalize_coll_key(arg0);
                match self.collection_find(inst, &key) {
                    Some(p) => {
                        self.collections
                            .get_mut(&inst)
                            .unwrap()
                            .remove_entry(p, &mut self.side_refs);
                        // `fxDeleteEntry` calls `fxResizeEntries` (a Map/Set may
                        // shrink its address chunk; a weak unlink is
                        // allocation-free).
                        self.collection_table_resize(inst);
                        Ok(Slot::boolean(true))
                    }
                    None => Ok(Slot::boolean(false)),
                }
            }
            _ => Err(Step::Host(Halt::EngineInvariant(
                "collection:unexpected-method",
            ))),
        }
    }

    /// Populate a freshly-created collection through the calibrated dense
    /// Array fast path when no observable iterator operation is bypassed.
    /// Every other input routes to [`Self::populate_collection_from_iterable`].
    pub(in crate::interp) fn populate_collection_from_dense_array(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        iterable: Slot,
    ) -> Result<(), Step> {
        let array = match iterable.value {
            Payload::Reference(array) if self.arrays.contains_key(&array) => array,
            _ => return self.populate_collection_from_iterable(code, inst, iterable),
        };
        let iterator_id = self
            .well_known_symbol_property_id("iterator")
            .expect("well-known iterator symbol");
        let kind = self.collections[&inst].kind;
        let next_id = self.intern_static_key("next");
        let return_id = self.intern_static_key("return");
        if !self.chain_resolves_native_data_method(array, iterator_id, NativeMethod::ArrayValues)
            || !self.chain_resolves_native_data_method(
                self.array_iterator_proto,
                next_id,
                NativeMethod::ArrayIteratorNext,
            )
            || self.chain_has_descriptor(self.array_iterator_proto, return_id)
        {
            return self.populate_collection_from_iterable(code, inst, iterable);
        }
        let method_name = if matches!(kind, CollKind::Map | CollKind::WeakMap) {
            "set"
        } else {
            "add"
        };
        let method_id = self.intern_static_key(method_name);
        let receiver = Slot::of(Kind::Reference, Payload::Reference(inst));
        let expected = match kind {
            CollKind::Map => NativeMethod::MapSet,
            CollKind::Set => NativeMethod::SetAdd,
            CollKind::WeakMap => NativeMethod::WeakMapSet,
            CollKind::WeakSet => NativeMethod::WeakSetAdd,
        };
        let mut adder = self.ordinary_get(code, inst, method_id, receiver)?;
        // Intrinsics are linked sparsely by program atom. The constructor's
        // implicit Get(adder) still sees the boot method when source never
        // spells its name, so recover that already-allocated method identity.
        //
        // The gate is genuine property ABSENCE, not `method_was_linked`: a prior
        // collection constructed in the same program `intern_key`s the adder
        // name (below), so by the second `new Set([...])` the name is in
        // `symbol_ids` yet the `add` property is still unbound on the prototype
        // (binding happens once at link time). Keying recovery on the interned
        // name therefore mis-fired for every collection past the first, throwing
        // a spurious TypeError. Recover when the adder resolved to `undefined`
        // AND no `add`/`set` descriptor exists anywhere on the receiver's chain
        // (a truly unbound intrinsic); a user who cleared `add` to `undefined`
        // leaves a descriptor, so that case still throws per specification.
        if adder.kind == Kind::Undefined && !self.chain_has_descriptor(inst, method_id) {
            if let Some((&function, _)) = self
                .functions
                .iter()
                .find(|(_, info)| info.method == Some(expected))
            {
                adder = Slot::of(Kind::Reference, Payload::Reference(function));
            }
        }
        if !self.is_callable_value(adder) {
            return Err(
                self.catchable_type_error_msg(format!("result.{method_name}: not a function"))
            );
        }
        let intrinsic_adder = match adder.value {
            Payload::Reference(function) => self.method_of(function) == Some(expected),
            _ => false,
        };
        if !intrinsic_adder {
            return self.populate_collection_from_iterable_with_adder(
                code,
                inst,
                iterable,
                Some(adder),
            );
        }
        let (dense, entries_are_dense_pairs) = {
            let data = &self.arrays[&array];
            let dense = data.items().len() == data.length as usize;
            let entries_are_dense_pairs = !matches!(kind, CollKind::Map | CollKind::WeakMap)
                || data.items().values().all(|element| {
                    matches!(element, Slot {
                        kind: Kind::Reference,
                        value: Payload::Reference(entry),
                        ..
                    }
                        if self.arrays.get(&entry).is_some_and(|entry_data| {
                            entry_data.length >= 2
                                && entry_data.items().contains_key(&0)
                                && entry_data.items().contains_key(&1)
                        }))
                });
            (dense, entries_are_dense_pairs)
        };
        if !dense || !entries_are_dense_pairs {
            return self.populate_collection_from_iterable_with_adder(
                code,
                inst,
                iterable,
                Some(adder),
            );
        }
        // Snapshotting is safe only after the observable adder lookup proved
        // that it resolves to the intrinsic. A custom getter or adder can
        // mutate the iterable and must take the live iterator path above.
        let data = &self.arrays[&array];
        let elements: Vec<Slot> = (0..data.length).map(|index| data.items()[&index]).collect();
        for element in elements {
            let (key, value) = if matches!(kind, CollKind::Map | CollKind::WeakMap) {
                let entry = match element.value {
                    Payload::Reference(entry) => entry,
                    _ => unreachable!("dense Map entries were checked before iteration"),
                };
                let entry_data = &self.arrays[&entry];
                (entry_data.items()[&0], entry_data.items()[&1])
            } else {
                (element, Slot::undefined())
            };
            let key = self.normalize_coll_key(key);
            if matches!(kind, CollKind::WeakMap | CollKind::WeakSet) && key.kind != Kind::Reference
            {
                if key.kind == Kind::Symbol {
                    return Err(Step::Host(Halt::Refused(
                        "collection-constructor:weak-symbol-oracle-version",
                    )));
                }
                return Err(self.catchable_type_error_msg(
                    if kind == CollKind::WeakMap {
                        "key: not an object"
                    } else {
                        "value: not an object"
                    }
                    .into(),
                ));
            }
            if let Some(position) = self.collection_find(inst, &key) {
                if matches!(kind, CollKind::Map | CollKind::WeakMap) {
                    self.collections.get_mut(&inst).unwrap().set_entry_value(
                        position,
                        value,
                        &mut self.side_refs,
                    );
                }
            } else {
                let slots = match kind {
                    CollKind::Map | CollKind::WeakMap | CollKind::WeakSet => 3,
                    CollKind::Set => 2,
                };
                self.charge_new_entry_slots(slots);
                self.collections.get_mut(&inst).unwrap().push_entry(
                    key,
                    value,
                    &mut self.side_refs,
                );
                self.collection_table_resize(inst);
            }
        }
        Ok(())
    }

    /// `AddEntriesFromIterable` for Map/WeakMap and the corresponding Set/
    /// WeakSet constructor loop. The adder is read before the iterator method;
    /// iterator advancement failures propagate directly, while every abrupt
    /// completion after a value is yielded closes the iterator.
    fn populate_collection_from_iterable(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        iterable: Slot,
    ) -> Result<(), Step> {
        self.populate_collection_from_iterable_with_adder(code, inst, iterable, None)
    }

    fn populate_collection_from_iterable_with_adder(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        iterable: Slot,
        adder: Option<Slot>,
    ) -> Result<(), Step> {
        let outcome = self.run_guest_under_native_try(CallerHandlers::Isolate, |machine| {
            machine.populate_collection_from_iterable_inner(code, inst, iterable, adder)
        });
        match outcome {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => Err(self.raise_js(error)),
            Err(halt) => Err(halt),
        }
    }

    fn populate_collection_from_iterable_inner(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        iterable: Slot,
        prefetched_adder: Option<Slot>,
    ) -> Result<Result<(), Slot>, Step> {
        let kind = self.collections[&inst].kind;
        let is_map = matches!(kind, CollKind::Map | CollKind::WeakMap);
        let method_name = if is_map { "set" } else { "add" };
        let expected = match kind {
            CollKind::Map => NativeMethod::MapSet,
            CollKind::Set => NativeMethod::SetAdd,
            CollKind::WeakMap => NativeMethod::WeakMapSet,
            CollKind::WeakSet => NativeMethod::WeakSetAdd,
        };
        let method_id = self.intern_static_key(method_name);
        let receiver = Slot::of(Kind::Reference, Payload::Reference(inst));
        let mut adder = match prefetched_adder {
            Some(adder) => adder,
            None => match self
                .array_from_try(|this| this.ordinary_get(code, inst, method_id, receiver))?
            {
                Ok(adder) => adder,
                Err(error) => return Ok(Err(error)),
            },
        };
        // Sparse intrinsic installation means an implicitly used `add`/`set`
        // can be absent from the prototype until this constructor reaches it.
        // Recover only genuine absence; an explicit guest `undefined` remains
        // observable and fails the callable check.
        if adder.kind == Kind::Undefined && !self.chain_has_descriptor(inst, method_id) {
            if let Some((&function, _)) = self
                .functions
                .iter()
                .find(|(_, info)| info.method == Some(expected))
            {
                adder = Slot::of(Kind::Reference, Payload::Reference(function));
            }
        }
        if !self.is_callable_value(adder) {
            return Ok(Err(self.internal_error(
                "TypeError",
                format!("result.{method_name}: not a function"),
            )));
        }

        let iterator_id = self
            .well_known_symbol_property_id("iterator")
            .expect("well-known iterator symbol");
        let iterator_method = match iterable.value {
            Payload::Reference(object) if iterable.kind == Kind::Reference => {
                match self
                    .array_from_try(|this| this.mop_get(code, object, iterator_id, iterable))?
                {
                    Ok(method) => method,
                    Err(error) => return Ok(Err(error)),
                }
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
                        .and_then(|&constructor| self.ctor_prototype.get(&constructor).copied())
                        .unwrap_or(crate::value::SlotIndex::NULL),
                    _ => crate::value::SlotIndex::NULL,
                };
                if proto.is_null() {
                    Slot::undefined()
                } else {
                    match self
                        .array_from_try(|this| this.mop_get(code, proto, iterator_id, iterable))?
                    {
                        Ok(method) => method,
                        Err(error) => return Ok(Err(error)),
                    }
                }
            }
        };
        if !self.is_callable_value(iterator_method) {
            return Ok(Err(
                self.internal_error("TypeError", "call: not a function".into())
            ));
        }
        let iterator = match self
            .array_from_try(|this| this.call_any(code, iterator_method, iterable, &[]))?
        {
            Ok(iterator) => iterator,
            Err(error) => return Ok(Err(error)),
        };
        let iterator_inst = match iterator.value {
            Payload::Reference(iterator_inst) if iterator.kind == Kind::Reference => iterator_inst,
            _ => {
                return Ok(Err(
                    self.internal_error("TypeError", "iterator: not an object".into())
                ))
            }
        };
        let next_id = self.intern_static_key("next");
        let next = match self
            .array_from_try(|this| this.mop_get(code, iterator_inst, next_id, iterator))?
        {
            Ok(next) if self.is_callable_value(next) => next,
            Ok(_) => {
                return Ok(Err(
                    self.internal_error("TypeError", "call: not a function".into())
                ))
            }
            Err(error) => return Ok(Err(error)),
        };
        let done_id = self.intern_static_key("done");
        let value_id = self.intern_static_key("value");

        for _ in 0..1_000_000u64 {
            let step = match self.array_from_try(|this| this.call_any(code, next, iterator, &[]))? {
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
                return Ok(Ok(()));
            }
            let element =
                match self.array_from_try(|this| this.mop_get(code, step_inst, value_id, step))? {
                    Ok(element) => element,
                    Err(error) => return Ok(Err(error)),
                };
            let args = if is_map {
                let entry = match element.value {
                    Payload::Reference(entry) if element.kind == Kind::Reference => entry,
                    _ => {
                        let error = self.internal_error("TypeError", "item: not an object".into());
                        return Ok(Err(self.array_from_close(code, iterator, error)?));
                    }
                };
                let key_id = self.intern_static_key("0");
                let key =
                    match self.array_from_try(|this| this.mop_get(code, entry, key_id, element))? {
                        Ok(key) => key,
                        Err(error) => {
                            return Ok(Err(self.array_from_close(code, iterator, error)?));
                        }
                    };
                let value_id = self.intern_static_key("1");
                let value = match self
                    .array_from_try(|this| this.mop_get(code, entry, value_id, element))?
                {
                    Ok(value) => value,
                    Err(error) => {
                        return Ok(Err(self.array_from_close(code, iterator, error)?));
                    }
                };
                vec![key, value]
            } else {
                vec![element]
            };
            match self.array_from_try(|this| this.call_any(code, adder, receiver, &args))? {
                Ok(_) => {}
                Err(error) => {
                    return Ok(Err(self.array_from_close(code, iterator, error)?));
                }
            }
        }
        Err(Step::Host(Halt::StepLimit(self.n_dispatched)))
    }

    /// Build a String Iterator over the UTF-16BE `bytes` (`fx_String_prototype_
    /// iterator` → `fxNewIteratorInstance`): allocate the iterator instance and
    /// its reused `{value, done}` result, recording a kind-4 [`IterState`] whose
    /// `index` is a BYTE offset into `bytes`. Meters the creation cluster
    /// ([`STRING_ITERATOR_CREATE_METERING`]). The iterator chains to
    /// `%Array Iterator.prototype%` in ironhorse's model (its `next` dispatches to
    /// the same [`NativeMethod::ArrayIteratorNext`], which branches on kind).
    pub(in crate::interp) fn make_string_iterator(&mut self, bytes: Vec<u8>) -> Slot {
        self.meter.tick_raw(STRING_ITERATOR_CREATE_METERING);
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
                iterable: crate::value::SlotIndex::NULL,
                index: 0,
                kind: 4,
                generation: 0,
                result,
                done: false,
                enum_keys: std::rc::Rc::default(),
                str_bytes: std::rc::Rc::new(bytes),
            },
        );
        Slot::of(Kind::Reference, Payload::Reference(iter))
    }

    /// Build a Map/Set Iterator over the collection `inst`
    /// (`fxNewMapIteratorInstance`/`fxNewSetIteratorInstance` → the shared
    /// `fxNewIteratorInstance`): allocate the iterator instance and its reused
    /// `{value, done}` result, recording an [`IterState`] whose `iterable` is
    /// the collection slot and `index` cursors its live entry list. `kind` is
    /// 5 = keys, 6 = values, 7 = entries. The iterator chains to
    /// `%Array Iterator.prototype%` in ironhorse's model (its `next` dispatches to
    /// the same [`NativeMethod::ArrayIteratorNext`], which branches on kind to
    /// [`Self::collection_iterator_next`]). Meters the creation cluster
    /// ([`COLLECTION_ITERATOR_CREATE_METERING`]).
    pub(in crate::interp) fn make_collection_iterator(
        &mut self,
        inst: crate::value::SlotIndex,
        kind: u8,
    ) -> Slot {
        self.meter.tick_raw(COLLECTION_ITERATOR_CREATE_METERING);
        let coll_generation = self.collections.get(&inst).map_or(0, |c| c.generation());
        let result = self.slots.alloc(Slot::instance(self.object_proto));
        if let Some(vid) = self.value_id {
            self.set_own_unmetered(result, vid, Slot::undefined());
        }
        if let Some(did) = self.done_id {
            self.set_own_unmetered(result, did, Slot::boolean(false));
        }
        let proto = match self.collections.get(&inst).map(|c| c.kind) {
            Some(CollKind::Map) => self.map_iterator_proto,
            Some(CollKind::Set) => self.set_iterator_proto,
            _ => self.array_iterator_proto,
        };
        let iter = self.slots.alloc(Slot::instance(proto));
        self.iterators.insert(
            iter,
            IterState {
                iterable: inst,
                index: 0,
                kind,
                generation: coll_generation,
                result,
                done: false,
                enum_keys: std::rc::Rc::default(),
                str_bytes: std::rc::Rc::default(),
            },
        );
        Slot::of(Kind::Reference, Payload::Reference(iter))
    }

    /// `Iterator.from(value)`: acquire `value`'s iterator record once, return
    /// an existing `%Iterator%` instance unchanged, or wrap a generic direct
    /// iterator in `%WrapForValidIteratorPrototype%`. The wrapper's kind-8
    /// [`IterState`] uses `iterable` for `[[Iterated]]` and `result` for an
    /// arena holder containing the cached (not necessarily callable) `next`
    /// value. Keeping the holder in the arena lets the existing ITER snapshot
    /// row and GC edge machinery carry the otherwise arbitrary [`Slot`].
    pub(in crate::interp) fn iterator_from(
        &mut self,
        code: &[u8],
        value: Slot,
    ) -> Result<Slot, Step> {
        if value.kind != Kind::String && value.kind != Kind::Reference {
            return Err(self.catchable_type_error_msg("iterator: not a string".into()));
        }

        let iterator_id = self
            .well_known_symbol_property_id("iterator")
            .expect("well-known iterator symbol");
        let iterator_method = match value.value {
            Payload::Reference(inst) if value.kind == Kind::Reference => {
                self.mop_get(code, inst, iterator_id, value)?
            }
            Payload::String(_) if value.kind == Kind::String => {
                self.mop_get(code, self.string_proto, iterator_id, value)?
            }
            _ => unreachable!("Iterator.from accepted only objects and strings"),
        };
        let iterator = if matches!(iterator_method.kind, Kind::Undefined | Kind::Null) {
            value
        } else {
            if !self.is_callable_value(iterator_method) {
                return Err(self.catchable_type_error_msg("call: not a function".into()));
            }
            let iterator = self.call_any(code, iterator_method, value, &[])?;
            if iterator.kind != Kind::Reference {
                return Err(self.catchable_type_error_msg("iterator: not an object".into()));
            }
            iterator
        };
        let Payload::Reference(iterator_inst) = iterator.value else {
            return Err(self.catchable_type_error_msg("iterator: not an object".into()));
        };
        let next_id = self.intern_static_key("next");
        let next_method = self.mop_get(code, iterator_inst, next_id, iterator)?;

        let iterator_ctor =
            self.intrinsics
                .get("Iterator")
                .copied()
                .ok_or(Step::Host(Halt::EngineInvariant(
                    "Iterator:missing-constructor",
                )))?;
        let iterator_ctor = Slot::of(Kind::Reference, Payload::Reference(iterator_ctor));
        if self.ordinary_has_instance(code, iterator_ctor, iterator)? {
            return Ok(iterator);
        }

        self.meter.tick_builtin();
        self.meter.tick_slot_alloc();
        let next_holder = self
            .slots
            .alloc(Slot::of(next_method.kind, next_method.value));
        self.meter.tick_slot_alloc();
        let wrapper = self
            .slots
            .alloc(Slot::instance(self.iterator_wrapper_proto));
        self.iterators.insert(
            wrapper,
            IterState {
                iterable: iterator_inst,
                index: 0,
                kind: 8,
                generation: 0,
                result: next_holder,
                done: false,
                enum_keys: std::rc::Rc::default(),
                str_bytes: std::rc::Rc::default(),
            },
        );
        Ok(Slot::of(Kind::Reference, Payload::Reference(wrapper)))
    }

    /// `%WrapForValidIteratorPrototype%.next()`. The cached method is read
    /// from the wrapper's arena holder and called with the original iterator.
    /// The result is returned unchanged; iterator consumers perform the
    /// protocol's object-result validation when they advance it.
    pub(in crate::interp) fn iterator_wrapper_next(
        &mut self,
        code: &[u8],
        this: Slot,
    ) -> Result<Slot, Step> {
        let Payload::Reference(wrapper) = this.value else {
            return Err(self.catchable_type_error_msg("this: not an iterator".into()));
        };
        let Some(state) = self
            .iterators
            .get(&wrapper)
            .filter(|state| state.kind == 8)
            .cloned()
        else {
            return Err(self.catchable_type_error_msg("this: not an iterator".into()));
        };
        let next_method = self.slots.get(state.result);
        let iterator = Slot::of(Kind::Reference, Payload::Reference(state.iterable));
        self.call_any(code, next_method, iterator, &[])
    }

    /// `%WrapForValidIteratorPrototype%.return()`. The underlying `return`
    /// method is intentionally fetched on each call; unlike `next`, it is not
    /// part of the captured iterator record. An absent method produces a fresh
    /// ordinary `{ value: undefined, done: true }` result.
    pub(in crate::interp) fn iterator_wrapper_return(
        &mut self,
        code: &[u8],
        this: Slot,
    ) -> Result<Slot, Step> {
        let Payload::Reference(wrapper) = this.value else {
            return Err(self.catchable_type_error_msg("this: not an iterator".into()));
        };
        let Some(state) = self
            .iterators
            .get(&wrapper)
            .filter(|state| state.kind == 8)
            .cloned()
        else {
            return Err(self.catchable_type_error_msg("this: not an iterator".into()));
        };
        let iterator = Slot::of(Kind::Reference, Payload::Reference(state.iterable));
        let return_id = self.intern_static_key("return");
        let return_method = self.mop_get(code, state.iterable, return_id, iterator)?;
        if matches!(return_method.kind, Kind::Undefined | Kind::Null) {
            let value_id = self.intern_static_key("value");
            let done_id = self.intern_static_key("done");
            let result = self.slots.alloc(Slot::instance(self.object_proto));
            self.set_own_unmetered(result, value_id, Slot::undefined());
            self.set_own_unmetered(result, done_id, Slot::boolean(true));
            return Ok(Slot::of(Kind::Reference, Payload::Reference(result)));
        }
        if !self.is_callable_value(return_method) {
            return Err(self.catchable_type_error_msg("call: not a function".into()));
        }
        self.call_any(code, return_method, iterator, &[])
    }

    /// Invoke one of the eager Iterator helpers (`reduce`, `toArray`,
    /// `forEach`, `some`, `every`, or `find`) behind a native try boundary.
    /// Their shared implementation below drives the public direct-iterator
    /// protocol rather than inspecting ironhorse's iterator side table, so
    /// user iterators, proxies, accessors, and overridden built-in `next`
    /// methods all remain observable.
    pub(in crate::interp) fn iterator_terminal_helper(
        &mut self,
        code: &[u8],
        op: u8,
        this: Slot,
        base: usize,
        argc: usize,
    ) -> Result<Slot, Step> {
        let outcome = self.run_guest_under_native_try(CallerHandlers::Isolate, |machine| {
            machine.iterator_terminal_helper_inner(code, op, this, base, argc)
        });
        match outcome {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error)) => Err(self.raise_js(error)),
            Err(halt) => Err(halt),
        }
    }

    /// IteratorClose with a normal completion. Unlike the abrupt-close helper
    /// used by `Array.from`, failures from getting/calling `return` replace the
    /// pending value, and a non-object return result is a TypeError.
    fn iterator_close_normal(
        &mut self,
        code: &[u8],
        iterator: Slot,
        completion: Slot,
    ) -> Result<Result<Slot, Slot>, Step> {
        let Payload::Reference(inst) = iterator.value else {
            return Ok(Err(
                self.internal_error("TypeError", "this: not an object".into())
            ));
        };
        let return_id = self.intern_static_key("return");
        let return_method =
            match self.array_from_try(|this| this.mop_get(code, inst, return_id, iterator))? {
                Ok(method) => method,
                Err(error) => return Ok(Err(error)),
            };
        if matches!(return_method.kind, Kind::Undefined | Kind::Null) {
            return Ok(Ok(completion));
        }
        if !self.is_callable_value(return_method) {
            return Ok(Err(
                self.internal_error("TypeError", "call: not a function".into())
            ));
        }
        let inner =
            match self.array_from_try(|this| this.call_any(code, return_method, iterator, &[]))? {
                Ok(value) => value,
                Err(error) => return Ok(Err(error)),
            };
        if inner.kind != Kind::Reference {
            return Ok(Err(self.internal_error(
                "TypeError",
                "iterator result: not an object".into(),
            )));
        }
        Ok(Ok(completion))
    }

    /// The common direct-iterator loop for the eager Iterator helpers. The
    /// operation ids follow `create_intrinsics`: 5 reduce, 6 toArray, 7
    /// forEach, 8 some, 9 every, 10 find.
    fn iterator_terminal_helper_inner(
        &mut self,
        code: &[u8],
        op: u8,
        iterator: Slot,
        base: usize,
        argc: usize,
    ) -> Result<Result<Slot, Slot>, Step> {
        let inst = match iterator.value {
            Payload::Reference(inst) if iterator.kind == Kind::Reference => inst,
            _ => {
                return Ok(Err(
                    self.internal_error("TypeError", "this: not an object".into())
                ))
            }
        };
        let callback = self
            .stack
            .get(base + 4)
            .copied()
            .unwrap_or_else(Slot::undefined);
        if op != 6 && !self.is_callable_value(callback) {
            // ES2025 creates the incomplete iterator record before validating
            // the callback. IteratorClose therefore observes `return`, but it
            // has not yet read `next`; the original TypeError always wins.
            let error = self.internal_error(
                "TypeError",
                match op {
                    5 => "reducer: not a function",
                    7 => "procedure: not a function",
                    _ => "predicate: not a function",
                }
                .into(),
            );
            return Ok(Err(self.array_from_close(code, iterator, error)?));
        }

        let value_id = self.intern_static_key("value");
        let done_id = self.intern_static_key("done");
        self.value_id = Some(value_id);
        self.done_id = Some(done_id);
        let next_id = self.intern_static_key("next");
        let next_method =
            match self.array_from_try(|this| this.mop_get(code, inst, next_id, iterator))? {
                Ok(method) if self.is_callable_value(method) => method,
                Ok(_) => {
                    return Ok(Err(
                        self.internal_error("TypeError", "call: not a function".into())
                    ))
                }
                Err(error) => return Ok(Err(error)),
            };

        let mut counter = 0u64;
        let mut accumulator = if op == 5 && argc >= 2 {
            self.stack
                .get(base + 5)
                .copied()
                .unwrap_or_else(Slot::undefined)
        } else {
            Slot::uninitialized()
        };
        let mut items = Vec::new();

        for _ in 0..1_000_000u64 {
            let step = match self
                .array_from_try(|this| this.call_any(code, next_method, iterator, &[]))?
            {
                Ok(step) => step,
                // IteratorStepValue failures propagate directly and do not
                // invoke `return`.
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
                return Ok(match op {
                    5 if accumulator.kind == Kind::Uninitialized => {
                        Err(self.internal_error("TypeError", "no initial value".into()))
                    }
                    5 => Ok(accumulator),
                    6 => {
                        // CreateArrayFromList at completion. Retain the
                        // existing toArray allocation/meter shape: one real
                        // Array instance followed by its dense item chunk.
                        let array = self.new_array();
                        let length = items.len() as u32;
                        let data = self.arrays.get_mut(&array).unwrap();
                        data.length = length;
                        for (index, value) in items.iter().enumerate() {
                            data.insert_item(index as u32, *value, &mut self.side_refs);
                        }
                        if length != 0 {
                            self.charge_and_check(self.array_chunk_size_metering(length))?;
                        }
                        Ok(Slot::of(Kind::Reference, Payload::Reference(array)))
                    }
                    7 => Ok(Slot::undefined()),
                    8 => Ok(Slot::boolean(false)),
                    9 => Ok(Slot::boolean(true)),
                    10 => Ok(Slot::undefined()),
                    _ => unreachable!("terminal Iterator helper id"),
                });
            }
            let value =
                match self.array_from_try(|this| this.mop_get(code, step_inst, value_id, step))? {
                    Ok(value) => value,
                    Err(error) => return Ok(Err(error)),
                };

            if op == 6 {
                items.push(value);
                counter += 1;
                continue;
            }
            if op == 5 && accumulator.kind == Kind::Uninitialized {
                accumulator = value;
                counter = 1;
                continue;
            }

            let args = if op == 5 {
                vec![accumulator, value, Slot::number(counter as f64)]
            } else {
                vec![value, Slot::number(counter as f64)]
            };
            let result = match self
                .array_from_try(|this| this.call_any(code, callback, Slot::undefined(), &args))?
            {
                Ok(result) => result,
                Err(error) => {
                    return Ok(Err(self.array_from_close(code, iterator, error)?));
                }
            };
            match op {
                5 => accumulator = result,
                7 => {}
                8 if self.truthy(&result) => {
                    return self.iterator_close_normal(code, iterator, Slot::boolean(true));
                }
                9 if !self.truthy(&result) => {
                    return self.iterator_close_normal(code, iterator, Slot::boolean(false));
                }
                10 if self.truthy(&result) => {
                    return self.iterator_close_normal(code, iterator, value);
                }
                8..=10 => {}
                _ => unreachable!("terminal Iterator helper id"),
            }
            counter += 1;
        }
        Err(Step::Host(Halt::StepLimit(self.n_dispatched)))
    }

    /// `fx_MapIterator_prototype_next` / `fx_SetIterator_prototype_next`: yield
    /// the collection's next live entry in insertion order, mutating and
    /// returning the reused result object. `kind` is 5 = keys (the entry key),
    /// 6 = values (the entry value; a Set stores its value as the key half, so
    /// a Set's kind-6 yields the key), 7 = entries (a fresh `[k, v]` pair; a
    /// Set yields `[v, v]`). Meters the per-`next()` base plus, for an entries
    /// yield, the two-element pair array's chunk. Entries are addressed by
    /// index into the live [`CollectionData::entries`] Vec (XS walks the linked
    /// list, skipping deleted `XS_DONT_ENUM` tombstones; the covered grammar
    /// does not mutate mid-iteration).
    pub(in crate::interp) fn collection_iterator_next(
        &mut self,
        iter: crate::value::SlotIndex,
    ) -> Slot {
        let st = self.iterators[&iter].clone();
        let result = st.result;
        // A `clear()` since this cursor was created retires it for good
        // (XS's purge frees the node chain the cursor walked; it never
        // reaches entries added after a clear). Latch done.
        let stale = self
            .collections
            .get(&st.iterable)
            .is_some_and(|c| c.generation() != st.generation);
        if stale {
            if let Some(s) = self.iterators.get_mut(&iter) {
                s.done = true;
            }
        }
        let st = self.iterators[&iter].clone();
        let len = self
            .collections
            .get(&st.iterable)
            .map(|c| c.entries().len() as u32)
            .unwrap_or(0);
        let mut live_index = st.index;
        while live_index < len
            && self.collections[&st.iterable].entries()[live_index as usize].is_none()
        {
            live_index += 1;
        }
        let (new_value, new_done, next_index): (Slot, bool, u32) = if st.done || live_index >= len {
            (Slot::undefined(), true, st.index)
        } else {
            // A keys/values yield carries no residual; an entries yield charges
            // the pair-construction frame ([`COLLECTION_ITERATOR_ENTRY_METERING`])
            // plus the two-element pair chunk (below).
            if st.kind == 7 {
                self.meter.tick_raw(COLLECTION_ITERATOR_ENTRY_METERING);
            }
            let (k, v) = self.collections[&st.iterable].entries()[live_index as usize].unwrap();
            let is_set = matches!(self.collections[&st.iterable].kind, CollKind::Set);
            let value = match st.kind {
                5 => k, // keys
                // values: a Map yields the value half; a Set stores its value
                // in the key half, so it yields the key.
                6 if is_set => k,
                6 => v,
                _ => {
                    // entries: `[key, value]` (a Set yields `[value, value]`).
                    let (a, b) = if is_set { (k, k) } else { (k, v) };
                    let pair = self.new_array();
                    let arr = self.arrays.get_mut(&pair).unwrap();
                    arr.length = 2;
                    arr.insert_item(0, Slot::of(a.kind, a.value), &mut self.side_refs);
                    arr.insert_item(1, Slot::of(b.kind, b.value), &mut self.side_refs);
                    self.meter.tick_raw(self.array_chunk_size_metering(2));
                    Slot::of(Kind::Reference, Payload::Reference(pair))
                }
            };
            (value, false, live_index + 1)
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

    /// The strong-collection brand declared by the native method function in
    /// the active call frame. Map and Set share several [`NativeMethod`]
    /// variants, but each boot-minted function identity occurs only on its
    /// declaring prototype (apart from Set's intentional keys/values alias).
    pub(in crate::interp) fn collection_method_brand(&self, base: usize) -> Option<CollKind> {
        let function = match self.stack.get(base + 1)?.value {
            Payload::Reference(function) => function,
            _ => return None,
        };
        self.proto_methods
            .iter()
            .find_map(|(prototype, _, method)| {
                if *method != function {
                    return None;
                }
                if *prototype == self.map_proto {
                    Some(CollKind::Map)
                } else if *prototype == self.set_proto {
                    Some(CollKind::Set)
                } else {
                    None
                }
            })
    }

    /// `fx_Map_prototype_forEach` / `fx_Set_prototype_forEach`: call the
    /// callback for each live entry in insertion order. Map passes
    /// `(value, key, coll)`; Set passes `(value, value, coll)`. Meters the
    /// native frame ([`COLLECTION_FOREACH_FRAME_METERING`]) plus, per entry,
    /// the call-frame residual ([`COLLECTION_FOREACH_PER_ENTRY_METERING`]) over
    /// the callback body the nested dispatch meters. Receiver and callback
    /// validation also applies to empty collections.
    pub(in crate::interp) fn call_collection_foreach(
        &mut self,
        this: Slot,
        base: usize,
        argc: usize,
        code: &[u8],
    ) -> Result<Slot, Step> {
        let _ = argc;
        let expected =
            self.collection_method_brand(base)
                .ok_or(Step::Host(Halt::EngineInvariant(
                    "collection:missing-method-brand",
                )))?;
        let inst = match self.collection_ref(this) {
            Some(i) => i,
            None => return Err(self.collection_brand_error(expected, false)),
        };
        if self.collections[&inst].kind != expected {
            self.charge_and_check(if expected == CollKind::Map {
                MAP_METHOD_ON_SET_METERING
            } else {
                SET_METHOD_ON_MAP_METERING
            })?;
            return Err(self.collection_brand_error(expected, false));
        }
        let is_set = expected == CollKind::Set;
        let callback = self
            .stack
            .get(base + 4)
            .copied()
            .unwrap_or_else(Slot::undefined);
        if !self.is_callable_value(callback) {
            return Err(self.catchable_type_error_msg("callback: not a function".into()));
        }
        let this_arg = self
            .stack
            .get(base + 4 + 1)
            .copied()
            .unwrap_or_else(Slot::undefined);
        self.charge_and_check(if is_set {
            SET_FOREACH_FRAME_METERING
        } else {
            MAP_FOREACH_FRAME_METERING
        })?;
        // Index into the insertion list. Deletions leave tombstones and
        // additions append, matching XS's live linked-list walk. A
        // `clear()` from inside the callback bumps the collection's
        // generation and ends the walk (XS's purge — the cursor never
        // reaches post-clear appends).
        let start_generation = self.collections.get(&inst).map_or(0, |c| c.generation());
        let mut i = 0u32;
        loop {
            if self
                .collections
                .get(&inst)
                .is_none_or(|c| c.generation() != start_generation)
            {
                break;
            }
            let entry = self
                .collections
                .get(&inst)
                .and_then(|c| c.entries().get(i as usize));
            let (k, v) = match entry {
                Some(Some(kv)) => *kv,
                Some(None) => {
                    i += 1;
                    continue;
                }
                None => break,
            };
            self.meter.tick_raw(COLLECTION_FOREACH_PER_ENTRY_METERING);
            // Map: cb(value, key, coll). Set: cb(value, value, coll) — the
            // value is stored in the key half.
            let cb_val = if is_set { k } else { v };
            let cb_key = k;
            let cb_args = [cb_val, cb_key, this];
            self.run_callback(code, callback, this_arg, &cb_args)?;
            i += 1;
        }
        Ok(Slot::undefined())
    }

    // ------------------------------------------------------------------
    // ES2025 "new Set methods" (set-methods proposal): union, intersection,
    // difference, symmetricDifference, isSubsetOf, isSupersetOf,
    // isDisjointFrom. Each requires the receiver to be a real Set (its
    // [[SetData]] internal slot is read directly, NEVER through overridden
    // methods) and coerces its argument through GetSetRecord — observing
    // `size` (→ ToNumber, NaN throws TypeError, negative throws RangeError),
    // then `has`, then `keys` (both must be callable). union / intersection /
    // difference / symmetricDifference return a fresh %Set.prototype% Set;
    // the three predicates return a Boolean.
    // ------------------------------------------------------------------

    /// The receiver's collection instance if it is a real (non-weak) Set, else
    /// a catchable TypeError (`RequireInternalSlot(O, [[SetData]])`).
    fn require_set_receiver(&mut self, this: Slot) -> Result<crate::value::SlotIndex, Step> {
        match self.collection_ref(this) {
            Some(inst) if self.collections[&inst].kind == CollKind::Set => Ok(inst),
            _ => Err(self.collection_brand_error(CollKind::Set, false)),
        }
    }

    /// The number of live (non-tombstone) entries of a native collection.
    fn collection_live_len(&self, inst: crate::value::SlotIndex) -> usize {
        self.collections
            .get(&inst)
            .map(CollectionData::live_len)
            .unwrap_or(0)
    }

    /// The live key slots of a native collection, in insertion order (for a Set
    /// the key half is the value). A snapshot the algorithms iterate.
    fn collection_live_keys(&self, inst: crate::value::SlotIndex) -> Vec<Slot> {
        self.collections
            .get(&inst)
            .map(|c| {
                c.entries()
                    .iter()
                    .filter_map(|e| e.map(|(k, _)| k))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// `Get(obj, id)` walking the ordinary prototype chain, but resolving the
    /// native `Map`/`Set` `size` accessor (which XS/ironhorse handle inline in
    /// GET_PROPERTY rather than as a stored accessor) when the chain carries no
    /// own/inherited `size` property. A user `get size()` override IS a stored
    /// accessor and is found by the chain walk first, so it still wins.
    fn set_record_get_size(
        &mut self,
        code: &[u8],
        obj: crate::value::SlotIndex,
        obj_slot: Slot,
    ) -> Result<Slot, Step> {
        let size_id = self.intern_static_key("size");
        let mut owner = obj;
        while !owner.is_null() {
            if owner != obj && self.proxies.contains_key(&owner) {
                return self.ordinary_get(code, obj, size_id, obj_slot);
            }
            if self.ordinary_get_own_descriptor(owner, size_id).is_some() {
                return self.ordinary_get(code, obj, size_id, obj_slot);
            }
            owner = self.instance_prototype(owner);
        }
        if let Some(c) = self.collections.get(&obj) {
            if matches!(c.kind, CollKind::Map | CollKind::Set) {
                return Ok(Slot::integer(self.collection_live_len(obj) as i32));
            }
        }
        Ok(Slot::undefined())
    }

    /// `GetSetRecord(obj)` (set-methods proposal): returns `(obj, size, has,
    /// keys)` after the exact observable get order — `size` → ToNumber →
    /// NaN/negative checks, then `has`, then `keys`. `size` is stored as an
    /// `f64` so `+Infinity` is representable.
    fn get_set_record(&mut self, code: &[u8], arg: Slot) -> Result<(Slot, f64, Slot, Slot), Step> {
        let obj = match arg.value {
            Payload::Reference(inst) if arg.kind == Kind::Reference => inst,
            _ => return Err(self.catchable_type_error_msg("other is no object".into())),
        };
        let raw_size = self.set_record_get_size(code, obj, arg)?;
        let num = self.to_number_value(code, raw_size)?;
        let num = to_number(&num);
        if num.is_nan() {
            return Err(self.catchable_type_error_msg("other.size is NaN".into()));
        }
        let int_size = if num.is_infinite() { num } else { num.trunc() };
        if int_size < 0.0 {
            return Err(self.catchable_range_error_msg("other.size < 0".into()));
        }
        let has_id = self.intern_static_key("has");
        let has = self.ordinary_get(code, obj, has_id, arg)?;
        if !self.value_is_callable(has) {
            return Err(self.catchable_type_error_msg("other.has is no function".into()));
        }
        let keys_id = self.intern_static_key("keys");
        let keys = self.ordinary_get(code, obj, keys_id, arg)?;
        if !self.value_is_callable(keys) {
            return Err(self.catchable_type_error_msg("other.keys is no function".into()));
        }
        Ok((arg, int_size, has, keys))
    }

    /// Whether a slot value is a callable function value (ordinary, native
    /// method, bound, or a callable proxy) — the value-typed wrapper over
    /// [`Self::slot_is_callable`].
    fn value_is_callable(&self, s: Slot) -> bool {
        match s.value {
            Payload::Reference(f) if s.kind == Kind::Reference => self.slot_is_callable(f),
            _ => false,
        }
    }

    /// `GetKeysIterator(setRecord)`: `keysIter = ? Call(keys, obj)` (must be an
    /// Object) and `nextMethod = ? Get(keysIter, "next")`. Returns
    /// `(keysIter, nextMethod)`.
    fn get_keys_iterator(
        &mut self,
        code: &[u8],
        obj: Slot,
        keys: Slot,
    ) -> Result<(Slot, Slot), Step> {
        let iter = self.call_primitive_method(code, keys, obj, &[])?;
        let iter_inst = match iter.value {
            Payload::Reference(i) if iter.kind == Kind::Reference => i,
            _ if matches!(iter.kind, Kind::Null | Kind::Undefined) => {
                return Err(self.catchable_type_error_msg(cannot_coerce_to_object(iter.kind)))
            }
            // XS reads `next` from boxed primitives and can proceed through
            // their prototypes. Keep the spec-only object guard distinct.
            _ => {
                return Err(self
                    .catchable_type_error_msg("Set operation: iterator must be an object".into()))
            }
        };
        let next_id = self.intern_static_key("next");
        let next = self.ordinary_get(code, iter_inst, next_id, iter)?;
        Ok((iter, next))
    }

    /// `IteratorStepValue(keysIter, nextMethod)`: one step of the keys
    /// iterator. `Ok(Some(value))` for a produced value, `Ok(None)` when done.
    fn set_keys_iterator_step(
        &mut self,
        code: &[u8],
        iter: Slot,
        next: Slot,
    ) -> Result<Option<Slot>, Step> {
        let result = self.call_primitive_method(code, next, iter, &[])?;
        let result_inst = match result.value {
            Payload::Reference(i) if result.kind == Kind::Reference => i,
            _ => return Err(self.catchable_type_error_msg("iterator result: not an object".into())),
        };
        let done_id = self.intern_static_key("done");
        let done = self.ordinary_get(code, result_inst, done_id, result)?;
        if self.truthy(&done) {
            return Ok(None);
        }
        let value_id = self.intern_static_key("value");
        let value = self.ordinary_get(code, result_inst, value_id, result)?;
        Ok(Some(value))
    }

    /// `IteratorClose(keysIter, NormalCompletion)`: call the iterator's
    /// `return` method if present; a thrown completion from `return`
    /// propagates.
    fn set_keys_iterator_close(&mut self, code: &[u8], iter: Slot) -> Result<(), Step> {
        let iter_inst = match iter.value {
            Payload::Reference(i) if iter.kind == Kind::Reference => i,
            _ => return Ok(()),
        };
        let return_id = self.intern_static_key("return");
        let ret = self.ordinary_get(code, iter_inst, return_id, iter)?;
        if ret.kind == Kind::Undefined || ret.kind == Kind::Null {
            return Ok(());
        }
        if self.value_is_callable(ret) {
            self.call_primitive_method(code, ret, iter, &[])?;
        }
        Ok(())
    }

    /// Canonicalize a set element key (`CanonicalizeKeyedCollectionKey`): only
    /// `-0` normalizes to `+0`, matching [`Self::normalize_coll_key`].
    fn canonicalize_set_key(&self, key: Slot) -> Slot {
        self.normalize_coll_key(key)
    }

    /// Whether `keys` (a working list built by a set method) already contains
    /// `key` by SameValueZero.
    fn key_list_contains(&self, keys: &[Slot], key: &Slot) -> bool {
        keys.iter().any(|k| self.same_value_zero(k, key))
    }

    /// Build a fresh `%Set.prototype%` Set holding exactly `keys` (already
    /// deduped and canonicalized by the caller), charging the same allocation
    /// metering the `new Set` constructor path charges.
    fn new_set_from_keys(&mut self, keys: Vec<Slot>) -> Slot {
        self.meter.tick_raw(MAP_CTOR_FRAME_METERING);
        self.meter.tick_slot_alloc(); // instance
        self.meter.tick_slot_alloc(); // table
        self.meter.tick_slot_alloc(); // list
        self.meter.tick_slot_alloc(); // size
        self.meter.tick_chunk_new(MAP_MIN_TABLE_LENGTH as u64 * 8);
        let inst = self.slots.alloc(Slot::instance(self.set_proto));
        self.collections.insert(
            inst,
            CollectionData::new(CollKind::Set, MAP_MIN_TABLE_LENGTH),
        );
        for key in keys {
            self.charge_new_entry_slots(2);
            self.collections.get_mut(&inst).unwrap().push_entry(
                key,
                Slot::undefined(),
                &mut self.side_refs,
            );
            self.collection_table_resize(inst);
        }
        Slot::of(Kind::Reference, Payload::Reference(inst))
    }

    pub(in crate::interp) fn call_set_method(
        &mut self,
        m: NativeMethod,
        this: Slot,
        base: usize,
        code: &[u8],
    ) -> Result<Slot, Step> {
        let inst = self.require_set_receiver(this)?;
        let arg0 = self
            .stack
            .get(base + 4)
            .copied()
            .unwrap_or_else(Slot::undefined);
        let (obj, other_size, has, keys) = self.get_set_record(code, arg0)?;
        match m {
            NativeMethod::SetUnion => {
                let mut result = self.collection_live_keys(inst);
                let (iter, next) = self.get_keys_iterator(code, obj, keys)?;
                while let Some(v) = self.set_keys_iterator_step(code, iter, next)? {
                    let v = self.canonicalize_set_key(v);
                    if !self.key_list_contains(&result, &v) {
                        result.push(v);
                    }
                }
                Ok(self.new_set_from_keys(result))
            }
            NativeMethod::SetIntersection => {
                let mut result: Vec<Slot> = Vec::new();
                let this_len = self.collection_live_len(inst);
                if (this_len as f64) <= other_size {
                    // Walk THIS in order; keep those the other set `has`. `has`
                    // may mutate THIS, so re-check the element is still present.
                    let mut i = 0u32;
                    loop {
                        let entry = self
                            .collections
                            .get(&inst)
                            .and_then(|c| c.entries().get(i as usize));
                        let k = match entry {
                            Some(Some((k, _))) => *k,
                            Some(None) => {
                                i += 1;
                                continue;
                            }
                            None => break,
                        };
                        let in_other = self.call_primitive_method(code, has, obj, &[k])?;
                        if self.truthy(&in_other)
                            && self.collection_find(inst, &k).is_some()
                            && !self.key_list_contains(&result, &k)
                        {
                            result.push(k);
                        }
                        i += 1;
                    }
                } else {
                    // Iterate the OTHER set's keys; keep those THIS contains.
                    let (iter, next) = self.get_keys_iterator(code, obj, keys)?;
                    while let Some(v) = self.set_keys_iterator_step(code, iter, next)? {
                        let v = self.canonicalize_set_key(v);
                        if self.collection_find(inst, &v).is_some()
                            && !self.key_list_contains(&result, &v)
                        {
                            result.push(v);
                        }
                    }
                }
                Ok(self.new_set_from_keys(result))
            }
            NativeMethod::SetDifference => {
                let mut result = self.collection_live_keys(inst);
                let this_len = result.len();
                if (this_len as f64) <= other_size {
                    // For each element of THIS, remove it if the other set has it.
                    let mut i = 0usize;
                    while i < result.len() {
                        let k = result[i];
                        let in_other = self.call_primitive_method(code, has, obj, &[k])?;
                        if self.truthy(&in_other) {
                            result.retain(|e| !self.same_value_zero(e, &k));
                        } else {
                            i += 1;
                        }
                    }
                } else {
                    // Iterate the other set's keys; remove each from the result.
                    let (iter, next) = self.get_keys_iterator(code, obj, keys)?;
                    while let Some(v) = self.set_keys_iterator_step(code, iter, next)? {
                        let v = self.canonicalize_set_key(v);
                        result.retain(|e| !self.same_value_zero(e, &v));
                    }
                }
                Ok(self.new_set_from_keys(result))
            }
            NativeMethod::SetSymmetricDifference => {
                let mut result = self.collection_live_keys(inst);
                let (iter, next) = self.get_keys_iterator(code, obj, keys)?;
                while let Some(v) = self.set_keys_iterator_step(code, iter, next)? {
                    let v = self.canonicalize_set_key(v);
                    let in_this = self.collection_find(inst, &v).is_some();
                    if in_this {
                        result.retain(|e| !self.same_value_zero(e, &v));
                    } else if !self.key_list_contains(&result, &v) {
                        result.push(v);
                    }
                }
                Ok(self.new_set_from_keys(result))
            }
            NativeMethod::SetIsSubsetOf => {
                // this ⊆ other. If |this| > |other|, false. Else every element
                // of THIS must be `has` in the other set.
                let this_keys = self.collection_live_keys(inst);
                if (this_keys.len() as f64) > other_size {
                    return Ok(Slot::boolean(false));
                }
                let mut i = 0u32;
                loop {
                    let entry = self
                        .collections
                        .get(&inst)
                        .and_then(|c| c.entries().get(i as usize));
                    let k = match entry {
                        Some(Some((k, _))) => *k,
                        Some(None) => {
                            i += 1;
                            continue;
                        }
                        None => break,
                    };
                    let in_other = self.call_primitive_method(code, has, obj, &[k])?;
                    if !self.truthy(&in_other) {
                        return Ok(Slot::boolean(false));
                    }
                    i += 1;
                }
                Ok(Slot::boolean(true))
            }
            NativeMethod::SetIsSupersetOf => {
                // this ⊇ other. If |this| < |other|, false. Else every key of
                // OTHER must be contained in THIS.
                let this_len = self.collection_live_len(inst);
                if (this_len as f64) < other_size {
                    return Ok(Slot::boolean(false));
                }
                let (iter, next) = self.get_keys_iterator(code, obj, keys)?;
                while let Some(v) = self.set_keys_iterator_step(code, iter, next)? {
                    if self.collection_find(inst, &v).is_none() {
                        self.set_keys_iterator_close(code, iter)?;
                        return Ok(Slot::boolean(false));
                    }
                }
                Ok(Slot::boolean(true))
            }
            NativeMethod::SetIsDisjointFrom => {
                // No common element. Walk the smaller side.
                let this_len = self.collection_live_len(inst);
                if (this_len as f64) <= other_size {
                    let mut i = 0u32;
                    loop {
                        let entry = self
                            .collections
                            .get(&inst)
                            .and_then(|c| c.entries().get(i as usize));
                        let k = match entry {
                            Some(Some((k, _))) => *k,
                            Some(None) => {
                                i += 1;
                                continue;
                            }
                            None => break,
                        };
                        let in_other = self.call_primitive_method(code, has, obj, &[k])?;
                        if self.truthy(&in_other) {
                            return Ok(Slot::boolean(false));
                        }
                        i += 1;
                    }
                } else {
                    let (iter, next) = self.get_keys_iterator(code, obj, keys)?;
                    while let Some(v) = self.set_keys_iterator_step(code, iter, next)? {
                        if self.collection_find(inst, &v).is_some() {
                            self.set_keys_iterator_close(code, iter)?;
                            return Ok(Slot::boolean(false));
                        }
                    }
                }
                Ok(Slot::boolean(true))
            }
            _ => Err(Step::Host(Halt::EngineInvariant(
                "set-method:unexpected-method",
            ))),
        }
    }

    // ------------------------------------------------------------------
    // Upsert proposal: `{Map,WeakMap}.prototype.getOrInsert` /
    // `getOrInsertComputed`. Shared handler — the proposal covers both Map and
    // WeakMap. It requires a real `[[MapData]]`/`[[WeakMapData]]` receiver of
    // the matching kind, reads its argument against the (canonicalized for Map;
    // pass-through for WeakMap) key, and — on absence — inserts (three entry
    // slots, the same metering `set` charges on either collection).
    // `getOrInsertComputed` calls the callback exactly once on absence with
    // `this` undefined and the key as its sole argument, then overwrites
    // whatever entry the callback itself may have inserted. The WeakMap forms
    // additionally reject a non-weakly-holdable key (a primitive) with a
    // TypeError *before* any callable check or insertion (spec order).
    // ------------------------------------------------------------------
    pub(in crate::interp) fn call_map_get_or_insert(
        &mut self,
        m: NativeMethod,
        this: Slot,
        base: usize,
        code: &[u8],
    ) -> Result<Slot, Step> {
        let (expected_kind, weak) = match m {
            NativeMethod::MapGetOrInsert | NativeMethod::MapGetOrInsertComputed => {
                (CollKind::Map, false)
            }
            NativeMethod::WeakMapGetOrInsert | NativeMethod::WeakMapGetOrInsertComputed => {
                (CollKind::WeakMap, true)
            }
            _ => {
                return Err(Step::Host(Halt::EngineInvariant(
                    "map-get-or-insert:unexpected-method",
                )))
            }
        };
        let inst = match self.collection_ref(this) {
            Some(i) if self.collections[&i].kind == expected_kind => i,
            _ => return Err(self.collection_brand_error(expected_kind, false)),
        };
        if self.slots.get(inst).flag & XS_DONT_MODIFY_FLAG != 0 {
            return Err(self.collection_brand_error(expected_kind, true));
        }
        let key_arg = self
            .stack
            .get(base + 4)
            .copied()
            .unwrap_or_else(Slot::undefined);
        // `CanBeHeldWeakly(key)` — a WeakMap key must be a reference (XS, like
        // this engine's `WeakMap.prototype.set`, admits objects only). Checked
        // before the callable check and before any lookup/insert.
        let key = self.normalize_coll_key(key_arg);
        if weak && key.kind != Kind::Reference {
            return Err(self.catchable_type_error_msg("key: not an object".into()));
        }
        match m {
            NativeMethod::MapGetOrInsert | NativeMethod::WeakMapGetOrInsert => {
                let value = self
                    .stack
                    .get(base + 5)
                    .copied()
                    .unwrap_or_else(Slot::undefined);
                if let Some(p) = self.collection_find(inst, &key) {
                    return Ok(self.collections[&inst].entries()[p].unwrap().1);
                }
                self.charge_new_entry_slots(3);
                self.collections.get_mut(&inst).unwrap().push_entry(
                    key,
                    value,
                    &mut self.side_refs,
                );
                self.collection_table_resize(inst);
                Ok(value)
            }
            NativeMethod::MapGetOrInsertComputed | NativeMethod::WeakMapGetOrInsertComputed => {
                let callbackfn = self
                    .stack
                    .get(base + 5)
                    .copied()
                    .unwrap_or_else(Slot::undefined);
                if !self.value_is_callable(callbackfn) {
                    return Err(self.catchable_type_error_msg("callback: not a function".into()));
                }
                if let Some(p) = self.collection_find(inst, &key) {
                    return Ok(self.collections[&inst].entries()[p].unwrap().1);
                }
                // `Call(callbackfn, undefined, « key »)`. The callback may mutate
                // the map (including inserting `key` itself); the computed value
                // then overwrites that entry.
                let value = self.run_callback(code, callbackfn, Slot::undefined(), &[key])?;
                match self.collection_find(inst, &key) {
                    Some(p) => {
                        self.collections.get_mut(&inst).unwrap().set_entry_value(
                            p,
                            value,
                            &mut self.side_refs,
                        );
                    }
                    None => {
                        self.charge_new_entry_slots(3);
                        self.collections.get_mut(&inst).unwrap().push_entry(
                            key,
                            value,
                            &mut self.side_refs,
                        );
                        self.collection_table_resize(inst);
                    }
                }
                Ok(value)
            }
            _ => Err(Step::Host(Halt::EngineInvariant(
                "map-get-or-insert:unexpected-method",
            ))),
        }
    }

    // ------------------------------------------------------------------
    // Array-grouping proposal: `Map.groupBy` / `Object.groupBy`. Both share the
    // `GroupBy(items, callbackfn, coercion)` skeleton — iterate `items`, call
    // `callbackfn(value, 𝔽(index))` per element, and bucket the values by key.
    // `Map.groupBy` uses `zero` coercion (SameValueZero, `-0`→`+0`) into a fresh
    // `Map` whose values are Arrays; `Object.groupBy` uses `property` coercion
    // (`? ToPropertyKey(key)`) into a fresh null-prototype object.
    // ------------------------------------------------------------------

    /// Read one member of an iterator result object's own `value`/`done`
    /// (through the cached ids the group-by widening force-bound).
    fn iter_result_member(&mut self, code: &[u8], result: Slot, done: bool) -> Result<Slot, Step> {
        let inst = match result.value {
            Payload::Reference(i) if result.kind == Kind::Reference => i,
            _ => return Err(self.catchable_type_error_msg("iterator result: not an object".into())),
        };
        let id = if done {
            match self.done_id {
                Some(v) => v,
                None => self.intern_static_key("done"),
            }
        } else {
            match self.value_id {
                Some(v) => v,
                None => self.intern_static_key("value"),
            }
        };
        self.ordinary_get(code, inst, id, result)
    }

    pub(in crate::interp) fn call_group_by(
        &mut self,
        m: NativeMethod,
        base: usize,
        code: &[u8],
    ) -> Result<Slot, Step> {
        let is_map = matches!(m, NativeMethod::MapGroupBy);
        let items = self
            .stack
            .get(base + 4)
            .copied()
            .unwrap_or_else(Slot::undefined);
        let callbackfn = self
            .stack
            .get(base + 5)
            .copied()
            .unwrap_or_else(Slot::undefined);
        // fxGroupBy diagnoses the missing items/callback slots before its
        // callback and iterator checks (xsProperty.c).
        if items.kind == Kind::Undefined || callbackfn.kind == Kind::Undefined {
            return Err(self.catchable_type_error_msg("items: not an object".into()));
        }
        if !self.value_is_callable(callbackfn) {
            return Err(self.catchable_type_error_msg("callback: not a function".into()));
        }
        // Buckets in first-insertion order: (canonical key slot, values). For
        // the `property` coercion, `repr` is the SameValue-distinguishing key
        // identity (symbol descriptor vs string text) used to match buckets.
        let mut buckets: Vec<(Slot, Vec<Slot>)> = Vec::new();
        let mut reprs: Vec<(Option<u16>, Vec<u16>)> = Vec::new();
        let mut index: i32 = 0;

        // A closure would need `&mut self`, so record inline. `record` buckets
        // one produced value under the callback's (coerced) result.
        macro_rules! record {
            ($value:expr) => {{
                let value = $value;
                let key = self.run_callback(
                    code,
                    callbackfn,
                    Slot::undefined(),
                    &[value, Slot::integer(index)],
                )?;
                if is_map {
                    let key = self.normalize_coll_key(key);
                    match buckets
                        .iter()
                        .position(|(k, _)| self.same_value_zero(k, &key))
                    {
                        Some(p) => buckets[p].1.push(value),
                        None => buckets.push((key, vec![value])),
                    }
                } else {
                    let key = self.to_property_key_slot(code, key)?;
                    let repr = self.property_key_repr(key)?;
                    match reprs.iter().position(|r| *r == repr) {
                        Some(p) => buckets[p].1.push(value),
                        None => {
                            reprs.push(repr);
                            buckets.push((key, vec![value]));
                        }
                    }
                }
                index += 1;
            }};
        }

        // GetIterator(items) + the iterate/step loop, with the same intrinsic
        // fast paths `for..of` uses (dense array, string), and the generic
        // `@@iterator` protocol for everything else. Arrays/strings the tests
        // never re-decorate iterate observationally identically to the real
        // iterator; a plain object with a nullish/absent `@@iterator` throws.
        match items.value {
            Payload::Reference(i) if self.arrays.contains_key(&i) => {
                let mut k = 0u32;
                loop {
                    let len = match self.arrays.get(&i) {
                        Some(a) => a.length,
                        None => break,
                    };
                    if k >= len {
                        break;
                    }
                    let value = self
                        .arrays
                        .get(&i)
                        .and_then(|a| a.items().get(&k))
                        .copied()
                        .unwrap_or_else(Slot::undefined);
                    record!(value);
                    k += 1;
                }
            }
            Payload::String(off) if items.kind == Kind::String => {
                let bytes = self.str_content(off).to_vec();
                let it = self.make_string_iterator(bytes);
                let iter_inst = match it.value {
                    Payload::Reference(x) => x,
                    _ => {
                        return Err(Step::Host(Halt::EngineInvariant(
                            "group-by:invalid-string-iterator",
                        )))
                    }
                };
                loop {
                    let result = self.string_iterator_next(iter_inst)?;
                    let done = self.iter_result_member(code, result, true)?;
                    if self.truthy(&done) {
                        break;
                    }
                    let value = self.iter_result_member(code, result, false)?;
                    record!(value);
                }
            }
            Payload::Reference(obj) => {
                // GetIterator(items, sync): `method = ? GetMethod(items,
                // @@iterator)`; a nullish/absent method throws TypeError.
                let iter_id = self
                    .well_known_symbol_property_id("iterator")
                    .unwrap_or(crate::value::XS_NO_ID);
                let method = if iter_id == crate::value::XS_NO_ID {
                    Slot::undefined()
                } else {
                    self.ordinary_get(code, obj, iter_id, items)?
                };
                if method.kind == Kind::Undefined || method.kind == Kind::Null {
                    return Err(self.catchable_type_error_msg("call: not a function".into()));
                }
                let iterator = self.call_primitive_method(code, method, items, &[])?;
                let iter_inst = match iterator.value {
                    Payload::Reference(x) if iterator.kind == Kind::Reference => x,
                    _ => {
                        return Err(self.catchable_type_error_msg("iterator: not an object".into()))
                    }
                };
                let next_id = self.intern_static_key("next");
                let next = self.ordinary_get(code, iter_inst, next_id, iterator)?;
                // A defensive bound against a pathological non-terminating guest
                // iterator; the tested iterables are short.
                for _ in 0..1_000_000 {
                    let step = self.call_primitive_method(code, next, iterator, &[])?;
                    let done = self.iter_result_member(code, step, true)?;
                    if self.truthy(&done) {
                        break;
                    }
                    let value = self.iter_result_member(code, step, false)?;
                    record!(value);
                }
            }
            _ if items.kind == Kind::Null => {
                return Err(self.catchable_type_error_msg("cannot coerce null to object".into()))
            }
            _ => return Err(self.catchable_type_error_msg("call: not a function".into())),
        }

        if is_map {
            Ok(self.new_map_from_buckets(buckets))
        } else {
            self.new_group_object_from_buckets(code, buckets)
        }
    }

    /// Disjoint identities for string and symbol property keys.
    fn property_key_repr(&mut self, key: Slot) -> Result<(Option<u16>, Vec<u16>), Step> {
        Ok(match key.value {
            Payload::Reference(desc) if key.kind == Kind::Symbol => {
                (Some(self.intern_symbol_key(desc)?), Vec::new())
            }
            Payload::String(off) if key.kind == Kind::String => (None, self.str_units(off)),
            _ => unreachable!("ToPropertyKey must produce a string or symbol"),
        })
    }

    /// Build a fresh `%Map.prototype%` Map whose entries are the group-by
    /// buckets (each value an Array of that bucket's elements), charging the
    /// same allocation metering the `new Map` constructor path charges.
    fn new_map_from_buckets(&mut self, buckets: Vec<(Slot, Vec<Slot>)>) -> Slot {
        self.meter.tick_raw(MAP_CTOR_FRAME_METERING);
        self.meter.tick_slot_alloc(); // instance
        self.meter.tick_slot_alloc(); // table
        self.meter.tick_slot_alloc(); // list
        self.meter.tick_slot_alloc(); // size
        self.meter.tick_chunk_new(MAP_MIN_TABLE_LENGTH as u64 * 8);
        let inst = self.slots.alloc(Slot::instance(self.map_proto));
        self.collections.insert(
            inst,
            CollectionData::new(CollKind::Map, MAP_MIN_TABLE_LENGTH),
        );
        for (key, values) in buckets {
            let array = self.group_array_from_values(values);
            self.charge_new_entry_slots(3);
            self.collections
                .get_mut(&inst)
                .unwrap()
                .push_entry(key, array, &mut self.side_refs);
            self.collection_table_resize(inst);
        }
        Slot::of(Kind::Reference, Payload::Reference(inst))
    }

    /// Build the null-prototype ordinary object `Object.groupBy` returns: one
    /// own enumerable data property per bucket (key from the coerced property
    /// key, value the bucket's Array). Integer-index keys order ahead of string
    /// keys per the engine's ordinary-object enumeration, matching XS.
    fn new_group_object_from_buckets(
        &mut self,
        code: &[u8],
        buckets: Vec<(Slot, Vec<Slot>)>,
    ) -> Result<Slot, Step> {
        let obj = self.new_object();
        // OrdinaryObjectCreate(null): a null prototype.
        self.slots.get_mut(obj).value = Payload::Reference(crate::value::SlotIndex::NULL);
        let obj_slot = Slot::of(Kind::Reference, Payload::Reference(obj));
        for (key, values) in buckets {
            let array = self.group_array_from_values(values);
            let at = match key.kind {
                Kind::Symbol => {
                    let id = match key.value {
                        Payload::Reference(desc) => self.intern_symbol_key(desc)?,
                        _ => {
                            return Err(Step::Host(Halt::EngineInvariant(
                                "group-by:invalid-symbol-key",
                            )))
                        }
                    };
                    Slot::of(Kind::At, Payload::At(id, 0))
                }
                Kind::String => {
                    let s = match key.value {
                        Payload::String(off) => SymbolName::from_units(&self.str_units(off)),
                        _ => {
                            return Err(Step::Host(Halt::EngineInvariant(
                                "group-by:invalid-string-key",
                            )))
                        }
                    };
                    if let Some(idx) = s.as_str().and_then(string_to_index) {
                        Slot::of(Kind::At, Payload::At(crate::value::XS_NO_ID, idx))
                    } else {
                        let id = self.intern_key(&s)?;
                        Slot::of(Kind::At, Payload::At(id, 0))
                    }
                }
                _ => {
                    return Err(Step::Host(Halt::EngineInvariant(
                        "group-by:invalid-key-kind",
                    )))
                }
            };
            // CreateDataPropertyOrThrow (enumerable/writable/configurable own).
            self.property_at_set(code, obj_slot, at, array, true)?;
        }
        Ok(obj_slot)
    }

    /// A fresh dense `%Array.prototype%` Array holding a bucket's values,
    /// charging the array-create metering the `[..]` literal path charges.
    fn group_array_from_values(&mut self, values: Vec<Slot>) -> Slot {
        let inst = self.new_array();
        let n = values.len() as u32;
        for (i, v) in values.into_iter().enumerate() {
            self.meter.tick_raw(ARRAY_ITEM_DEFINE_STEP_METERING);
            let mut v = v;
            v.id = 0;
            v.next = crate::value::SlotIndex::NULL;
            self.arrays
                .get_mut(&inst)
                .unwrap()
                .insert_item(i as u32, v, &mut self.side_refs);
        }
        self.arrays.get_mut(&inst).unwrap().length = n;
        Slot::of(Kind::Reference, Payload::Reference(inst))
    }

    /// Yield the next code point from the stored UTF-16BE payload and advance
    /// the byte offset. Valid surrogate pairs yield one two-code-unit string;
    /// lone surrogates yield one-code-unit strings. Charge the per-`next()`
    /// base and the yielded string's chunk allocation.
    pub(in crate::interp) fn string_iterator_next(
        &mut self,
        iter: crate::value::SlotIndex,
    ) -> Result<Slot, Step> {
        let st = self.iterators[&iter].clone();
        let result = st.result;
        let (new_value, new_done, next_index): (Slot, bool, u32) =
            if st.done || (st.index as usize) >= st.str_bytes.len() {
                (Slot::undefined(), true, st.index)
            } else {
                // `index` is a BYTE offset into the UTF-16BE payload; each yielded
                // code point consumes one code unit (2 bytes) or, for a valid
                // surrogate pair, two (4 bytes) — `for...of` iterates by code point.
                let i = st.index as usize;
                if i + 2 > st.str_bytes.len() {
                    return Err(Step::Host(Halt::EngineInvariant(
                        "string-iterator:truncated-sequence",
                    )));
                }
                let hi = u16::from_be_bytes([st.str_bytes[i], st.str_bytes[i + 1]]);
                let consumed = if (0xD800..=0xDBFF).contains(&hi) && i + 4 <= st.str_bytes.len() {
                    let lo = u16::from_be_bytes([st.str_bytes[i + 2], st.str_bytes[i + 3]]);
                    if (0xDC00..=0xDFFF).contains(&lo) {
                        4 // a valid surrogate pair → one astral code point
                    } else {
                        2 // a lone high surrogate → yielded as its own code unit
                    }
                } else {
                    2
                };
                // The yielded string is exactly the consumed BE bytes (already the
                // stored form). Metered by yielded code-unit length (`+1`), the
                // re-based O(n) weight; ASCII yields meter identically to before.
                self.meter.tick_raw(STRING_ITERATOR_NEXT_METERING);
                self.charge_chunk_work((consumed / 2 + 1) as u64)?;
                let off = self.chunks.alloc(&st.str_bytes[i..i + consumed]);
                (
                    Slot::of(Kind::String, Payload::String(off)),
                    false,
                    st.index + consumed as u32,
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
        Ok(Slot::of(Kind::Reference, Payload::Reference(result)))
    }

    /// If `this` is a reference to a Map/Set/WeakMap/WeakSet instance, its
    /// slot index; else `None`.
    pub(in crate::interp) fn collection_ref(&self, this: Slot) -> Option<crate::value::SlotIndex> {
        match this.value {
            Payload::Reference(r) if self.collections.contains_key(&r) => Some(r),
            _ => None,
        }
    }

    /// ES2025 `SetterThatIgnoresPrototypeProperties`, specialized to the two
    /// accessor properties on `%Iterator.prototype%`. An inherited assignment
    /// creates a normal own data property instead of recursing back into this
    /// setter; an existing own descriptor receives ordinary strict `Set`
    /// semantics. Assignment to the home prototype itself is rejected.
    pub(in crate::interp) fn iterator_prototype_setter(
        &mut self,
        code: &[u8],
        method: NativeMethod,
        this: Slot,
        value: Slot,
    ) -> Result<Slot, Step> {
        let name = match method {
            NativeMethod::IteratorConstructorSetter => "constructor",
            NativeMethod::IteratorToStringTagSetter => "Symbol(toStringTag)",
            _ => unreachable!("only Iterator prototype setters dispatch here"),
        };
        let inst = match this.value {
            Payload::Reference(inst) if this.kind == Kind::Reference => inst,
            _ => return Err(self.catchable_type_error_msg(format!("set {name}: not an object"))),
        };
        if inst == self.iterator_proto {
            return Err(self.catchable_type_error_msg(format!("set {name}: not writable")));
        }
        let id = match method {
            NativeMethod::IteratorConstructorSetter => {
                self.intern_static_key_unmetered("constructor")
            }
            NativeMethod::IteratorToStringTagSetter => self
                .well_known_symbol_property_id("toStringTag")
                .ok_or(Step::Host(Halt::EngineInvariant(
                    "Iterator.setter:missing-toStringTag",
                )))?,
            _ => unreachable!("only Iterator prototype setters dispatch here"),
        };
        let existing = self.mop_get_own_property(code, inst, id)?.is_some();
        let accepted = if existing {
            // `SetterThatIgnoresPrototypeProperties` step 5 is an ordinary
            // `Set`, so a receiver carrying its own copy of this very accessor
            // re-enters this native unboundedly -- without ever passing through
            // `dispatch_at`. The native-recursion budget bounds it all the same:
            // every level passes through `mop_set` (a light frame) and back into
            // `call_native_method` (a heavy one). The pinned XS does not
            // complete this program either (it aborts at ~8180 computrons); the
            // point is to degrade to a `Halt::ReentryLimit` the host can
            // observe rather than overflowing the real thread stack and taking
            // the process down.
            self.mop_set(code, inst, id, value, this)?
        } else {
            self.mop_define_own_property(
                code,
                inst,
                id,
                OrdinaryDescriptor {
                    value: Some(value),
                    writable: Some(true),
                    enumerable: Some(true),
                    configurable: Some(true),
                    ..OrdinaryDescriptor::default()
                },
            )?
        };
        if !accepted {
            let reason = if existing {
                "not writable"
            } else {
                "not extensible"
            };
            return Err(self.catchable_type_error_msg(format!("set {name}: {reason}")));
        }
        Ok(Slot::undefined())
    }

    /// `fxCheckMapKey`: normalize a collection key so `-0` is stored/compared
    /// as `+0` (every other value is unchanged; SameValueZero already unifies
    /// `NaN`).
    fn normalize_coll_key(&self, key: Slot) -> Slot {
        match key.value {
            Payload::Number(n) if n == 0.0 => Slot::number(0.0),
            _ => key,
        }
    }

    /// Canonicalize exactly the equality relation used by collection keys.
    /// This is host bookkeeping only; it introduces no guest allocations or
    /// metering changes and holds no arena borrow across another chunk read.
    fn coll_index_key(&self, key: &Slot) -> CollKey {
        match key.value {
            Payload::None => CollKey::Empty(key.kind as u8),
            Payload::Boolean(value) => CollKey::Boolean(value),
            Payload::Integer(value) => CollKey::Number((value as f64).to_bits()),
            Payload::Number(value) => CollKey::Number(if value == 0.0 {
                0
            } else {
                crate::value::canonicalize_nan(value).to_bits()
            }),
            Payload::String(off) => CollKey::String(self.chunks.payload(off).to_vec()),
            Payload::BigInt(off) => {
                let (negative, magnitude) = self.read_bigint(off);
                CollKey::BigInt(negative, magnitude)
            }
            Payload::Reference(reference) => CollKey::Reference(reference),
            Payload::At(..) => unreachable!("internal property key in a collection"),
        }
    }

    /// The index of `key` among `inst`'s entries by SameValueZero, or `None`.
    fn collection_find(&self, inst: crate::value::SlotIndex, key: &Slot) -> Option<usize> {
        let data = self.collections.get(&inst)?;
        data.find(&self.coll_index_key(key), |key| self.coll_index_key(key))
    }

    /// Charge the metering of an inserting `fxSetEntry`/`fxSetWeakEntry` new
    /// entry of `n` slots: the `fxNewSlot` base (`XS_SLOT_ALLOCATION_METERING`)
    /// per slot, plus [`COLLECTION_SLOT_LINK_METERING`] for each slot beyond the
    /// first (the measured per-linked-slot residual). The rehash chunk, if any,
    /// is charged separately by [`Self::collection_table_resize`].
    fn charge_new_entry_slots(&mut self, n: u64) {
        for _ in 0..n {
            self.meter.tick_slot_alloc();
        }
        self.meter.tick_raw((n - 1) * COLLECTION_SLOT_LINK_METERING);
    }

    /// `fxResizeEntries` after a Map/Set size change: grow/shrink the
    /// power-of-two address array and, when its length changes, charge the
    /// `fxNewChunk(currentLength * 8)` — the rehash's only allocation. A weak
    /// collection has no table, so this is a no-op for it.
    pub(in crate::interp) fn collection_table_resize(&mut self, inst: crate::value::SlotIndex) {
        let (former, size) = {
            let data = &self.collections[&inst];
            if data.kind == CollKind::WeakMap || data.kind == CollKind::WeakSet {
                return;
            }
            (data.table_length, data.live_len() as u32)
        };
        // mxTableThreshold(L) = (L>>1) + (L>>2); high = threshold, low = high>>1.
        let high = (former >> 1) + (former >> 2);
        let low = high >> 1;
        let mut current = former;
        if high < size {
            current = former << 1;
            let max = 1024 * 1024;
            if current > max {
                current = max;
            }
        } else if low >= size {
            current = former >> 1;
            if current < MAP_MIN_TABLE_LENGTH {
                current = MAP_MIN_TABLE_LENGTH;
            }
        }
        if current != former {
            self.meter.tick_chunk_new(current as u64 * 8);
            // The first grow away from the minimum-length (1) address array
            // carries a measured one-time `+8` raw over the plain
            // `fxNewChunk(current * 8)` (the length-1 array the fresh
            // instance's `fxNewChunk(mxTableMinLength * 8)` created is released
            // as the new one is installed). Raw-exact against the pin.
            if former == MAP_MIN_TABLE_LENGTH && current > former {
                self.meter.tick_raw(MAP_FIRST_GROW_METERING);
            }
            self.collections.get_mut(&inst).unwrap().table_length = current;
        }
    }
}
