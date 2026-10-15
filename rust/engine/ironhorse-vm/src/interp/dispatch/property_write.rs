//! Property write opcode semantics.
//! Return transfers unchanged; only the dispatch loop owns catch resumption.
use super::super::*;

impl Interp {
    /// `SET_PROPERTY`: the assigned value pushed, or a setter entered in
    /// place (STACK-DEPTH-REFACTOR.md C7), whose body to continue at; the loop
    /// sets where its frame returns, and the frame pushes the value.
    pub(super) fn dispatch_set_property(
        &mut self,
        code: &[u8],
        id: u16,
    ) -> Result<Option<usize>, Step> {
        let value = self.pop_checked()?;
        let obj = self.pop_checked()?;
        // A primitive base, matched on its KIND before the reference arm: a
        // primitive symbol's `Payload::Reference` is its DESCRIPTION slot,
        // not an instance, and must never be written through.
        if let Some(proto) = self.primitive_wrapper_proto(obj) {
            let accepted = match (self.primitive_set_in_place(code, obj, proto, id, value))? {
                SetInPlace::Done(accepted) => accepted,
                SetInPlace::Entered(body_start) => return Ok(Some(body_start)),
            };
            if !accepted && self.strict {
                return Err(self.failed_primitive_set_error(obj, proto, id));
            }
        } else if let Payload::Reference(inst) = obj.value {
            if self.proxies.contains_key(&inst) {
                // `p.k = v` routes through the `set` trap (ECMA-262
                // 10.5.9); a `false` result throws in strict mode.
                let accepted = (self.proxy_set(code, inst, id, value, obj))?;
                if !accepted && self.strict {
                    // XS ignores a false set-trap result here. Keep
                    // the spec strict rejection with an engine diagnostic.
                    let error =
                        self.internal_error("TypeError", "set: proxy trap returned false".into());
                    return Err(self.raise_js(error));
                }
            } else if self.arrays.contains_key(&inst)
                && !self.arguments_objects.contains(&inst)
                && self.scalar_key_text(id).as_deref() == Some("length")
            {
                // `arr.length = N`: the exotic-array length accessor
                // setter (`fxArrayLengthSetter` → `fxArraySetLength`).
                // Assignment must reject a non-writable property
                // even when `N` equals the current length; the
                // same-value allowance belongs only to
                // `DefineProperty`'s `ArraySetLength` path.
                if !self.array_length_writable(inst) {
                    if self.strict {
                        let error =
                            self.internal_error("TypeError", "set length: not writable".into());
                        return Err(self.raise_js(error));
                    }
                    self.push(value);
                    return Ok(None);
                }
                let accepted = (self.array_define_length(
                    code,
                    inst,
                    OrdinaryDescriptor {
                        value: Some(value),
                        ..OrdinaryDescriptor::default()
                    },
                ))?;
                if !accepted && self.strict {
                    // XS ignores the failed shrink result here; this
                    // spec strict rejection has no XS throw message.
                    let error = self.internal_error(
                        "TypeError",
                        "set length: array length update rejected".into(),
                    );
                    return Err(self.raise_js(error));
                }
            } else {
                let accepted = if self.typed_arrays.contains_key(&inst) {
                    // A typed array's own `[[Set]]`, whose element store
                    // coerces the value and so can re-enter, keeps the
                    // frames it had.
                    (self.mop_set(code, inst, id, value, obj))?
                } else {
                    match (self.set_property_in_place(code, inst, id, value, obj))? {
                        SetInPlace::Done(accepted) => accepted,
                        SetInPlace::Entered(body_start) => return Ok(Some(body_start)),
                    }
                };
                if !accepted {
                    // A frozen / non-writable property, or a new key on a
                    // non-extensible object: XS's `mxBehaviorSetProperty`
                    // stores nothing. A **sloppy** callee silently
                    // ignores the failed set (the assignment still
                    // evaluates to the RHS) — fully modeled, no
                    // allocation, so it meters nothing beyond its
                    // dispatch (verified against the pin). A **strict**
                    // callee throws a realm-local, catchable TypeError.
                    if self.strict {
                        return Err(self.failed_set_error(inst, id, "set"));
                    }
                }
            }
        } else if matches!(obj.kind, Kind::Null | Kind::Undefined) {
            // `null.f = v`: `mxToInstance(mxStack + 1)` throws before
            // the store (`fxToInstance`); the assignment is a
            // catchable `TypeError`, not a silent no-op.
            return Err(self.catchable_type_error_msg(cannot_coerce_to_object(obj.kind)));
        }
        self.push(value);
        Ok(None)
    }

    /// The wrapper prototype of a primitive base (ToObject's), or `None`
    /// for an object, `null` or `undefined`.
    pub(in crate::interp) fn primitive_wrapper_proto(
        &self,
        base: Slot,
    ) -> Option<crate::value::SlotIndex> {
        match base.kind {
            Kind::String => Some(self.string_proto),
            Kind::Integer | Kind::Number => Some(self.number_proto),
            Kind::Boolean => Some(self.boolean_proto),
            Kind::Symbol => Some(self.symbol_proto),
            Kind::BigInt => Some(self.bigint_proto),
            _ => None,
        }
    }

    /// Whether `id` names one of a primitive string's own properties, its
    /// `length` or an index below it: read-only, so a write refuses.
    pub(in crate::interp) fn string_owns_key(&self, base: Slot, id: u16) -> bool {
        let Payload::String(off) = base.value else {
            return false;
        };
        let Some(name) = self.scalar_key_text(id) else {
            return false;
        };
        let length = self.str_content(off).len() / 2;
        name == "length" || string_to_index(&name).is_some_and(|index| (index as usize) < length)
    }

    /// PutValue on a primitive base (ES2024 6.2.5.6): `ToObject(base).[[Set]]`
    /// with the primitive itself as the receiver. A string's own indices and
    /// `length` are read-only, so the write is refused; otherwise the
    /// wrapper prototype's chain answers, so an inherited setter or a Proxy
    /// `set` trap runs, and a new property is refused because the receiver
    /// is not an object (OrdinarySetWithOwnDescriptor step 2.c). A setter
    /// runs in place, as on an object.
    pub(super) fn primitive_set_in_place(
        &mut self,
        code: &[u8],
        base: Slot,
        proto: crate::value::SlotIndex,
        id: u16,
        value: Slot,
    ) -> Result<SetInPlace, Step> {
        if self.string_owns_key(base, id) {
            return Ok(SetInPlace::Done(false));
        }
        self.set_property_in_place(code, proto, id, value, base)
    }

    /// The strict TypeError for a refused primitive write, in XS's words: a
    /// string's own key and a new property are `not extensible`, an
    /// inherited read-only property `not writable`, a getter-only accessor
    /// `no setter`.
    pub(in crate::interp) fn failed_primitive_set_error(
        &mut self,
        base: Slot,
        proto: crate::value::SlotIndex,
        id: u16,
    ) -> Step {
        if self.string_owns_key(base, id) {
            let error = self.internal_error(
                "TypeError",
                format!("set {}: not extensible", self.property_debug_name(id)),
            );
            return self.raise_js(error);
        }
        self.failed_set_error(proto, id, "set")
    }

    pub(super) fn dispatch_delete_property(&mut self, code: &[u8], id: u16) -> Result<(), Step> {
        let obj = self.peek_checked()?;
        if obj.kind == Kind::EnvReference {
            // `EVAL_REFERENCE` pushes an `EnvReference` sentinel when the name
            // resolved to no object environment: NULL for a frame local, and
            // `SlotIndex(0)` for "the global object". Neither payload is an
            // instance index. `SlotIndex(0)` is the DEFAULT realm's global only
            // by construction accident -- `Interp::new` happens to allocate it
            // first -- so matching on `obj.value` alone took the sentinel for a
            // live instance and deleted from that realm whatever environment
            // was actually current. Harmless while only the host could mint a
            // second environment; a cross-realm mutation as soon as guest code
            // can run in a compartment. Resolve against the CURRENT environment.
            self.meter.tick_builtin();
            let deleted = if self.environment.global_lexicals.contains_key(&id) {
                // A `globalLexicals` entry is a binding in a scope, not a
                // property of the global object: `delete` cannot remove it,
                // and must not answer `true` as though it had.
                false
            } else if matches!(obj.value, Payload::Reference(i) if i == crate::value::SlotIndex::NULL)
            {
                // A frame-local declarative binding is likewise not deletable.
                false
            } else {
                self.delete_own_property(self.environment.global_obj, id)
            };
            if !deleted && self.strict {
                let error = self.internal_error(
                    "TypeError",
                    format!(
                        "delete {}: no permission (strict mode)",
                        self.property_debug_name(id)
                    ),
                );
                return Err(self.raise_js(error));
            }
            if let Some(s) = self.stack.last_mut() {
                *s = Slot::boolean(deleted);
            }
            return Ok(());
        }
        match obj.value {
            Payload::Reference(inst) => {
                // `fxRunDelete` wraps `mxBehaviorDeleteProperty`
                // in a host frame (`fxBeginHost`/`fxEndHost`),
                // whose teardown meters one built-in step
                // (`mxMeterOne`) — measured against the pin as
                // exactly `XS_BUILTIN_METERING` over the
                // allocation-free unlink.
                self.meter.tick_builtin();
                let deleted = if self.proxies.contains_key(&inst) {
                    // `delete p.k` routes through the
                    // `deleteProperty` trap (ECMA-262 10.5.10).
                    (self.proxy_delete(code, inst, id))?
                } else if self.arrays.contains_key(&inst)
                    && !self.arguments_objects.contains(&inst)
                    && self.scalar_key_text(id).as_deref() == Some("length")
                {
                    false
                } else {
                    self.delete_own_property(inst, id)
                };
                // A strict `delete` of a non-configurable own
                // property throws a realm-local, catchable
                // `TypeError` (XS's `fxRunDelete` on a `false` from
                // `mxBehaviorDeleteProperty`). A sloppy `delete`
                // yields `false` (fully modeled below).
                if !deleted && self.strict {
                    let error = self.internal_error(
                        "TypeError",
                        format!(
                            "delete {}: no permission (strict mode)",
                            self.property_debug_name(id)
                        ),
                    );
                    return Err(self.raise_js(error));
                }
                if let Some(s) = self.stack.last_mut() {
                    *s = Slot::boolean(deleted);
                }
            }
            _ if obj.kind == Kind::Null || obj.kind == Kind::Undefined => {
                return Err(self.catchable_type_error_msg(cannot_coerce_to_object(obj.kind)))
            }
            // ToObject succeeds for every other primitive. Such a
            // temporary wrapper has no configurable own property
            // with this identifier, so deletion succeeds.
            _ => {
                if let Some(s) = self.stack.last_mut() {
                    *s = Slot::boolean(true);
                }
            }
        }
        Ok(())
    }

    pub(super) fn dispatch_delete_property_at(&mut self, code: &[u8]) -> Result<(), Step> {
        let key = self.pop_checked()?;
        let obj = self.pop_checked()?;
        let (id, index) = match key.value {
            Payload::At(id, index) => (id, index),
            _ => return Err(Step::Host(Halt::EngineInvariant("delete_property_at:key"))),
        };
        let numeric_index = (id == crate::value::XS_NO_ID).then_some(index);
        // The integer-indexed exotic `[[Delete]]` (10.4.5.7): a
        // canonical numeric index the view can address cannot be
        // deleted (a valid index is `false`); an invalid one is a
        // vacuous `true`.
        let ta_delete = self
            .typed_arrays
            .get(&match obj.value {
                Payload::Reference(inst) => inst,
                _ => crate::value::SlotIndex::NULL,
            })
            .copied()
            .and_then(|ta| {
                self.ta_numeric_index_at(id, index)
                    .map(|n| self.ta_valid_index(ta, n).is_none())
            });
        // A delete creates nothing either, so an index the key
        // table has never held is never minted: `None` here means
        // no ordinary own slot can exist under it, which makes the
        // delete a vacuous `true` (XS passes `(id, index)` to
        // `mxBehaviorDeleteProperty` and mints no key).
        let id = if id == crate::value::XS_NO_ID {
            self.index_read_key_id(index)
        } else {
            Some(id)
        };
        let deleted = match obj.value {
            Payload::Reference(_) if ta_delete.is_some() => {
                self.meter.tick_builtin();
                ta_delete.unwrap()
            }
            Payload::Reference(inst) => {
                self.meter.tick_builtin();
                if self.proxies.contains_key(&inst) {
                    (match id {
                        Some(id) => self.proxy_delete(code, inst, id),
                        None => self.uninterned_index_proxy_delete(code, inst, index),
                    })?
                } else if let Some(index) =
                    numeric_index.filter(|_| self.arrays.contains_key(&inst))
                {
                    if let Some(item) = self.arrays[&inst].items().get(&index) {
                        if item.flag & XS_DONT_DELETE_FLAG != 0 {
                            false
                        } else {
                            self.arrays.get_mut(&inst).unwrap().remove_item(
                                &index,
                                &mut self.side_refs,
                                &mut self.chunks,
                            );
                            true
                        }
                    } else {
                        id.is_none_or(|id| self.delete_own_property(inst, id))
                    }
                } else if id.is_some_and(|id| {
                    self.arrays.contains_key(&inst)
                        && !self.arguments_objects.contains(&inst)
                        && self.scalar_key_text(id).as_deref() == Some("length")
                }) {
                    false
                } else if numeric_index.is_some_and(|index| {
                    match self.wrapper_data.get(&inst).copied() {
                        Some(Slot {
                            kind: Kind::String,
                            value: Payload::String(off),
                            ..
                        }) => (index as usize) < self.str_len(off),
                        _ => false,
                    }
                }) {
                    // A String wrapper's units are non-configurable,
                    // and this arm never consulted them: `delete
                    // (new String("hi"))[0]` answered `true` where
                    // XS's `fxStringDeleteProperty` refuses on
                    // exactly this branch (`!id && index < length`).
                    // `Reflect.deleteProperty` already refused it
                    // through `mop_delete`, so the two disagreed.
                    false
                } else if let Some((index, item)) = numeric_index
                    .and_then(|index| self.index_prop_item(inst, index).map(|item| (index, item)))
                {
                    // An ordinary object's index property lives in
                    // the index store; `delete_own_property` walks
                    // only the slot chain and would report a
                    // vacuous `true` while leaving it in place —
                    // the same two-spellings split, since
                    // `Reflect.deleteProperty` goes through
                    // `mop_delete` and removed it correctly.
                    if item.flag & XS_DONT_DELETE_FLAG != 0 {
                        false
                    } else {
                        self.index_prop_remove(inst, index);
                        true
                    }
                } else {
                    id.is_none_or(|id| self.delete_own_property(inst, id))
                }
            }
            _ if obj.kind == Kind::Null || obj.kind == Kind::Undefined => {
                return Err(self.catchable_type_error_msg(cannot_coerce_to_object(obj.kind)))
            }
            // String wrapper index properties are non-configurable.
            Payload::String(off) if numeric_index.is_some() => {
                numeric_index.unwrap() as usize >= self.str_len(off)
            }
            _ => true,
        };
        if !deleted && self.strict {
            let error = self.internal_error(
                "TypeError",
                format!(
                    "delete {}: no permission (strict mode)",
                    self.property_debug_name(id.unwrap_or(0))
                ),
            );
            return Err(self.raise_js(error));
        }
        self.push(Slot::boolean(deleted));
        Ok(())
    }

    /// Whether a NEW_PROPERTY is the compiler's `caller` define on a sloppy
    /// async function, which this departure drops: an async function has
    /// no own `caller` (ECMA-262 17.1, Forbidden Extensions). XS's compiler
    /// defines `caller` (undefined, non-enumerable) on every sloppy plain
    /// function, async ones included, and Ironhorse's compiler keeps XS's
    /// bytes. Only that define matches: its value and attributes, onto a
    /// function whose [[Prototype]] is still %AsyncFunction.prototype%, as
    /// it is between ASYNC_FUNCTION and the define.
    fn is_async_function_caller_define(
        &mut self,
        inst: crate::value::SlotIndex,
        id: u16,
        value: Slot,
        property_flag: u8,
    ) -> bool {
        property_flag == XS_DONT_ENUM_FLAG
            && value.kind == Kind::Undefined
            && self.instance_prototype(inst) == self.async_function_proto
            && self.functions.contains_key(&inst)
            && id == self.intern_static_key("caller")
    }

    pub(super) fn dispatch_new_property(
        &mut self,
        code: &[u8],
        id: u16,
        property_flag: u8,
    ) -> Result<(), Step> {
        let value = self.pop_checked()?;
        let obj = self.pop_checked()?;
        if let Payload::Reference(inst) = obj.value {
            if self.is_async_function_caller_define(inst, id, value, property_flag) {
                return Ok(());
            }
            if property_flag & (XS_GETTER_FLAG | XS_SETTER_FLAG) != 0 {
                if property_flag & XS_METHOD_FLAG != 0 {
                    if let Payload::Reference(f) = value.value {
                        self.functions.update(&f, |info| {
                            info.home = inst;
                        });
                    }
                }
                let existing = self.accessors.get(&(inst, id)).copied().unwrap_or_default();
                let accessor = AccessorData {
                    get: if property_flag & XS_GETTER_FLAG != 0 {
                        Some(value)
                    } else {
                        existing.get
                    },
                    set: if property_flag & XS_SETTER_FLAG != 0 {
                        Some(value)
                    } else {
                        existing.set
                    },
                };
                self.accessors.insert((inst, id), accessor);
                if let Some(property) = self.find_property(inst, id) {
                    self.slots.get_mut(property).flag |= XS_GETTER_FLAG | XS_SETTER_FLAG;
                } else {
                    let descriptor = OrdinaryDescriptor {
                        get: Some(accessor.get.unwrap_or_else(Slot::undefined)),
                        set: Some(accessor.set.unwrap_or_else(Slot::undefined)),
                        enumerable: Some(property_flag & XS_DONT_ENUM_FLAG == 0),
                        configurable: Some(property_flag & XS_DONT_DELETE_FLAG == 0),
                        ..OrdinaryDescriptor::default()
                    };
                    self.ordinary_define_own_property(inst, id, descriptor);
                }
                self.meter.tick_builtin();
                return Ok(());
            }
            // `fxRunDefine` creating a data property: one
            // built-in step plus the property-slot allocation.
            // A later data member with the same literal key must
            // replace an earlier accessor member completely.
            // DefineOwnProperty charges the slot and non-default key. Literal
            // definitions retain the calibrated flat charge for default keys.
            if self.find_property(inst, id).is_none()
                && self.default_keys.contains(self.id_name(id).as_str())
            {
                self.meter.tick_raw(PROPERTY_CREATE_REMAINDER);
            }
            if !self.mop_define_own_property(
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
            )? {
                return Err(self.define_rejected_error(Some(id)));
            }
            if let Some(property) = self.find_property(inst, id) {
                self.slots.get_mut(property).flag =
                    property_flag & (XS_DONT_DELETE_FLAG | XS_DONT_ENUM_FLAG | XS_DONT_SET_FLAG);
            }
            if property_flag & XS_METHOD_FLAG != 0 {
                if let Payload::Reference(f) = value.value {
                    self.functions.update(&f, |info| {
                        info.home = inst;
                    });
                }
            }
            self.meter.tick_builtin();
            // An object-literal generator method (`{ *m(){} }`)
            // compiles the value as an ANONYMOUS `GENERATOR_FUNCTION`
            // renamed here by `fxRenameFunction` (`XS_METHOD` define
            // flag), charging two built-in steps — XS does this for a
            // generator method but not a plain `{ m(){} }` (which is
            // already bit-exact without it). Name it and charge the
            // rename so the method's `.name`/computrons match.
            if let Payload::Reference(f) = value.value {
                let needs_rename = self
                    .functions
                    .get(&f)
                    .map(|fi| fi.is_generator && fi.name.is_empty())
                    .unwrap_or(false);
                if needs_rename {
                    self.meter.tick_builtin_some(2);
                    let fname = (id as usize)
                        .checked_sub(1)
                        .and_then(|i| self.symbol_names.get(i).cloned())
                        .unwrap_or_default();
                    let name_chunk = self.chunks.alloc(&units_to_be16(&fname.to_units()));
                    self.functions.update(&f, |fi| {
                        fi.name = fname.to_string();
                        fi.name_chunk = name_chunk;
                    });
                }
            }
        }
        Ok(())
    }

    pub(super) fn dispatch_new_property_at(
        &mut self,
        code: &[u8],
        property_flag: u8,
    ) -> Result<(), Step> {
        let value = self.pop_checked()?;
        let key = self.pop_checked()?;
        let obj = self.pop_checked()?;

        let handled_class_member = match (obj.value, key.value) {
            (Payload::Reference(inst), Payload::At(raw_id, index))
                if property_flag & (XS_METHOD_FLAG | XS_GETTER_FLAG | XS_SETTER_FLAG) != 0 =>
            {
                let id = if raw_id == crate::value::XS_NO_ID {
                    self.intern_key(index.to_string())?
                } else {
                    raw_id
                };
                if property_flag & XS_METHOD_FLAG != 0 {
                    if let Payload::Reference(f) = value.value {
                        self.functions.update(&f, |info| {
                            info.home = inst;
                        });
                    }
                }
                let defined = if property_flag & (XS_GETTER_FLAG | XS_SETTER_FLAG) != 0 {
                    let previous = self.accessors.get(&(inst, id)).copied();
                    let current = previous.unwrap_or_default();
                    let accessor = AccessorData {
                        get: if property_flag & XS_GETTER_FLAG != 0 {
                            Some(value)
                        } else {
                            current.get
                        },
                        set: if property_flag & XS_SETTER_FLAG != 0 {
                            Some(value)
                        } else {
                            current.set
                        },
                    };
                    self.accessors.insert((inst, id), accessor);
                    let defined = self.ordinary_define_own_property(
                        inst,
                        id,
                        OrdinaryDescriptor {
                            get: Some(accessor.get.unwrap_or_else(Slot::undefined)),
                            set: Some(accessor.set.unwrap_or_else(Slot::undefined)),
                            enumerable: Some(property_flag & XS_DONT_ENUM_FLAG == 0),
                            configurable: Some(property_flag & XS_DONT_DELETE_FLAG == 0),
                            ..OrdinaryDescriptor::default()
                        },
                    );
                    if !defined {
                        // Leave the refused key's accessor record as it was.
                        match previous {
                            Some(previous) => self.accessors.insert((inst, id), previous),
                            None => self.accessors.remove(&(inst, id)),
                        };
                    }
                    defined
                } else {
                    self.ordinary_define_own_property(
                        inst,
                        id,
                        OrdinaryDescriptor {
                            value: Some(value),
                            writable: Some(property_flag & XS_DONT_SET_FLAG == 0),
                            enumerable: Some(property_flag & XS_DONT_ENUM_FLAG == 0),
                            configurable: Some(property_flag & XS_DONT_DELETE_FLAG == 0),
                            ..OrdinaryDescriptor::default()
                        },
                    )
                };
                self.meter.tick_builtin();
                // A static member named `prototype` meets the constructor's
                // non-configurable `prototype` (ClassDefinitionEvaluation's
                // DefineMethodProperty, ES2024 15.4.4).
                if !defined {
                    return Err(self.define_rejected_error(Some(id)));
                }
                true
            }
            _ => false,
        };
        if !handled_class_member {
            (self.property_at_set(code, obj, key, value, true))?;
            // Compact array elements live outside the ordinary
            // property chain; carry the compiler's descriptor
            // flags on their value slots (tagged-template cooked
            // and raw elements arrive non-writable and
            // non-configurable here).
            if let (Payload::Reference(inst), Payload::At(crate::value::XS_NO_ID, index)) =
                (obj.value, key.value)
            {
                if let Some(array) = self.arrays.get_mut(&inst) {
                    array.set_item_flag(index, property_flag);
                }
            }
        }
        Ok(())
    }
}
