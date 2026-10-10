//! Property object operations.
use crate::interp::*;

impl Interp {
    /// `Get(arrayLike, "length")` honoring the exotic-array length accessor
    /// (which lives in the `arrays` side table, not an ordinary property).
    pub(in crate::interp) fn arraylike_length(
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
        let length_id = self.intern_static_key("length");
        self.mop_get(code, inst, length_id, receiver)
    }

    /// `Get(arrayLike, ToString(index))` honoring exotic-array indexed elements.
    pub(in crate::interp) fn arraylike_index(
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
    pub(in crate::interp) fn arraylike_index_walk(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        i: u64,
        receiver: Slot,
    ) -> Result<Slot, Step> {
        match self.array_generic_index_read_key(inst, i)? {
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
    pub(in crate::interp) fn object_from_entries(
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

    pub(in crate::interp) fn object_from_entries_inner(
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

        let value_id = self.intern_static_key("value");
        let done_id = self.intern_static_key("done");
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
            let next_id = self.intern_static_key("next");
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
                let error = self.internal_error(
                    "TypeError",
                    "Object.fromEntries: result property definition failed".into(),
                );
                let error = self.array_from_close(code, iterator, error)?;
                return Ok(Err(error));
            }
        }
        Err(Step::Host(Halt::StepLimit(self.n_dispatched)))
    }

    /// `Object.prototype.hasOwnProperty(V)` (ECMA-262 20.1.3.2). Matches XS's
    /// `fx_Object_prototype_hasOwnProperty`: coerce the receiver first (so a
    /// `null`/`undefined` `this` throws a TypeError before the key is
    /// stringified), then `? ToPropertyKey(V)`, then whether the resulting
    /// object has `P` as an OWN property — `O.[[GetOwnProperty]](P) is not
    /// undefined`, never consulting the prototype chain.
    pub(in crate::interp) fn object_has_own_property(
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
    pub(in crate::interp) fn object_assign(
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
                                let id = self.read_key_intern(key)?;
                                if !self.mop_set(code, target_inst, id, value, to)? {
                                    return Err(self.failed_set_error(target_inst, id, "C: xsSet"));
                                }
                            }
                        }
                    }
                    _ => {
                        let id = self.read_key_intern(key)?;
                        if !self.mop_set(code, target_inst, id, value, to)? {
                            return Err(self.failed_set_error(target_inst, id, "C: xsSet"));
                        }
                    }
                }
            }
        }
        Ok(to)
    }

    /// Dispatch an `Object.*` static whose object operand is a **proxy**
    /// (ECMA-262 20.1.2.*), routing through the proxy-aware `mop_*` internal
    /// methods so the traps run and their invariants hold.
    pub(in crate::interp) fn object_static_proxy(
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

    /// Build a dense `Array` from a slot list (`CreateArrayFromList`).
    pub(in crate::interp) fn array_from_slots(&mut self, items: &[Slot]) -> Slot {
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
}
