//! The Annex B members XS ships (ECMA-262 Annex B.2), ported from
//! `c/moddable/xs/sources`: `%Object.prototype%`'s `__proto__` accessor and
//! legacy accessor helpers (`xsObject.c`), and the `escape` and `unescape`
//! globals (`xsGlobal.c`).
use super::super::*;

const HEX_UPPER: &[u8; 16] = b"0123456789ABCDEF";

/// `escape`'s unescaped set: the ASCII word characters and `@*_+-./`.
fn escape_keeps(unit: u16) -> bool {
    u8::try_from(unit).is_ok_and(|byte| byte.is_ascii_alphanumeric() || b"@*_+-./".contains(&byte))
}

fn hex_value(unit: u16) -> Option<u16> {
    u8::try_from(unit)
        .ok()
        .and_then(|byte| (byte as char).to_digit(16))
        .map(|digit| digit as u16)
}

impl Interp {
    /// The `%Object.prototype%` members of [`Self::call_native_method_inner`]
    /// that Annex B.2.2 adds.
    /// Out of line from the method dispatcher, whose frame every native
    /// re-entry carries (`benches/stack_height.py`).
    #[inline(never)]
    pub(in crate::interp) fn call_legacy_object(
        &mut self,
        m: NativeMethod,
        base: usize,
        argc: usize,
        code: &[u8],
        this: Slot,
        arg0: Slot,
    ) -> Result<Slot, Step> {
        let arg1 = if argc > 1 {
            self.stack
                .get(base + 5)
                .copied()
                .unwrap_or_else(Slot::undefined)
        } else {
            Slot::undefined()
        };
        match m {
            // `get Object.prototype.__proto__` (B.2.2.1.1): `ToObject(this)`
            // and its `[[GetPrototypeOf]]`. A primitive's wrapper would be
            // fresh and ordinary, so its prototype is read without boxing it.
            NativeMethod::ObjectProtoGetter => {
                self.meter.tick_raw(REFLECT_FRAME_METERING);
                let inst = match (this.kind, this.value) {
                    (Kind::Reference, Payload::Reference(inst)) => inst,
                    (Kind::Null | Kind::Undefined, _) => {
                        return Err(self.catchable_type_error_msg("invalid this".into()))
                    }
                    _ => {
                        let proto = self.primitive_wrapper_prototype(this.kind);
                        if proto.is_null() {
                            return Err(self.catchable_type_error_msg("invalid this".into()));
                        }
                        return Ok(Slot::of(Kind::Reference, Payload::Reference(proto)));
                    }
                };
                self.mop_get_prototype(code, inst)
            }
            // `set Object.prototype.__proto__` (B.2.2.1.2): a nullish receiver
            // throws; a non-object prototype or a primitive receiver is
            // ignored; a refused `[[SetPrototypeOf]]` throws.
            NativeMethod::ObjectProtoSetter => {
                self.meter.tick_raw(REFLECT_FRAME_METERING);
                if matches!(this.kind, Kind::Null | Kind::Undefined) {
                    return Err(self.catchable_type_error_msg("invalid this".into()));
                }
                if argc < 1 || !matches!(arg0.kind, Kind::Null | Kind::Reference) {
                    return Ok(Slot::undefined());
                }
                let (Kind::Reference, Payload::Reference(inst)) = (this.kind, this.value) else {
                    return Ok(Slot::undefined());
                };
                if !self.mop_set_prototype(code, inst, arg0)? {
                    return Err(self.catchable_type_error_msg("invalid prototype".into()));
                }
                Ok(Slot::undefined())
            }
            // `Object.prototype.__defineGetter__(P, getter)` and its setter
            // twin (B.2.2.2, B.2.2.3): `ToObject(this)`, the callable check,
            // `ToPropertyKey(P)`, then `DefinePropertyOrThrow` of an
            // enumerable, configurable accessor half.
            NativeMethod::ObjectDefineGetter | NativeMethod::ObjectDefineSetter => {
                let getter = m == NativeMethod::ObjectDefineGetter;
                let object = self.array_to_object(this)?;
                let Payload::Reference(inst) = object.value else {
                    unreachable!("ToObject returns a reference")
                };
                if argc < 2 || !self.is_callable_value(arg1) {
                    let message = if getter {
                        "invalid getter"
                    } else {
                        "invalid setter"
                    };
                    return Err(self.catchable_type_error_msg(message.into()));
                }
                let key = self.to_read_key(code, arg0)?;
                self.meter.tick_raw(REFLECT_FRAME_METERING);
                let descriptor = OrdinaryDescriptor {
                    get: getter.then_some(arg1),
                    set: (!getter).then_some(arg1),
                    enumerable: Some(true),
                    configurable: Some(true),
                    ..OrdinaryDescriptor::default()
                };
                if !self.mop_define_own_property_read(code, inst, key, descriptor)? {
                    return Err(self.catchable_type_error_msg("invalid descriptor".into()));
                }
                Ok(Slot::undefined())
            }
            // `Object.prototype.__lookupGetter__(P)` and its setter twin
            // (B.2.2.4, B.2.2.5): walk the prototype chain to the first own
            // property named `P`; answer its accessor half, or `undefined`.
            NativeMethod::ObjectLookupGetter | NativeMethod::ObjectLookupSetter => {
                let getter = m == NativeMethod::ObjectLookupGetter;
                let object = self.array_to_object(this)?;
                let Payload::Reference(mut inst) = object.value else {
                    unreachable!("ToObject returns a reference")
                };
                let mut key = self.to_read_key(code, arg0)?;
                let mut proxy_steps = 0;
                loop {
                    self.meter.tick_raw(METHOD_HAS_OWN_PROPERTY_METERING);
                    self.charge_proxy_chain_step(inst, &mut proxy_steps)?;
                    if let Some(descriptor) = self.mop_get_own_property_read(code, inst, key)? {
                        let half = if getter {
                            descriptor.get
                        } else {
                            descriptor.set
                        };
                        return Ok(half.unwrap_or_else(Slot::undefined));
                    }
                    // A trap can name the index this key spells.
                    key = self.refresh_read_key(key);
                    let parent = self.mop_get_prototype(code, inst)?;
                    match (parent.kind, parent.value) {
                        (Kind::Reference, Payload::Reference(parent)) => inst = parent,
                        _ => return Ok(Slot::undefined()),
                    }
                }
            }
            _ => unreachable!("not an Annex B Object.prototype member"),
        }
    }

    /// The realm prototype a primitive of `kind` boxes to, or
    /// [`crate::value::SlotIndex::NULL`] for a kind with no wrapper.
    fn primitive_wrapper_prototype(&self, kind: Kind) -> crate::value::SlotIndex {
        match kind {
            Kind::String => self.string_proto,
            Kind::Integer | Kind::Number => self.number_proto,
            Kind::Boolean => self.boolean_proto,
            Kind::Symbol => self.symbol_proto,
            Kind::BigInt => self.bigint_proto,
            _ => crate::value::SlotIndex::NULL,
        }
    }

    /// `escape(string)` and `unescape(string)` (B.2.1.1, B.2.1.2) over the
    /// string's UTF-16 code units. Each input unit is charged once, before
    /// it is first read, and each output growth is admitted before the
    /// scratch buffer grows, as the URI globals do.
    /// Out of line from the method dispatcher, whose frame every native
    /// re-entry carries (`benches/stack_height.py`).
    #[inline(never)]
    pub(in crate::interp) fn call_legacy_escape(
        &mut self,
        m: NativeMethod,
        base: usize,
        argc: usize,
        code: &[u8],
    ) -> Result<Slot, Step> {
        let value = if argc > 0 {
            self.stack
                .get(base + 4)
                .copied()
                .unwrap_or_else(Slot::undefined)
        } else {
            Slot::undefined()
        };
        self.charge_and_check(0)?;
        let string = self.to_string_slot(code, value)?;
        let Payload::String(off) = string.value else {
            unreachable!("ToString returned a non-string slot");
        };
        let len = self.str_len(off);
        let mut charged = 0;
        let mut out = Vec::new();
        let mut pos = 0;
        while pos < len {
            let unit = self.legacy_escape_unit(off, pos, &mut charged)?;
            if m == NativeMethod::GlobalEscape {
                if escape_keeps(unit) {
                    self.extend_reserved_units(&mut out, &[unit])?;
                } else if unit < 0x100 {
                    let escaped = [
                        b'%',
                        HEX_UPPER[(unit >> 4) as usize],
                        HEX_UPPER[(unit & 15) as usize],
                    ];
                    self.extend_reserved_units(&mut out, &escaped.map(u16::from))?;
                } else {
                    let escaped = [
                        b'%',
                        b'u',
                        HEX_UPPER[(unit >> 12) as usize],
                        HEX_UPPER[((unit >> 8) & 15) as usize],
                        HEX_UPPER[((unit >> 4) & 15) as usize],
                        HEX_UPPER[(unit & 15) as usize],
                    ];
                    self.extend_reserved_units(&mut out, &escaped.map(u16::from))?;
                }
                pos += 1;
                continue;
            }
            // `unescape`: `%uXXXX` and `%XX` decode to one code unit; any
            // other `%` stays as it is.
            let mut decoded = None;
            if unit == u16::from(b'%') {
                if pos + 6 <= len
                    && self.legacy_escape_unit(off, pos + 1, &mut charged)? == u16::from(b'u')
                {
                    decoded = self
                        .legacy_escape_hex(off, pos + 2, 4, &mut charged)?
                        .map(|v| (v, 6));
                }
                if decoded.is_none() && pos + 3 <= len {
                    decoded = self
                        .legacy_escape_hex(off, pos + 1, 2, &mut charged)?
                        .map(|v| (v, 3));
                }
            }
            let (unit, width) = decoded.unwrap_or((unit, 1));
            self.extend_reserved_units(&mut out, &[unit])?;
            pos += width;
        }
        Ok(self.new_reserved_string_units(&out))
    }

    /// The unit at `pos`, charged when no earlier read has charged it.
    fn legacy_escape_unit(
        &mut self,
        off: crate::value::ChunkOffset,
        pos: usize,
        charged: &mut usize,
    ) -> Result<u16, Step> {
        if pos >= *charged {
            self.charge_and_check(crate::meter::STRING_METERING)?;
            *charged = pos + 1;
        }
        Ok(self
            .str_unit_at(off, pos as u32)
            .expect("escape index within string"))
    }

    /// The value of the `digits` hexadecimal digits at `pos`, if they all are.
    fn legacy_escape_hex(
        &mut self,
        off: crate::value::ChunkOffset,
        pos: usize,
        digits: usize,
        charged: &mut usize,
    ) -> Result<Option<u16>, Step> {
        let mut value = 0;
        for at in pos..pos + digits {
            let Some(digit) = hex_value(self.legacy_escape_unit(off, at, charged)?) else {
                return Ok(None);
            };
            value = (value << 4) | digit;
        }
        Ok(Some(value))
    }
}
