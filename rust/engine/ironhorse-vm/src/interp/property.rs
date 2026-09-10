//! Property keys, descriptors, indexed storage, proxy traps, and object integrity.
use super::*;

mod descriptors;
mod indexed;
mod integrity;
mod keys;
mod object;
mod ordinary;
mod proxy;
mod read_index;

impl Interp {
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
                    Ok(vm.array_define_index(inst, id, index, desc)?)
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
        let id = self.intern_key_unmetered(index.to_string())?;
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
                self.intern_key(index.to_string())?
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
                self.intern_key(index.to_string())?
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
                        let _ = self.array_define_index(inst, Some(key_id), index, descriptor)?;
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
                let id = self.intern_key(index.to_string())?;
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

    // ---- the `mop_*` dispatchers: an object's internal method, proxy-aware ---
    //
    // Every internal method is a **light frame** of the native-recursion
    // budget: a Proxy with an absent trap forwards the same internal method
    // to its target, an exotic prototype (a Proxy, an array, a function, a
    // wrapper) is reached through the parent's full `[[Get]]`/`[[Set]]`, and
    // a trap that runs guest code comes back in through the same entries — so
    // each of these is where a guest-shaped chain recurses on the host stack.
    // The `_inner` body is the internal method; the guarded entry charges
    // [`LIGHT_FRAME_COST`] around it and halts with [`Halt::ReentryLimit`]
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
            let length_id = self.intern_static_key("length");
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
            let length_id = self.intern_static_key("length");
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
            let length_id = self.intern_static_key("length");
            let name_id = self.intern_static_key("name");
            let prototype_id = self.intern_static_key("prototype");
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
}
