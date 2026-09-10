//! Error objects, stack rendering, and catchable error construction.
use super::*;

impl Interp {
    /// Build a fresh Error instance of type `name` from a native Error
    /// constructor call/construct (`fx_Error`). Meters the construct cost
    /// (the native `Object` object cost plus [`ERROR_CONSTRUCT_EXTRA`]) and,
    /// when a message argument is present, ToString's it into an own
    /// `message` property ([`ERROR_MESSAGE_METERING`]). Records the
    /// construction metadata in [`Self::error_data`] for snapshot compatibility;
    /// live properties, not that original metadata, determine display text.
    /// The frame-name chain an error captures at construction (XS's
    /// `fxCaptureErrorStack` recording): the current activation's function
    /// name, each suspended caller's, then the empty program frame. A
    /// non-function level (the program scope) contributes nothing beyond
    /// the final empty frame.
    pub(super) fn capture_error_frames(&self) -> Vec<String> {
        let mut frames = Vec::new();
        if let Some(fi) = self.functions.get(&self.cur_func) {
            frames.push(fi.name.clone());
        }
        for state in self.call_stack.iter().rev() {
            if let Some(fi) = self.functions.get(&state.cur_func) {
                frames.push(fi.name.clone());
            }
        }
        frames.push(String::new());
        frames
    }

    pub(super) fn build_error(&mut self, name: &'static str, base: usize, argc: usize) -> Slot {
        // Raw bytecode runners may never link intrinsic property keys. Install
        // the boot names once before constructing their first error. Linked
        // realms already have this key, so guest deletions remain authoritative.
        if !self.symbol_ids.contains_key("name") {
            let id = self.intern_static_key_unmetered("name");
            let data = std::mem::take(&mut self.proto_data);
            for (proto, property, value) in &data {
                if *property == "name" {
                    let off = self.alloc_str_text(value.as_bytes());
                    self.set_own_unmetered_with_flag(
                        *proto,
                        id,
                        Slot::of(Kind::String, Payload::String(off)),
                        XS_DONT_ENUM_FLAG,
                    );
                }
            }
            self.proto_data = data;
        }
        // Base object cost, exactly as the native `Object` constructor
        // (`tick_builtin` + `fxNewObject`), plus the error-instance extra.
        self.meter.tick_builtin();
        let inst = self.new_object();
        self.meter.tick_raw(ERROR_CONSTRUCT_EXTRA);
        // Chain the error instance to its type's `%<Type>.prototype%` (so
        // `err instanceof TypeError` / `instanceof Error` hold) rather than
        // the plain `%Object.prototype%` `new_object` defaulted it to.
        if let Some(proto) = self
            .intrinsics
            .get(name)
            .and_then(|&c| self.prototype_of(c))
        {
            self.slots.get_mut(inst).value = Payload::Reference(proto);
        }
        // The message argument: absent or `undefined` ⇒ no own message (XS
        // inherits `Error.prototype.message == ""`).
        let message: Option<String> = if argc >= 1 {
            let a = self
                .stack
                .get(base + 4)
                .copied()
                .unwrap_or_else(Slot::undefined);
            if a.kind == Kind::Undefined {
                None
            } else {
                let bytes = self.to_string_bytes_metered(a);
                self.meter.tick_raw(ERROR_MESSAGE_METERING);
                Some(String::from_utf8_lossy(&bytes).into_owned())
            }
        } else {
            None
        };
        let frames = self.capture_error_frames();
        self.error_data.insert(
            inst,
            ErrorInfo {
                name,
                message: message.clone(),
                frames,
            },
        );
        // An own `message` property only when a message argument was given
        // (XS): a no-argument error inherits `message == ""` from the
        // prototype. `name` is always inherited from the prototype, never own
        // — so `err.hasOwnProperty('name')` is `false`, matching XS. Both are
        // set unmetered (the own message slot cost is folded into the
        // measured construct constants). The key is INTERNED, not looked up:
        // XS's key table is machine-global ("message" is a boot key), so the
        // own property exists whether or not the constructing crank ever
        // compiled the name — a later crank's `e.message` must resolve
        // (locked by `error_own_properties.rs`).
        if let Some(text) = message {
            let mid = self.intern_static_key_unmetered("message");
            let off = self.alloc_str_text(text.as_bytes());
            self.set_own_unmetered_with_flag(
                inst,
                mid,
                Slot::of(Kind::String, Payload::String(off)),
                XS_DONT_ENUM_FLAG,
            );
        }
        // `InstallErrorCause`: when the options object has a `cause`
        // property, copy its value to a writable, non-enumerable,
        // configurable own property on the new realm-local Error instance.
        if argc >= 2 {
            let options = self
                .stack
                .get(base + 5)
                .copied()
                .unwrap_or_else(Slot::undefined);
            if let (Payload::Reference(options), Some(&cause_id)) =
                (options.value, self.symbol_ids.get("cause"))
            {
                if self.instance_has(options, cause_id).0 {
                    let cause = self.instance_get(options, cause_id);
                    self.set_own_unmetered_with_flag(inst, cause_id, cause, XS_DONT_ENUM_FLAG);
                }
            }
        }
        Slot::of(Kind::Reference, Payload::Reference(inst))
    }

    /// Construct an Error-family value from an observable native call.
    /// Unlike the internal-error path above, the public constructors perform
    /// `ToString(message)`, `HasProperty(options, "cause")`, and
    /// `Get(options, "cause")` through the ordinary call/MOP seams so guest
    /// accessors and proxies run in specification order.
    pub(super) fn build_native_error(
        &mut self,
        code: &[u8],
        name: &'static str,
        base: usize,
        argc: usize,
    ) -> Result<Slot, Step> {
        self.meter.tick_builtin();
        let inst = self.new_object();
        self.meter.tick_raw(ERROR_CONSTRUCT_EXTRA);
        if let Some(proto) = self
            .intrinsics
            .get(name)
            .and_then(|&constructor| self.prototype_of(constructor))
        {
            self.slots.get_mut(inst).value = Payload::Reference(proto);
        }

        let message_units = if argc >= 1 {
            let argument = self
                .stack
                .get(base + 4)
                .copied()
                .unwrap_or_else(Slot::undefined);
            if argument.kind == Kind::Undefined {
                None
            } else {
                let units = self.to_string_units(code, argument)?;
                self.meter.tick_raw(ERROR_MESSAGE_METERING);
                Some(units)
            }
        } else {
            None
        };
        let frames = self.capture_error_frames();
        self.error_data.insert(
            inst,
            ErrorInfo {
                name,
                message: message_units
                    .as_ref()
                    .map(|units| String::from_utf16_lossy(units)),
                frames,
            },
        );
        if let Some(units) = message_units {
            let message_id = self.intern_static_key_unmetered("message");
            let offset = self.chunks.alloc(&units_to_be16(&units));
            self.set_own_unmetered_with_flag(
                inst,
                message_id,
                Slot::of(Kind::String, Payload::String(offset)),
                XS_DONT_ENUM_FLAG,
            );
        }

        if argc >= 2 {
            let options = self
                .stack
                .get(base + 5)
                .copied()
                .unwrap_or_else(Slot::undefined);
            self.install_error_cause(code, inst, options)?;
        }
        Ok(Slot::of(Kind::Reference, Payload::Reference(inst)))
    }

    /// `InstallErrorCause(O, options)` for an already-created Error object.
    /// Primitive options are ignored. Object options use the full MOP so an
    /// inherited cause, accessor, or Proxy trap is observable.
    pub(super) fn install_error_cause(
        &mut self,
        code: &[u8],
        error: crate::value::SlotIndex,
        options: Slot,
    ) -> Result<(), Step> {
        let options_ref = match options.value {
            Payload::Reference(options_ref) if options.kind == Kind::Reference => options_ref,
            _ => return Ok(()),
        };
        let cause_id = self.intern_static_key_unmetered("cause");
        if self.mop_has(code, options_ref, cause_id)? {
            let cause = self.mop_get(code, options_ref, cause_id, options)?;
            self.set_own_unmetered_with_flag(error, cause_id, cause, XS_DONT_ENUM_FLAG);
        }
        Ok(())
    }

    /// An engine-internal error with a diagnostic message. Callers supply
    /// oracle-pinned text where available and profile-specific diagnostics
    /// otherwise. Built exactly like
    /// `build_error(name, 0, 0)` — same object geometry, prototype chain, and
    /// meter charge — then augmented with the message in construction metadata
    /// and as a real own non-enumerable `message` property (so `err.message`
    /// is observable exactly as XS's thrown error's is). The message is set
    /// **unmetered** — no `ERROR_MESSAGE_METERING` charge — so a program that
    /// throws-and-catches an internal error meters identically to before this
    /// text existed (the oracle's own message construction is likewise off the
    /// metered opcode path, `fxThrowMessage` after `mxSaveState`).
    pub(super) fn internal_error(&mut self, name: &'static str, message: String) -> Slot {
        let err = self.build_error(name, 0, 0);
        if let Payload::Reference(inst) = err.value {
            if let Some(info) = self.error_data.get_mut(&inst) {
                info.message = Some(message.clone());
            }
            let mid = self.intern_static_key_unmetered("message");
            let off = self.alloc_str_text(message.as_bytes());
            self.set_own_unmetered_with_flag(
                inst,
                mid,
                Slot::of(Kind::String, Payload::String(off)),
                XS_DONT_ENUM_FLAG,
            );
        }
        err
    }

    /// The source name of a program symbol `id` (XS's `fxIDToString` for the
    /// variable/property diagnostics), `symbol_names[id - 1]`. An id past the
    /// table (never expected for a resolved variable operand) renders empty.
    pub(super) fn id_name(&self, id: u16) -> String {
        self.symbol_names
            .get((id as usize).saturating_sub(1))
            .map(ToString::to_string)
            .unwrap_or_default()
    }

    /// Construct `SuppressedError(error, suppressed, message)`. Disposal
    /// chaining uses the first two fields directly (and passes no
    /// message); ordinary constructor calls share the same realm
    /// prototype and non-enumerable own fields, and ToString a present,
    /// non-undefined message argument exactly as `build_error` does
    /// (metered — XS's `fx_Error_aux` message path). The field keys are
    /// INTERNED, not looked up: XS's key table is machine-global, so
    /// the own properties exist whether or not the constructing crank
    /// compiled the names (locked by `error_own_properties.rs`).
    pub(super) fn build_suppressed_error(
        &mut self,
        error: Slot,
        suppressed: Slot,
        message_arg: Option<Slot>,
    ) -> Slot {
        let inst = self.new_object();
        if let Some(proto) = self
            .intrinsics
            .get("SuppressedError")
            .and_then(|&c| self.prototype_of(c))
        {
            self.slots.get_mut(inst).value = Payload::Reference(proto);
        }
        let message: Option<String> = match message_arg {
            Some(a) if a.kind != Kind::Undefined => {
                let bytes = self.to_string_bytes_metered(a);
                self.meter.tick_raw(ERROR_MESSAGE_METERING);
                Some(String::from_utf8_lossy(&bytes).into_owned())
            }
            _ => None,
        };
        let frames = self.capture_error_frames();
        self.error_data.insert(
            inst,
            ErrorInfo {
                name: "SuppressedError",
                // This branch's fix (the SuppressedError message was
                // dropped) composes with the base's new stack frames:
                // both fields are wanted.
                message: message.clone(),
                frames,
            },
        );
        if let Some(text) = message {
            let mid = self.intern_static_key_unmetered("message");
            let off = self.alloc_str_text(text.as_bytes());
            self.set_own_unmetered_with_flag(
                inst,
                mid,
                Slot::of(Kind::String, Payload::String(off)),
                XS_DONT_ENUM_FLAG,
            );
        }
        for (name, value) in [("error", error), ("suppressed", suppressed)] {
            let id = self.intern_static_key_unmetered(name);
            self.set_own_unmetered_with_flag(inst, id, value, XS_DONT_ENUM_FLAG);
        }
        Slot::of(Kind::Reference, Payload::Reference(inst))
    }

    /// Install the shared non-enumerable, writable, configurable `errors`
    /// array after each caller has charged its own construction path.
    pub(super) fn install_aggregate_errors(
        &mut self,
        inst: crate::value::SlotIndex,
        errors: Vec<Slot>,
    ) {
        let n = errors.len();
        let arr_inst = self.slots.alloc(Slot::instance(self.array_proto));
        let mut arr_data = ArrayData::default();
        for (i, mut v) in errors.into_iter().enumerate() {
            v.id = 0;
            v.next = crate::value::SlotIndex::NULL;
            arr_data.insert_item(i as u32, v, &mut self.side_refs);
        }
        arr_data.length = n as u32;
        self.arrays.insert(arr_inst, arr_data);
        let eid = self.intern_static_key_unmetered("errors");
        self.set_own_unmetered_with_flag(
            inst,
            eid,
            Slot::of(Kind::Reference, Payload::Reference(arr_inst)),
            XS_DONT_ENUM_FLAG,
        );
    }

    /// `new AggregateError(errors, message)` (`fx_AggregateError`): the base
    /// error (name "AggregateError", message from arg **1**), plus an own
    /// `errors` Array built by iterating arg 0. XS builds the base with
    /// `fx_Error_aux(..., 1)`, then a fresh Array instance whose elements are
    /// copied from the `fxGetIterator`/`fxIteratorNext` walk of arg 0. Message
    /// conversion and cause installation precede iterator acquisition.
    pub(super) fn build_aggregate_error(
        &mut self,
        code: &[u8],
        base: usize,
        argc: usize,
    ) -> Result<Slot, Step> {
        let errors_slot = self
            .stack
            .get(base + 4)
            .copied()
            .unwrap_or_else(Slot::undefined);
        // The base error (identical to `build_error` but the message is arg 1,
        // XS's `fx_Error_aux(..., 1)`).
        self.meter.tick_builtin();
        let inst = self.new_object();
        self.meter.tick_raw(ERROR_CONSTRUCT_EXTRA);
        if let Some(proto) = self
            .intrinsics
            .get("AggregateError")
            .and_then(|&c| self.prototype_of(c))
        {
            self.slots.get_mut(inst).value = Payload::Reference(proto);
        }
        let message_units: Option<Vec<u16>> = if argc >= 2 {
            let a = self
                .stack
                .get(base + 5)
                .copied()
                .unwrap_or_else(Slot::undefined);
            if a.kind == Kind::Undefined {
                None
            } else {
                let units = self.to_string_units(code, a)?;
                self.meter.tick_raw(ERROR_MESSAGE_METERING);
                Some(units)
            }
        } else {
            None
        };
        let frames = self.capture_error_frames();
        self.error_data.insert(
            inst,
            ErrorInfo {
                name: "AggregateError",
                message: message_units
                    .as_ref()
                    .map(|units| String::from_utf16_lossy(units)),
                frames,
            },
        );
        if let Some(units) = message_units {
            // Interned, not looked up — the machine-global key rule
            // `build_error` documents.
            let mid = self.intern_static_key_unmetered("message");
            let off = self.chunks.alloc(&units_to_be16(&units));
            self.set_own_unmetered_with_flag(
                inst,
                mid,
                Slot::of(Kind::String, Payload::String(off)),
                XS_DONT_ENUM_FLAG,
            );
        }
        if argc >= 3 {
            let options = self
                .stack
                .get(base + 6)
                .copied()
                .unwrap_or_else(Slot::undefined);
            self.install_error_cause(code, inst, options)?;
        }
        let err_elems = self.aggregate_error_elements(code, errors_slot)?;
        // The `errors` Array (`fxNewArrayInstance` + the copied elements +
        // `fxCacheArray`) plus the `fxGetIterator`/`fxIteratorNext` walk cost.
        let n = err_elems.len() as u64;
        self.charge_and_check(AGGREGATE_ERROR_EXTRA + n * AGGREGATE_ERROR_PER_ELEMENT)?;
        self.install_aggregate_errors(inst, err_elems);
        Ok(Slot::of(Kind::Reference, Payload::Reference(inst)))
    }

    /// `IterableToList(errors)` for `AggregateError`. Preserve the calibrated
    /// dense-Array path only when the observable iterator operations still
    /// resolve to the intrinsic Array iterator; sparse/custom inputs take the
    /// full protocol path.
    pub(super) fn aggregate_error_elements(
        &mut self,
        code: &[u8],
        errors: Slot,
    ) -> Result<Vec<Slot>, Step> {
        if let Payload::Reference(array) = errors.value {
            if errors.kind == Kind::Reference
                && self.arrays.contains_key(&array)
                && !self.arguments_objects.contains(&array)
            {
                let iterator_id = self
                    .well_known_symbol_property_id("iterator")
                    .expect("well-known iterator symbol");
                let next_id = self.intern_static_key("next");
                let return_id = self.intern_static_key("return");
                let intrinsic_protocol = self.chain_resolves_native_data_method(
                    array,
                    iterator_id,
                    NativeMethod::ArrayValues,
                ) && self.chain_resolves_native_data_method(
                    self.array_iterator_proto,
                    next_id,
                    NativeMethod::ArrayIteratorNext,
                ) && !self
                    .chain_has_descriptor(self.array_iterator_proto, return_id);
                let dense = {
                    let data = &self.arrays[&array];
                    data.items().len() == data.length as usize
                };
                if intrinsic_protocol && dense {
                    let length = self.arrays[&array].length;
                    let buffer = self.reserve_work_scratch(length as usize)?;
                    let data = &self.arrays[&array];
                    return Ok(Self::fill_scratch(
                        buffer,
                        (0..length).map(|index| self.array_item_value(array, data.items()[&index])),
                    ));
                }
            }
        }
        self.iterable_to_list(code, errors)
    }

    /// `Error.prototype.toString` over an arbitrary object receiver. The
    /// method reads inherited `name`/`message` properties and applies the
    /// shared string-hint primitive conversion, rather than consulting the
    /// native Error side table (the method is intentionally generic).
    pub(super) fn error_to_string(&mut self, code: &[u8], this: Slot) -> Result<Vec<u16>, Step> {
        let inst = match this.value {
            Payload::Reference(inst) if this.kind == Kind::Reference => inst,
            _ => return Err(self.catchable_type_error_msg("this: not an object".into())),
        };
        let name_id = self.intern_static_key_unmetered("name");
        let message_id = self.intern_static_key_unmetered("message");
        let name_value = self.mop_get(code, inst, name_id, this)?;
        let name = if name_value.kind == Kind::Undefined {
            "Error".encode_utf16().collect()
        } else {
            self.to_string_units(code, name_value)?
        };
        let message_value = self.mop_get(code, inst, message_id, this)?;
        let message = if message_value.kind == Kind::Undefined {
            Vec::new()
        } else {
            self.to_string_units(code, message_value)?
        };
        if name.is_empty() {
            Ok(message)
        } else if message.is_empty() {
            Ok(name)
        } else {
            let mut result = self.reserve_scratch(name.len() + message.len() + 2)?;
            result.extend_from_slice(&name);
            result.extend_from_slice(&[':' as u16, ' ' as u16]);
            result.extend_from_slice(&message);
            Ok(result)
        }
    }

    /// Raise a RangeError diagnostic through the guest jump chain.
    pub(super) fn catchable_range_error_msg(&mut self, message: String) -> Step {
        let error = self.internal_error("RangeError", message);
        self.raise_js(error)
    }
}
