//! JSON parsing, revivers, and stringify traversal and output admission.
use super::super::*;

/// The parallel source tree retained only while `JSON.parse` runs a reviver.
/// Container nodes mirror the parsed value's original children; primitive
/// nodes retain both the original value and its exact token byte range so the
/// reviver's modern third argument can expose `{ source }` iff the property was
/// not observably replaced before its post-order visit.
#[derive(Clone, Debug)]
enum JsonSource {
    Empty,
    Primitive {
        original: Slot,
        start: usize,
        end: usize,
    },
    Array(Vec<JsonSource>),
    Object(Vec<(ReadKey, JsonSource)>),
}

/// One string property name retained by `JSON.stringify`.  The id drives the
/// VM's property MOP, `key` is the exact String value passed to `toJSON` and a
/// replacer callback, and `units` preserves the UTF-16 spelling used in the
/// emitted JSON text (including a lone surrogate supplied by a replacer list).
#[derive(Clone, Debug)]
struct JsonPropertyName {
    /// The key as a [`ReadKey`]: an index whose canonical name the table has
    /// never held stays an index, so walking a large array's elements mints
    /// nothing (`JSON.stringify` over a 70,000-element array walked the id
    /// space into its saturation guard).
    key_id: ReadKey,
    key: Slot,
    units: Vec<u16>,
}

/// Transient state for one `JSON.stringify` invocation.  This deliberately
/// lives outside the persistent VM state: the spec's Stack/Indent/Gap and
/// PropertyList exist only for the duration of the native call.
#[derive(Clone, Debug, Default)]
struct JsonStringifyState {
    /// Units emitted into the final result, prepaid once across recursive copies.
    output_units: u64,
    replacer: Option<Slot>,
    property_list: Option<Vec<JsonPropertyName>>,
    gap: Vec<u16>,
    indent: Vec<u16>,
    stack: Vec<crate::value::SlotIndex>,
}

impl Interp {
    /// `fxStringifyJSONString` (`xsJSON.c`): the JSON-escaped, double-quoted form
    /// of a string, over its UTF-16 code `units`. Control characters below 0x20
    /// map to the short escapes (`\b\t\n\f\r`) or `\uXXXX`; `"` and `\` are
    /// backslash-escaped; an unpaired surrogate code unit becomes `\uXXXX`, while
    /// a valid high/low pair is copied as the corresponding astral character;
    /// every other code unit is copied verbatim. Output remains UTF-16 so the
    /// optional indentation string can retain a code-unit truncation (and even a
    /// resulting lone surrogate) without a lossy Rust `String` round trip.
    fn json_escape_string(
        &mut self,
        units: &[u16],
        state: &mut JsonStringifyState,
    ) -> Result<Vec<u16>, Step> {
        let mut size = 2usize;
        let mut i = 0;
        while i < units.len() {
            let u = units[i];
            let added = match u {
                8 | 9 | 10 | 12 | 13 | 0x22 | 0x5c => 2,
                0xd800..=0xdbff
                    if units
                        .get(i + 1)
                        .is_some_and(|low| (0xdc00..=0xdfff).contains(low)) =>
                {
                    i += 1;
                    2
                }
                0..=0x1f | 0xd800..=0xdfff => 6,
                _ => 1,
            };
            size = size
                .checked_add(added)
                .ok_or(Step::Host(Halt::HeapExhausted))?;
            i += 1;
        }
        self.json_reserve_output(state, size)?;
        let mut out = Self::reserved_vec(size)?;
        out.push(b'"' as u16);
        let mut index = 0;
        while index < units.len() {
            let u = units[index];
            match u {
                8 => out.extend("\\b".encode_utf16()),
                9 => out.extend("\\t".encode_utf16()),
                10 => out.extend("\\n".encode_utf16()),
                12 => out.extend("\\f".encode_utf16()),
                13 => out.extend("\\r".encode_utf16()),
                0x22 => out.extend("\\\"".encode_utf16()),
                0x5C => out.extend("\\\\".encode_utf16()),
                high if (0xD800..=0xDBFF).contains(&high)
                    && units
                        .get(index + 1)
                        .is_some_and(|low| (0xDC00..=0xDFFF).contains(low)) =>
                {
                    out.push(high);
                    out.push(units[index + 1]);
                    index += 1;
                }
                c if c < 0x20 || (0xD800..=0xDFFF).contains(&c) => {
                    out.extend(format!("\\u{:04x}", c).encode_utf16());
                }
                c => out.push(c),
            }
            index += 1;
        }
        out.push(b'"' as u16);
        Ok(out)
    }

    fn json_reserve_output(
        &mut self,
        state: &mut JsonStringifyState,
        additional: usize,
    ) -> Result<(), Step> {
        let total = state
            .output_units
            .checked_add(additional as u64)
            .ok_or(Step::Host(Halt::HeapExhausted))?;
        self.reserve_units_growth(state.output_units, total)?;
        state.output_units = total;
        Ok(())
    }

    fn json_output_text(
        &mut self,
        state: &mut JsonStringifyState,
        text: &str,
    ) -> Result<Vec<u16>, Step> {
        let size = text.encode_utf16().count();
        self.json_reserve_output(state, size)?;
        let mut out = Self::reserved_vec(size)?;
        out.extend(text.encode_utf16());
        Ok(out)
    }

    /// Reserve punctuation and indentation once, then size the assembly
    /// buffer including children whose output has already been prepaid.
    fn json_container_buffer(
        &mut self,
        state: &mut JsonStringifyState,
        partial: &[Vec<u16>],
        indent: &[u16],
        stepback: &[u16],
    ) -> Result<Vec<u16>, Step> {
        let count = partial.len() as u64;
        let extra = if count == 0 {
            2
        } else if state.gap.is_empty() {
            count + 1
        } else {
            2 + 2 * count + count * indent.len() as u64 + stepback.len() as u64
        };
        let extra = usize::try_from(extra).map_err(|_| Step::Host(Halt::HeapExhausted))?;
        self.json_reserve_output(state, extra)?;
        let length = partial
            .iter()
            .try_fold(extra, |length, part| length.checked_add(part.len()))
            .ok_or(Step::Host(Halt::HeapExhausted))?;
        self.reserve_scratch(length)
    }

    /// Dispatch `JSON.stringify` / `JSON.parse`. The stringifier's working
    /// buffer is unmetered (C-malloc'd in XS); only the final result chunk
    /// meters. `parse` allocates the parsed strings' chunks.
    pub(in crate::interp) fn call_json(
        &mut self,
        m: NativeMethod,
        base: usize,
        argc: usize,
        code: &[u8],
    ) -> Result<Slot, Step> {
        let arg0 = if argc > 0 {
            self.stack
                .get(base + 4)
                .copied()
                .unwrap_or_else(Slot::undefined)
        } else {
            Slot::undefined()
        };
        match m {
            NativeMethod::JsonStringify => {
                let arg1 = self
                    .stack
                    .get(base + 5)
                    .copied()
                    .unwrap_or_else(Slot::undefined);
                let arg2 = self
                    .stack
                    .get(base + 6)
                    .copied()
                    .unwrap_or_else(Slot::undefined);
                let (replacer, property_list) = self.json_stringify_replacer(code, arg1)?;
                let gap = self.json_stringify_gap(code, arg2)?;
                let mut state = JsonStringifyState {
                    replacer,
                    property_list,
                    gap,
                    ..JsonStringifyState::default()
                };
                self.meter.tick_raw(JSON_STRINGIFY_SETUP_METERING);
                // `cost` accumulates the recursive `fxStringifyJSONProperty` node
                // metering (exclusive of the result chunk); a top-level
                // reference pays [`JSON_STRINGIFY_TOP_REFERENCE_METERING`] once.
                let mut cost: u64 = 0;
                let empty_id = self.intern_key("");
                let empty_key = self.property_key_slot(empty_id)?;
                let root_name = JsonPropertyName {
                    key_id: ReadKey::Id(empty_id),
                    key: empty_key,
                    units: Vec::new(),
                };
                // A replacer function observes the spec-created wrapper as its
                // root receiver.  Without one, no callback can observe that
                // wrapper, so pass the already-known root value directly and
                // avoid retaining a semantically invisible heap object.
                let out = if state.replacer.is_some() {
                    let holder = self.slots.alloc(Slot::instance(self.object_proto));
                    self.set_own_unmetered(holder, empty_id, arg0);
                    self.json_stringify_property(code, holder, &root_name, &mut state, &mut cost)?
                } else {
                    self.json_stringify_value(code, arg0, &root_name, None, &mut state, &mut cost)?
                };
                if arg0.kind == Kind::Reference && out.is_some() {
                    cost += JSON_STRINGIFY_TOP_REFERENCE_METERING;
                }
                self.charge_and_check(cost)?;
                match out {
                    Some(units) => {
                        debug_assert_eq!(state.output_units, units.len() as u64);
                        Ok(self.new_reserved_string_units(&units))
                    }
                    // A value that serializes to nothing (undefined / symbol)
                    // yields `undefined`, with no chunk (setup metered only).
                    None => Ok(Slot::undefined()),
                }
            }
            NativeMethod::JsonParse => {
                let reviver = self
                    .stack
                    .get(base + 5)
                    .copied()
                    .unwrap_or_else(Slot::undefined);
                let has_reviver = self.is_callable_value(reviver);
                // `JSON.parse` applies ToString before tokenization.
                let units = self.to_string_units(code, arg0)?;
                self.charge_builtin_work(units.len() as u64)?;
                self.admit_scratch::<u8>(
                    units
                        .len()
                        .checked_mul(3)
                        .ok_or(Step::Host(Halt::HeapExhausted))?,
                )?;
                // The tokenizer below operates on scalar UTF-8 text. Preserve
                // correctness at its remaining representation boundary: a
                // valid surrogate pair round-trips through that text, while a
                // genuinely unpaired code unit cannot and must stay an honest
                // named skip instead of being silently changed to U+FFFD.
                if char::decode_utf16(units.iter().copied()).any(|unit| unit.is_err()) {
                    return Err(Step::Host(Halt::NotImplemented(
                        "JSON.parse:lone-surrogate",
                    )));
                }
                let input = String::from_utf16_lossy(&units).into_bytes();
                self.charge_and_check(JSON_PARSE_SETUP_METERING)?;
                let mut pos = 0usize;
                self.json_parse_whitespace(&input, &mut pos);
                let (value, source) = self.json_parse_value(&input, &mut pos, has_reviver)?;
                self.json_parse_whitespace(&input, &mut pos);
                if pos != input.len() {
                    // Trailing content after the value: XS's "missing EOF"
                    // SyntaxError.
                    return Err(self.catchable_syntax_error());
                }
                if !has_reviver {
                    return Ok(value);
                }
                // InternalizeJSONProperty starts from a fresh wrapper whose
                // empty-string property holds the parsed root. The recursive
                // walk performs mutation-sensitive Get/Delete/Define operations
                // and calls the reviver post-order.
                let holder = self.slots.alloc(Slot::instance(self.object_proto));
                let root_id = self.intern_key("");
                self.set_own_unmetered(holder, root_id, value);
                self.json_internalize_property(
                    code,
                    &input,
                    holder,
                    ReadKey::Id(root_id),
                    Some(source),
                    reviver,
                )
            }
            _ => Err(Step::Host(Halt::NotImplemented("json:unmodeled"))),
        }
    }

    /// Resolve JSON.stringify's replacer argument into either a callback or
    /// the de-duplicated PropertyList created from an Array (including an
    /// Array Proxy).  Reads are live and ordered; String/Number wrappers use
    /// their observable coercions exactly where the abstract operation does.
    fn json_stringify_replacer(
        &mut self,
        code: &[u8],
        replacer: Slot,
    ) -> Result<(Option<Slot>, Option<Vec<JsonPropertyName>>), Step> {
        if self.is_callable_value(replacer) {
            return Ok((Some(replacer), None));
        }
        let inst = match replacer.value {
            Payload::Reference(inst) if replacer.kind == Kind::Reference => inst,
            _ => return Ok((None, None)),
        };
        if !self.array_generic_is_array(inst)? {
            return Ok((None, None));
        }
        let length_value = self.arraylike_length(code, inst, replacer)?;
        let length = self.to_length_value(code, length_value)?;
        if length > u64::from(u32::MAX) {
            return Err(Step::Host(Halt::Refused(
                "JSON.stringify:oversized-replacer",
            )));
        }
        let mut property_list = Vec::new();
        for index in 0..length {
            // Reading the replacer array is a READ: `length > u32::MAX` was
            // refused above, and XS walks it by index without minting a key,
            // so a long replacer list must not grow the name table either.
            let key_id = match self.index_read_key_id(index as u32) {
                Some(id) => ReadKey::Id(id),
                None => ReadKey::Index(index as u32),
            };
            let item = self.mop_get_read(code, inst, key_id, replacer)?;
            let string = match item.kind {
                Kind::String => Some(item),
                Kind::Integer | Kind::Number => Some(self.to_string_slot_metered(item)),
                Kind::Reference => {
                    let wrapped = match item.value {
                        Payload::Reference(object) => self.wrapper_data.get(&object).copied(),
                        _ => None,
                    };
                    match wrapped.map(|value| value.kind) {
                        Some(Kind::String) => Some(self.to_string_slot(code, item)?),
                        // PropertyList uses ToString on a Number wrapper
                        // directly.  Its `toString` override therefore wins;
                        // routing through ToNumber/valueOf reverses the
                        // required coercion order and can throw spuriously.
                        Some(Kind::Integer | Kind::Number) => {
                            Some(self.to_string_slot(code, item)?)
                        }
                        _ => None,
                    }
                }
                _ => None,
            };
            let Some(key) = string else {
                continue;
            };
            let units = match key.value {
                Payload::String(offset) if key.kind == Kind::String => self.str_units(offset),
                _ => continue,
            };
            if property_list
                .iter()
                .any(|existing: &JsonPropertyName| existing.units == units)
            {
                continue;
            }
            let key_id = self.to_read_key(code, key)?;
            property_list.push(JsonPropertyName { key_id, key, units });
        }
        Ok((None, Some(property_list)))
    }

    /// Produce JSON.stringify's Gap string from the third argument.  A Number
    /// (or Number wrapper) becomes at most ten spaces; a String (or String
    /// wrapper) is truncated to ten UTF-16 code units, not Unicode scalars.
    fn json_stringify_gap(&mut self, code: &[u8], space: Slot) -> Result<Vec<u16>, Step> {
        let wrapped_kind = match space.value {
            Payload::Reference(object) if space.kind == Kind::Reference => {
                self.wrapper_data.get(&object).map(|value| value.kind)
            }
            _ => None,
        };
        if matches!(space.kind, Kind::Integer | Kind::Number)
            || matches!(wrapped_kind, Some(Kind::Integer | Kind::Number))
        {
            let number = self.to_number_value(code, space)?;
            let n = numeric_of(&number).unwrap_or(f64::NAN);
            let count = if n.is_nan() || n <= 0.0 {
                0
            } else if n >= 10.0 {
                10
            } else {
                n.trunc() as usize
            };
            return Ok([0x20; 10][..count].to_vec());
        }
        if space.kind == Kind::String || wrapped_kind == Some(Kind::String) {
            let mut units = self.to_string_units(code, space)?;
            units.truncate(10);
            return Ok(units);
        }
        Ok(Vec::new())
    }

    /// `SerializeJSONProperty(key, holder)`: perform the live `Get`, then the
    /// shared transformation and serialization path.
    fn json_stringify_property(
        &mut self,
        code: &[u8],
        holder: crate::value::SlotIndex,
        name: &JsonPropertyName,
        state: &mut JsonStringifyState,
        cost: &mut u64,
    ) -> Result<Option<Vec<u16>>, Step> {
        let holder_slot = Slot::of(Kind::Reference, Payload::Reference(holder));
        // `json_stringify_own_names` snapshots every key BEFORE any value is
        // read, and a replacer list is cached for the whole stringify, so a
        // replacer or getter can name an index between the snapshot and this
        // live Get. Refresh, or the promoted property silently vanishes from
        // the output.
        let key_id = self.refresh_read_key(name.key_id);
        let value = self.mop_get_read(code, holder, key_id, holder_slot)?;
        self.json_stringify_value(code, value, name, Some(holder_slot), state, cost)
    }

    /// `GetV(value, id)` for the object/BigInt `toJSON` probe.  BigInt is the
    /// sole primitive admitted by the specification at this step.
    fn json_stringify_get_v(&mut self, code: &[u8], value: Slot, id: u16) -> Result<Slot, Step> {
        match value.value {
            Payload::Reference(inst) if value.kind == Kind::Reference => {
                self.mop_get(code, inst, id, value)
            }
            Payload::BigInt(_) if !self.bigint_proto.is_null() => {
                self.mop_get(code, self.bigint_proto, id, value)
            }
            _ => Ok(Slot::undefined()),
        }
    }

    /// The complete `SerializeJSONProperty` value phase: invoke an observable
    /// `toJSON`, then the replacer callback, unwrap primitive wrapper objects,
    /// reject BigInt, and finally emit a scalar, array, or ordinary object.
    /// Each nesting level of the value is one light frame of the
    /// native-recursion budget (a cycle is already a `TypeError` via
    /// `state.stack`; this bounds the acyclic-but-deep case).
    fn json_stringify_value(
        &mut self,
        code: &[u8],
        value: Slot,
        name: &JsonPropertyName,
        holder: Option<Slot>,
        state: &mut JsonStringifyState,
        cost: &mut u64,
    ) -> Result<Option<Vec<u16>>, Step> {
        self.with_native_frame(LIGHT_FRAME_COST, |vm| {
            vm.json_stringify_value_inner(code, value, name, holder, state, cost)
        })
    }

    fn json_stringify_value_inner(
        &mut self,
        code: &[u8],
        mut value: Slot,
        name: &JsonPropertyName,
        holder: Option<Slot>,
        state: &mut JsonStringifyState,
        cost: &mut u64,
    ) -> Result<Option<Vec<u16>>, Step> {
        if value.kind == Kind::Reference || value.kind == Kind::BigInt {
            let to_json_id = self.intern_key("toJSON");
            let to_json = self.json_stringify_get_v(code, value, to_json_id)?;
            if self.is_callable_value(to_json) {
                value = self.run_callback(code, to_json, value, &[name.key])?;
            }
        }
        if let Some(replacer) = state.replacer {
            let receiver = holder.expect("a replacer callback always has a holder");
            value = self.run_callback(code, replacer, receiver, &[name.key, value])?;
        }

        if let Payload::Reference(object) = value.value {
            if value.kind == Kind::Reference {
                if let Some(wrapped) = self.wrapper_data.get(&object).copied() {
                    value = match wrapped.kind {
                        Kind::Boolean | Kind::BigInt => wrapped,
                        Kind::Integer | Kind::Number => self.to_number_value(code, value)?,
                        Kind::String => self.to_string_slot(code, value)?,
                        _ => value,
                    };
                }
            }
        }

        match value.kind {
            Kind::Null => {
                self.charge_and_check(JSON_STRINGIFY_SCALAR_METERING)?;
                Ok(Some(self.json_output_text(state, "null")?))
            }
            Kind::Undefined | Kind::Symbol => Ok(None),
            Kind::Boolean => {
                self.charge_and_check(JSON_STRINGIFY_SCALAR_METERING)?;
                let text = if matches!(value.value, Payload::Boolean(true)) {
                    "true"
                } else {
                    "false"
                };
                Ok(Some(self.json_output_text(state, &text)?))
            }
            Kind::Integer => match value.value {
                Payload::Integer(integer) => {
                    self.charge_and_check(JSON_STRINGIFY_SCALAR_METERING)?;
                    Ok(Some(self.json_output_text(state, &integer.to_string())?))
                }
                _ => Ok(None),
            },
            Kind::Number => match value.value {
                Payload::Number(number) => {
                    self.charge_and_check(JSON_STRINGIFY_SCALAR_METERING)?;
                    let text = if number.is_finite() {
                        number_to_ecma_string(number)
                    } else {
                        "null".to_string()
                    };
                    Ok(Some(self.json_output_text(state, &text)?))
                }
                _ => Ok(None),
            },
            Kind::String => match value.value {
                Payload::String(offset) => {
                    self.charge_and_check(JSON_STRINGIFY_SCALAR_METERING)?;
                    let units = self.str_units(offset);
                    Ok(Some(self.json_escape_string(&units, state)?))
                }
                _ => Ok(None),
            },
            Kind::BigInt => Err(self.catchable_type_error_msg("stringify bigint".into())),
            Kind::Reference => {
                let inst = match value.value {
                    Payload::Reference(inst) => inst,
                    _ => return Ok(None),
                };
                if self.is_callable_value(value) {
                    return Ok(None);
                }
                if self.array_generic_is_array(inst)? {
                    self.json_stringify_array(code, inst, value, state, cost)
                } else {
                    self.json_stringify_object(code, inst, value, state, cost)
                }
            }
            _ => Ok(None),
        }
    }

    /// `SerializeJSONArray`: snapshot `length`, then perform a live Get and
    /// full value transformation for every index.  Missing/unsupported values
    /// become `null`; indentation follows the invocation's UTF-16 Gap.
    fn json_stringify_array(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        receiver: Slot,
        state: &mut JsonStringifyState,
        cost: &mut u64,
    ) -> Result<Option<Vec<u16>>, Step> {
        if state.stack.contains(&inst) {
            return Err(self.catchable_type_error_msg("cyclic value".into()));
        }
        state.stack.push(inst);
        let length_value = self.arraylike_length(code, inst, receiver)?;
        let length = self.to_length_value(code, length_value)?;
        if length > u64::from(u32::MAX) {
            return Err(Step::Host(Halt::Refused("JSON.stringify:oversized-array")));
        }
        *cost += JSON_STRINGIFY_ARRAY_ENTER_METERING;
        if length > 0 {
            *cost += JSON_STRINGIFY_ARRAY_NONEMPTY_METERING;
        }
        let stepback = state.indent.clone();
        state.indent.extend_from_slice(&state.gap);
        *cost += length * JSON_STRINGIFY_ARRAY_ELEMENT_METERING;
        self.charge_and_check(std::mem::take(cost))?;
        let mut partial = self.reserve_scratch(length as usize)?;
        for index in 0..length {
            let text = index.to_string();
            // XS walks the array here by index and never mints a key. Taking
            // the id unmetered kept the computron count right but still grew
            // the name table one entry per element, so a long array exhausted
            // the shared `u16` id space; the key is spelled from the index
            // instead, exactly as `fxKeyAt` spells it.
            // `length > u32::MAX` was refused above, so the position always
            // fits the index space.
            let index = index as u32;
            let key_id = match self.index_read_key_id(index) {
                Some(id) => ReadKey::Id(id),
                None => ReadKey::Index(index),
            };
            let key = self.read_key_slot(key_id)?;
            let name = JsonPropertyName {
                key_id,
                key,
                units: text.encode_utf16().collect(),
            };
            let element = match self.json_stringify_property(code, inst, &name, state, cost)? {
                Some(element) => element,
                None => self.json_output_text(state, "null")?,
            };
            partial.push(element);
        }
        let indent = state.indent.clone();
        state.indent = stepback.clone();
        state.stack.pop();
        let mut out = self.json_container_buffer(state, &partial, &indent, &stepback)?;
        out.push(b'[' as u16);
        if !partial.is_empty() {
            if state.gap.is_empty() {
                for (index, element) in partial.iter().enumerate() {
                    if index > 0 {
                        out.push(b',' as u16);
                    }
                    out.extend_from_slice(element);
                }
            } else {
                out.push(b'\n' as u16);
                out.extend_from_slice(&indent);
                for (index, element) in partial.iter().enumerate() {
                    if index > 0 {
                        out.push(b',' as u16);
                        out.push(b'\n' as u16);
                        out.extend_from_slice(&indent);
                    }
                    out.extend_from_slice(element);
                }
                out.push(b'\n' as u16);
                out.extend_from_slice(&stepback);
            }
        }
        out.push(b']' as u16);
        Ok(Some(out))
    }

    /// Snapshot the enumerable own String keys for SerializeJSONObject.  The
    /// key list, each descriptor read, and later value Get all route through
    /// the MOP, preserving Proxy traps and mutation between those operations.
    fn json_stringify_own_names(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
    ) -> Result<Vec<JsonPropertyName>, Step> {
        let mut names = Vec::new();
        for key in self.mop_own_keys(code, inst)? {
            if key.kind == Kind::Symbol {
                continue;
            }
            let units = match key.value {
                Payload::String(offset) if key.kind == Kind::String => self.str_units(offset),
                _ => return Err(self.catchable_type_error()),
            };
            let key_id = self.to_read_key(code, key)?;
            if self
                .mop_get_own_property_read(code, inst, key_id)?
                .is_some_and(|descriptor| descriptor.enumerable == Some(true))
            {
                names.push(JsonPropertyName { key_id, key, units });
            }
        }
        Ok(names)
    }

    /// `SerializeJSONObject`: use the replacer PropertyList when present,
    /// otherwise enumerate own string keys once, then Get each value live.
    fn json_stringify_object(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        _receiver: Slot,
        state: &mut JsonStringifyState,
        cost: &mut u64,
    ) -> Result<Option<Vec<u16>>, Step> {
        if state.stack.contains(&inst) {
            return Err(self.catchable_type_error_msg("cyclic value".into()));
        }
        state.stack.push(inst);
        let names = match &state.property_list {
            Some(property_list) => property_list.clone(),
            None => self.json_stringify_own_names(code, inst)?,
        };
        *cost += JSON_STRINGIFY_OBJECT_ENTER_METERING;
        *cost += names.len() as u64 * JSON_STRINGIFY_OBJECT_KEY_SLOT_METERING;
        if !names.is_empty() {
            *cost += JSON_STRINGIFY_OBJECT_NONEMPTY_METERING;
        }
        let stepback = state.indent.clone();
        state.indent.extend_from_slice(&state.gap);
        self.charge_and_check(std::mem::take(cost))?;
        let mut partial = self.reserve_scratch(names.len())?;
        for name in &names {
            self.charge_and_check(
                JSON_STRINGIFY_OBJECT_KEY_BODY_METERING
                    + (string_chunk_cost(name.units.len() as u64)
                        - CHUNK_HEADER_BYTES * CHUNK_ALLOCATION_METERING),
            )?;
            if let Some(value) = self.json_stringify_property(code, inst, name, state, cost)? {
                let mut member = self.json_escape_string(&name.units, state)?;
                let punctuation = if state.gap.is_empty() { 1 } else { 2 };
                self.json_reserve_output(state, punctuation)?;
                let additional = punctuation + value.len();
                self.admit_scratch::<u16>(member.len() + additional)?;
                member
                    .try_reserve(additional)
                    .map_err(|_| Step::Host(Halt::HeapExhausted))?;
                member.push(b':' as u16);
                if !state.gap.is_empty() {
                    member.push(b' ' as u16);
                }
                member.extend_from_slice(&value);
                partial.push(member);
            }
        }
        let indent = state.indent.clone();
        state.indent = stepback.clone();
        state.stack.pop();
        let mut out = self.json_container_buffer(state, &partial, &indent, &stepback)?;
        out.push(b'{' as u16);
        if !partial.is_empty() {
            if state.gap.is_empty() {
                for (index, member) in partial.iter().enumerate() {
                    if index > 0 {
                        out.push(b',' as u16);
                    }
                    out.extend_from_slice(member);
                }
            } else {
                out.push(b'\n' as u16);
                out.extend_from_slice(&indent);
                for (index, member) in partial.iter().enumerate() {
                    if index > 0 {
                        out.push(b',' as u16);
                        out.push(b'\n' as u16);
                        out.extend_from_slice(&indent);
                    }
                    out.extend_from_slice(member);
                }
                out.push(b'\n' as u16);
                out.extend_from_slice(&stepback);
            }
        }
        out.push(b'}' as u16);
        Ok(Some(out))
    }

    /// Skip JSON whitespace (`fxParseJSONToken`'s space/tab/CR/LF cases). Never
    /// allocates, so it is invisible to the meter.
    fn json_parse_whitespace(&self, input: &[u8], pos: &mut usize) {
        while *pos < input.len() {
            match input[*pos] {
                b' ' | b'\t' | b'\n' | b'\r' => *pos += 1,
                _ => break,
            }
        }
    }

    /// Parse one JSON value at `pos` (`fxParseJSONValue`), building it in the
    /// heap and accumulating the recursive per-node metering into `cost` (the
    /// caller charges [`JSON_PARSE_SETUP_METERING`] once and `cost` at the end).
    /// A malformed input throws a catchable `SyntaxError`. Each nesting level
    /// of the input is one light frame of the native-recursion budget, so
    /// `"[".repeat(1e6)` halts with [`Halt::StackOverflow`] instead of
    /// overflowing the host stack (XS's `fxParseJSONValue` recurses the same
    /// way, bounded by its C stack).
    fn json_parse_value(
        &mut self,
        input: &[u8],
        pos: &mut usize,
        track_source: bool,
    ) -> Result<(Slot, JsonSource), Step> {
        self.with_native_frame(LIGHT_FRAME_COST, |vm| {
            vm.json_parse_value_inner(input, pos, track_source)
        })
    }

    fn json_parse_value_inner(
        &mut self,
        input: &[u8],
        pos: &mut usize,
        track_source: bool,
    ) -> Result<(Slot, JsonSource), Step> {
        if *pos >= input.len() {
            return Err(self.catchable_syntax_error());
        }
        let start = *pos;
        match input[*pos] {
            b'{' => self.json_parse_object(input, pos, track_source),
            b'[' => self.json_parse_array(input, pos, track_source),
            b'"' => {
                let units = self.json_parse_string_units(input, pos)?;
                // The tokenizer's `s = fxNewChunk(the, size + 1)`: always a
                // chunk, even for the empty string (unlike an interned literal).
                // The frozen Ironhorse price uses UTF-16 units on every path.
                self.charge_and_check(string_chunk_cost(units.len() as u64))?;
                let off = self.chunks.alloc(&units_to_be16(&units));
                let value = Slot::of(Kind::String, Payload::String(off));
                let source = if track_source {
                    JsonSource::Primitive {
                        original: value,
                        start,
                        end: *pos,
                    }
                } else {
                    JsonSource::Empty
                };
                Ok((value, source))
            }
            b't' => {
                self.json_parse_keyword(input, pos, b"true")?;
                let value = Slot::of(Kind::Boolean, Payload::Boolean(true));
                let source = if track_source {
                    JsonSource::Primitive {
                        original: value,
                        start,
                        end: *pos,
                    }
                } else {
                    JsonSource::Empty
                };
                Ok((value, source))
            }
            b'f' => {
                self.json_parse_keyword(input, pos, b"false")?;
                let value = Slot::of(Kind::Boolean, Payload::Boolean(false));
                let source = if track_source {
                    JsonSource::Primitive {
                        original: value,
                        start,
                        end: *pos,
                    }
                } else {
                    JsonSource::Empty
                };
                Ok((value, source))
            }
            b'n' => {
                self.json_parse_keyword(input, pos, b"null")?;
                let value = Slot::null();
                let source = if track_source {
                    JsonSource::Primitive {
                        original: value,
                        start,
                        end: *pos,
                    }
                } else {
                    JsonSource::Empty
                };
                Ok((value, source))
            }
            b'-' | b'0'..=b'9' => {
                let value = self.json_parse_number(input, pos)?;
                let source = if track_source {
                    JsonSource::Primitive {
                        original: value,
                        start,
                        end: *pos,
                    }
                } else {
                    JsonSource::Empty
                };
                Ok((value, source))
            }
            _ => Err(self.catchable_syntax_error()),
        }
    }

    /// Match a bare keyword (`true`/`false`/`null`), advancing past it.
    fn json_parse_keyword(
        &mut self,
        input: &[u8],
        pos: &mut usize,
        word: &[u8],
    ) -> Result<(), Step> {
        if input.len() - *pos >= word.len() && &input[*pos..*pos + word.len()] == word {
            *pos += word.len();
            Ok(())
        } else {
            Err(self.catchable_syntax_error())
        }
    }

    /// Parse a JSON number token (`fxParseJSONToken`'s numeric case) and
    /// classify it exactly as XS does: an integral value in `txInteger` range
    /// (and not zero, which XS leaves as `XS_NUMBER_KIND`) is an integer, else a
    /// number. The number token itself allocates nothing.
    fn json_parse_number(&mut self, input: &[u8], pos: &mut usize) -> Result<Slot, Step> {
        let start = *pos;
        let n = input.len();
        let mut i = *pos;
        if i < n && input[i] == b'-' {
            i += 1;
        }
        // int part: `0` alone, or [1-9][0-9]*
        if i < n && input[i] == b'0' {
            i += 1;
        } else if i < n && (b'1'..=b'9').contains(&input[i]) {
            i += 1;
            while i < n && input[i].is_ascii_digit() {
                i += 1;
            }
        } else {
            return Err(self.catchable_syntax_error());
        }
        // fraction
        if i < n && input[i] == b'.' {
            i += 1;
            if i < n && input[i].is_ascii_digit() {
                i += 1;
                while i < n && input[i].is_ascii_digit() {
                    i += 1;
                }
            } else {
                return Err(self.catchable_syntax_error());
            }
        }
        // exponent
        if i < n && (input[i] == b'e' || input[i] == b'E') {
            i += 1;
            if i < n && (input[i] == b'+' || input[i] == b'-') {
                i += 1;
            }
            if i < n && input[i].is_ascii_digit() {
                i += 1;
                while i < n && input[i].is_ascii_digit() {
                    i += 1;
                }
            } else {
                return Err(self.catchable_syntax_error());
            }
        }
        let text = match std::str::from_utf8(&input[start..i]) {
            Ok(t) => t,
            Err(_) => return Err(self.catchable_syntax_error()),
        };
        let value: f64 = match text.parse() {
            Ok(v) => v,
            Err(_) => return Err(self.catchable_syntax_error()),
        };
        *pos = i;
        // XS: INTEGER iff `number == (txInteger)number && number != 0`.
        if value != 0.0
            && value.fract() == 0.0
            && value >= i32::MIN as f64
            && value <= i32::MAX as f64
        {
            Ok(Slot::of(Kind::Integer, Payload::Integer(value as i32)))
        } else {
            Ok(Slot::of(Kind::Number, Payload::Number(value)))
        }
    }

    /// Parse a JSON string token starting at the opening quote, returning the
    /// unescaped UTF-16 code units. JSON `\u` escapes append exactly one code
    /// unit, so both valid surrogate pairs and lone surrogates survive in a
    /// parsed string value. Malformed escapes throw a SyntaxError.
    fn json_parse_string_units(&mut self, input: &[u8], pos: &mut usize) -> Result<Vec<u16>, Step> {
        let n = input.len();
        let mut i = *pos + 1; // past opening quote
        let mut out: Vec<u16> = Vec::new();
        loop {
            if i >= n {
                return Err(self.catchable_syntax_error());
            }
            let c = input[i];
            if c == b'"' {
                i += 1;
                break;
            } else if c == b'\\' {
                i += 1;
                if i >= n {
                    return Err(self.catchable_syntax_error());
                }
                match input[i] {
                    b'"' => self.push_prepaid_scratch(&mut out, b'"' as u16)?,
                    b'\\' => self.push_prepaid_scratch(&mut out, b'\\' as u16)?,
                    b'/' => self.push_prepaid_scratch(&mut out, b'/' as u16)?,
                    b'b' => self.push_prepaid_scratch(&mut out, 8)?,
                    b'f' => self.push_prepaid_scratch(&mut out, 12)?,
                    b'n' => self.push_prepaid_scratch(&mut out, b'\n' as u16)?,
                    b'r' => self.push_prepaid_scratch(&mut out, b'\r' as u16)?,
                    b't' => self.push_prepaid_scratch(&mut out, b'\t' as u16)?,
                    b'u' => {
                        if i + 4 >= n {
                            return Err(self.catchable_syntax_error());
                        }
                        let hex = match std::str::from_utf8(&input[i + 1..i + 5])
                            .ok()
                            .and_then(|h| u32::from_str_radix(h, 16).ok())
                        {
                            Some(v) => v,
                            None => return Err(self.catchable_syntax_error()),
                        };
                        self.push_prepaid_scratch(&mut out, hex as u16)?;
                        i += 4;
                    }
                    _ => return Err(self.catchable_syntax_error()),
                }
                i += 1;
            } else if c < 0x20 {
                // A raw control character is a JSON syntax error.
                return Err(self.catchable_syntax_error());
            } else if c < 0x80 {
                self.push_prepaid_scratch(&mut out, c as u16)?;
                i += 1;
            } else {
                // A raw multi-byte scalar is already valid UTF-8 (the parse
                // entry gate rejected unpaired UTF-16). Decode its complete
                // sequence into the exact one- or two-code-unit UTF-16
                // representation.
                let width = if c < 0xe0 {
                    2
                } else if c < 0xf0 {
                    3
                } else {
                    4
                };
                let rest = input
                    .get(i..i + width)
                    .ok_or_else(|| self.catchable_syntax_error())?;
                match std::str::from_utf8(rest)
                    .ok()
                    .and_then(|s| s.chars().next())
                {
                    Some(ch) => {
                        let l = ch.len_utf8();
                        let mut encoded = [0u16; 2];
                        self.extend_prepaid_scratch(&mut out, ch.encode_utf16(&mut encoded))?;
                        i += l;
                    }
                    _ => return Err(self.catchable_syntax_error()),
                }
            }
        }
        *pos = i;
        Ok(out)
    }

    /// Parse a JSON array (`fxParseJSONArray`): the instance's two slots, one
    /// linked slot per element, and the one-time `fxCacheArray` item chunk
    /// (`length * sizeof(txSlot)` = `length * 32`, plus the chunk header).
    fn json_parse_array(
        &mut self,
        input: &[u8],
        pos: &mut usize,
        track_source: bool,
    ) -> Result<(Slot, JsonSource), Step> {
        *pos += 1; // past '['
        self.charge_and_check(JSON_PARSE_ARRAY_INSTANCE_METERING)?;
        let inst = self.new_array_unmetered();
        let mut length: u32 = 0;
        let mut sources = Vec::new();
        self.json_parse_whitespace(input, pos);
        if *pos < input.len() && input[*pos] == b']' {
            *pos += 1;
            self.arrays.get_mut(&inst).unwrap().length = 0;
            return Ok((
                Slot::of(Kind::Reference, Payload::Reference(inst)),
                if track_source {
                    JsonSource::Array(sources)
                } else {
                    JsonSource::Empty
                },
            ));
        }
        loop {
            self.json_parse_whitespace(input, pos);
            self.charge_and_check(
                JSON_PARSE_ARRAY_ELEMENT_METERING + 32 + if length == 0 { 16 } else { 0 },
            )?;
            let (v, source) = self.json_parse_value(input, pos, track_source)?;
            self.admit_scratch::<Slot>(length as usize + 1)?;
            self.arrays
                .get_mut(&inst)
                .unwrap()
                .insert_item(length, v, &mut self.side_refs);
            if track_source {
                self.push_prepaid_scratch(&mut sources, source)?;
            }
            length += 1;
            self.json_parse_whitespace(input, pos);
            match input.get(*pos) {
                Some(b',') => {
                    *pos += 1;
                }
                Some(b']') => {
                    *pos += 1;
                    break;
                }
                _ => return Err(self.catchable_syntax_error()),
            }
        }
        self.arrays.get_mut(&inst).unwrap().length = length;
        // `fxCacheArray`: one chunk of `length * sizeof(txSlot)` bytes.

        Ok((
            Slot::of(Kind::Reference, Payload::Reference(inst)),
            if track_source {
                JsonSource::Array(sources)
            } else {
                JsonSource::Empty
            },
        ))
    }

    /// Parse a JSON object (`fxParseJSONObject`): the instance slot, and per
    /// member the fixed body, the key-name intern (a novel name allocates one
    /// key slot), the key-string tokenizer chunk, and the value's node cost.
    fn json_parse_object(
        &mut self,
        input: &[u8],
        pos: &mut usize,
        track_source: bool,
    ) -> Result<(Slot, JsonSource), Step> {
        *pos += 1; // past '{'
        self.charge_and_check(JSON_PARSE_OBJECT_INSTANCE_METERING)?;
        let inst = self.slots.alloc(Slot::instance(self.object_proto));
        let mut sources = Vec::new();
        let mut member_count = 0usize;
        // Key → its position in `sources`, so a repeated key replaces in O(1).
        let mut source_positions: std::collections::HashMap<ReadKey, usize> =
            std::collections::HashMap::new();
        self.json_parse_whitespace(input, pos);
        if *pos < input.len() && input[*pos] == b'}' {
            *pos += 1;
            return Ok((
                Slot::of(Kind::Reference, Payload::Reference(inst)),
                if track_source {
                    JsonSource::Object(sources)
                } else {
                    JsonSource::Empty
                },
            ));
        }
        loop {
            self.json_parse_whitespace(input, pos);
            if *pos >= input.len() || input[*pos] != b'"' {
                return Err(self.catchable_syntax_error());
            }
            let key_units = self.json_parse_string_units(input, pos)?;
            let key = SymbolName::from_units(&key_units);
            self.charge_and_check(JSON_PARSE_OBJECT_KEY_METERING)?;
            // The key-string tokenizer chunk (`fxNewChunk(size + 1)`).
            self.charge_and_check(string_chunk_cost(key_units.len() as u64))?;
            // A canonical INDEX key goes to the index store; only a real name
            // is interned. `fxNewName` is not reached for an index in XS
            // either, and parsing `{"0":…,"1":…}` with 70,000 index keys
            // minted 70,000 names — so an identity reviver over such an
            // object poisoned the machine during the PARSE, before any
            // revival ran.
            let key_ref = match key.as_str().and_then(string_to_index) {
                Some(index) if self.indexes_by_index(inst) => ReadKey::Index(index),
                // A novel name allocates one key slot (metered directly by
                // `intern_key`), a known name none.
                _ => ReadKey::Id(self.intern_key(&key)),
            };
            self.json_parse_whitespace(input, pos);
            if *pos >= input.len() || input[*pos] != b':' {
                return Err(self.catchable_syntax_error());
            }
            *pos += 1;
            self.json_parse_whitespace(input, pos);
            let (v, source) = self.json_parse_value(input, pos, track_source)?;
            member_count = member_count
                .checked_add(1)
                .ok_or(Step::Host(Halt::HeapExhausted))?;
            self.admit_scratch::<(ReadKey, Slot)>(member_count)?;
            match key_ref {
                ReadKey::Id(id) => self.set_own_unmetered(inst, id, v),
                ReadKey::Index(index) => self.index_prop_set(inst, index, v),
            }
            if track_source {
                // Positions by key, not a linear scan: JSON allows a repeated
                // key and the last one wins, but scanning the accumulated list
                // per key is quadratic. It was unreachable while the parse
                // exhausted the key space first; with index keys stored by
                // index, `JSON.parse` of a 70,000-key object with a reviver
                // completes — and took seventeen minutes doing this scan.
                match source_positions.get(&key_ref) {
                    Some(&at) => sources[at].1 = source,
                    None => {
                        self.admit_scratch::<(ReadKey, usize)>(source_positions.len() + 1)?;
                        source_positions
                            .try_reserve(1)
                            .map_err(|_| Step::Host(Halt::HeapExhausted))?;
                        source_positions.insert(key_ref, sources.len());
                        self.push_prepaid_scratch(&mut sources, (key_ref, source))?;
                    }
                }
            }
            self.json_parse_whitespace(input, pos);
            match input.get(*pos) {
                Some(b',') => {
                    *pos += 1;
                }
                Some(b'}') => {
                    *pos += 1;
                    break;
                }
                _ => return Err(self.catchable_syntax_error()),
            }
        }
        Ok((
            Slot::of(Kind::Reference, Payload::Reference(inst)),
            if track_source {
                JsonSource::Object(sources)
            } else {
                JsonSource::Empty
            },
        ))
    }

    /// `InternalizeJSONProperty(holder, name, reviver)`, including the pinned
    /// XS implementation of the ES2024 reviver `context.source` extension.
    /// The property value is read at visit time, so an earlier reviver call can
    /// replace or delete a later sibling exactly as the specification permits
    /// — with a structure of any depth, so each level of the walk is one light
    /// frame of the native-recursion budget (XS's `mxCheckCStack` boundary,
    /// as a counter).
    fn json_internalize_property(
        &mut self,
        code: &[u8],
        input: &[u8],
        holder: crate::value::SlotIndex,
        name: ReadKey,
        source: Option<JsonSource>,
        reviver: Slot,
    ) -> Result<Slot, Step> {
        self.with_native_frame(LIGHT_FRAME_COST, |vm| {
            vm.json_internalize_property_inner(code, input, holder, name, source, reviver)
        })
    }

    fn json_internalize_property_inner(
        &mut self,
        code: &[u8],
        input: &[u8],
        holder: crate::value::SlotIndex,
        name: ReadKey,
        source: Option<JsonSource>,
        reviver: Slot,
    ) -> Result<Slot, Step> {
        let holder_slot = Slot::of(Kind::Reference, Payload::Reference(holder));
        let value = self.mop_get_read(code, holder, name, holder_slot)?;
        if let Payload::Reference(object) = value.value {
            if value.kind == Kind::Reference {
                if self.array_generic_is_array(object)? {
                    let length = self.array_generic_length(code, object)?;
                    for index in 0..length {
                        // The walk VISITS each element; it creates nothing
                        // that was not already parsed. Naming every index of
                        // a 70,000-element array to visit it exhausted the
                        // `u16` id space, so `JSON.parse(json, function (k,
                        // v) { return v })` — an identity reviver, the most
                        // common one there is — poisoned the machine.
                        let key = self.array_index_read_key(index);
                        let child_source = match source.as_ref() {
                            Some(JsonSource::Array(children)) => usize::try_from(index)
                                .ok()
                                .and_then(|i| children.get(i).cloned()),
                            _ => None,
                        };
                        let revived = self.json_internalize_property(
                            code,
                            input,
                            object,
                            key,
                            child_source,
                            reviver,
                        )?;
                        // The reviver is guest code and can have named this
                        // index while it ran.
                        let key = self.refresh_read_key(key);
                        if revived.kind == Kind::Undefined {
                            let _ = self.mop_delete_read(code, object, key)?;
                        } else {
                            self.json_create_data_property_read(code, object, key, revived)?;
                        }
                    }
                } else {
                    let keys = self.json_enumerable_own_string_keys(code, object)?;
                    // Index the retained sources ONCE. Scanning them per key
                    // is quadratic in the object's size, and measurably so:
                    // reviving a 70,000-key object spent seventeen minutes
                    // here while the parse that produced it took under a
                    // second. Key order here is `[[OwnPropertyKeys]]` order
                    // and the sources are in parse order, so this cannot be
                    // done positionally.
                    let child_sources: Option<std::collections::HashMap<ReadKey, JsonSource>> =
                        match source.as_ref() {
                            Some(JsonSource::Object(children)) => Some(
                                children
                                    .iter()
                                    .map(|(k, child)| (self.refresh_read_key(*k), child.clone()))
                                    .collect(),
                            ),
                            _ => None,
                        };
                    for key in keys {
                        let child_source = child_sources
                            .as_ref()
                            .and_then(|m| m.get(&self.refresh_read_key(key)).cloned());
                        let revived = self.json_internalize_property(
                            code,
                            input,
                            object,
                            key,
                            child_source,
                            reviver,
                        )?;
                        // The reviver is guest code and can have named this
                        // key while it ran.
                        let key = self.refresh_read_key(key);
                        if revived.kind == Kind::Undefined {
                            let _ = self.mop_delete_read(code, object, key)?;
                        } else {
                            self.json_create_data_property_read(code, object, key, revived)?;
                        }
                    }
                }
            }
        }
        let key = self.read_key_slot(name)?;
        let context = self.json_reviver_context(input, source.as_ref(), value);
        self.run_callback(code, reviver, holder_slot, &[key, value, context])
    }

    /// Snapshot the enumerable own string keys used by the object branch of
    /// `InternalizeJSONProperty`. Both key enumeration and descriptor reads go
    /// through the MOP so a replacement Proxy remains fully observable.
    fn json_enumerable_own_string_keys(
        &mut self,
        code: &[u8],
        object: crate::value::SlotIndex,
    ) -> Result<Vec<ReadKey>, Step> {
        let keys = self.mop_own_keys(code, object)?;
        let mut out = Vec::new();
        for key in keys {
            if key.kind == Kind::Symbol {
                continue;
            }
            // By INDEX where the key is one: snapshotting the key set is pure
            // observation, and naming every index of a 70,000-key object to
            // ask whether it is enumerable exhausted the key space — so an
            // identity reviver over such an object poisoned the machine even
            // after the array branch stopped minting.
            let key = self.to_read_key(code, key)?;
            if self
                .mop_get_own_property_read(code, object, key)?
                .is_some_and(|descriptor| descriptor.enumerable == Some(true))
            {
                out.push(key);
            }
        }
        Ok(out)
    }

    /// `CreateDataProperty` for a revived child, keyed by [`ReadKey`] so
    /// revising an element back into place needs no name (an index is reached
    /// by index). A false return is deliberately ignored: the abstract
    /// operation is not the throwing variant here.
    fn json_create_data_property_read(
        &mut self,
        code: &[u8],
        object: crate::value::SlotIndex,
        key: ReadKey,
        value: Slot,
    ) -> Result<(), Step> {
        let descriptor = OrdinaryDescriptor {
            value: Some(value),
            writable: Some(true),
            enumerable: Some(true),
            configurable: Some(true),
            ..OrdinaryDescriptor::default()
        };
        let _ = self.mop_define_own_property_read(code, object, key, descriptor)?;
        Ok(())
    }

    /// Allocate the reviver's always-present context object. Primitive values
    /// whose current value is SameValue to the parser's original token receive
    /// an own `source` string containing the exact JSON token; containers and
    /// observably replaced primitives receive an empty object.
    fn json_reviver_context(
        &mut self,
        input: &[u8],
        source: Option<&JsonSource>,
        value: Slot,
    ) -> Slot {
        let context = self.slots.alloc(Slot::instance(self.object_proto));
        if let Some(JsonSource::Primitive {
            original,
            start,
            end,
        }) = source
        {
            if self.same_value(*original, value) && *start <= *end && *end <= input.len() {
                let source_value = self.new_string_metered(&input[*start..*end]);
                let source_id = self.intern_key("source");
                self.set_own_unmetered(context, source_id, source_value);
            }
        }
        Slot::of(Kind::Reference, Payload::Reference(context))
    }
}
