//! VM-facing string builtin algorithms.
use super::super::*;

impl Interp {
    /// The UTF-16 code units of a string receiver, for a primitive string or a
    /// boxed `String` wrapper. Returns `None` for other receivers;
    /// `string_this_units` rejects nullish receivers and performs observable
    /// ToString conversion for the others.
    pub(in crate::interp) fn string_receiver_units(&self, this: Slot) -> Option<Vec<u16>> {
        self.string_receiver_offset(this)
            .map(|off| self.str_units(off))
    }

    /// Retain an immutable string's arena address rather than materializing it.
    /// Primitive and boxed-string receivers follow the same branding path as
    /// `string_receiver_units`; other receivers still use its ToString path.
    fn string_receiver_offset(&self, this: Slot) -> Option<crate::value::ChunkOffset> {
        match this.value {
            Payload::String(off) => Some(off),
            Payload::Reference(r) => match self.wrapper_data.get(&r).map(|s| s.value) {
                Some(Payload::String(off)) => Some(off),
                _ => None,
            },
            _ => None,
        }
    }

    /// `RequireObjectCoercible(this)` followed by `ToString(this)` for the
    /// generic String prototype algorithms.
    pub(in crate::interp) fn string_this_units(
        &mut self,
        code: &[u8],
        this: Slot,
    ) -> Result<Vec<u16>, Step> {
        if this.kind == Kind::Undefined {
            return Err(self.catchable_type_error_msg("this: undefined".into()));
        }
        if this.kind == Kind::Null {
            return Err(self.catchable_type_error_msg("this: null".into()));
        }
        if let Some(units) = self.string_receiver_units(this) {
            return Ok(units);
        }
        self.to_string_units(code, this)
    }

    /// String constructor statics. Both consume numeric arguments through
    /// the shared `ToNumber` path, preserving the observable left-to-right
    /// coercion order.
    pub(in crate::interp) fn call_string_static(
        &mut self,
        m: NativeMethod,
        base: usize,
        argc: usize,
        code: &[u8],
    ) -> Result<Slot, Step> {
        if self
            .stack
            .get(base)
            .is_some_and(|this| this.kind == Kind::Uninitialized)
        {
            return Err(self.catchable_type_error_msg("new: not a constructor".into()));
        }
        let mut out = self.reserve_scratch(argc.saturating_mul(2))?;
        for i in 0..argc {
            let value = self
                .stack
                .get(base + 4 + i)
                .copied()
                .unwrap_or_else(Slot::undefined);
            let n = self.to_number_f64(code, value)?;
            match m {
                NativeMethod::StringFromCharCode => {
                    let integer = if !n.is_finite() || n == 0.0 {
                        0i64
                    } else {
                        n.trunc() as i64
                    };
                    out.push(integer.rem_euclid(0x1_0000) as u16);
                }
                NativeMethod::StringFromCodePoint => {
                    if !n.is_finite() || n.fract() != 0.0 || !(0.0..=0x10_FFFF as f64).contains(&n)
                    {
                        let number = if n.is_nan() {
                            "nan".into()
                        } else {
                            format!("{n:.6}")
                        };
                        // xsAPI.c fxThrowMessage uses a 128-byte C buffer.
                        // This diagnostic is ASCII, so byte truncation is exact.
                        let mut message = format!("invalid code point {number}");
                        message.truncate(127);
                        return Err(self.catchable_range_error_msg(message));
                    }
                    let cp = n as u32;
                    if cp <= 0xFFFF {
                        out.push(cp as u16);
                    } else {
                        let x = cp - 0x10000;
                        out.push(0xD800 + (x >> 10) as u16);
                        out.push(0xDC00 + (x & 0x3FF) as u16);
                    }
                }
                _ => unreachable!(),
            }
        }
        Ok(self.new_string_units(&out))
    }

    /// `String.raw(template, ...substitutions)`: convert `template` and its
    /// live `raw` property to objects, obtain the array-like length through
    /// `ToLength`, then interleave each observable literal segment with the
    /// corresponding substitution. All string conversion remains in UTF-16
    /// units so lone surrogates survive unchanged.
    pub(in crate::interp) fn call_string_raw(
        &mut self,
        base: usize,
        argc: usize,
        code: &[u8],
    ) -> Result<Slot, Step> {
        if self
            .stack
            .get(base)
            .is_some_and(|this| this.kind == Kind::Uninitialized)
        {
            return Err(self.catchable_type_error_msg("new: not a constructor".into()));
        }
        let template = self
            .stack
            .get(base + 4)
            .copied()
            .unwrap_or_else(Slot::undefined);
        let cooked = self.array_to_object(template)?;
        let Payload::Reference(cooked_inst) = cooked.value else {
            unreachable!("ToObject returns an object")
        };
        let raw_id = self.intern_static_key("raw");
        let raw = self.mop_get(code, cooked_inst, raw_id, cooked)?;
        let raw = self.array_to_object(raw)?;
        let Payload::Reference(raw_inst) = raw.value else {
            unreachable!("ToObject returns an object")
        };
        let length = self.arraylike_length(code, raw_inst, raw)?;
        let literal_segments = self.to_length_value(code, length)?;
        if literal_segments == 0 {
            return Ok(self.new_string_units(&[]));
        }
        const STRING_RAW_SEGMENT_CAP: u64 = 1 << 24;
        if literal_segments > STRING_RAW_SEGMENT_CAP {
            return Err(Step::Host(Halt::Refused("String.raw:oversized-template")));
        }

        let substitutions = argc.saturating_sub(1) as u64;
        let mut out = Vec::new();
        for index in 0..literal_segments {
            let id = self.array_generic_index_id(index)?;
            let segment = self.mop_get(code, raw_inst, id, raw)?;
            let units = self.to_string_units(code, segment)?;
            self.extend_reserved_units(&mut out, &units)?;
            if index + 1 == literal_segments {
                break;
            }
            if index < substitutions {
                let substitution = self
                    .stack
                    .get(base + 5 + index as usize)
                    .copied()
                    .unwrap_or_else(Slot::undefined);
                let units = self.to_string_units(code, substitution)?;
                self.extend_reserved_units(&mut out, &units)?;
            }
        }
        Ok(self.new_reserved_string_units(&out))
    }

    /// `ToIntegerOrInfinity` followed by the relative-index adjustment used by
    /// `String.prototype.slice`. `undefined` selects `default`; negative finite
    /// values count from the end, and infinities clamp to the corresponding
    /// boundary.
    fn string_arg_to_index(
        &mut self,
        code: &[u8],
        arg: Option<Slot>,
        default: i64,
        len: i64,
    ) -> Result<i64, Step> {
        let Some(value) = arg.filter(|value| value.kind != Kind::Undefined) else {
            return Ok(default);
        };
        let integer = self.array_to_integer_or_infinity(code, value)?;
        if integer == f64::NEG_INFINITY {
            return Ok(0);
        }
        if integer < 0.0 {
            return Ok((len as f64 + integer).max(0.0) as i64);
        }
        Ok(integer.min(len as f64) as i64)
    }

    /// `ToIntegerOrInfinity` followed by the absolute-position clamp used by
    /// String indexing/search methods and `substring`.
    fn string_arg_to_position(
        &mut self,
        code: &[u8],
        arg: Option<Slot>,
        default: i64,
        len: i64,
    ) -> Result<i64, Step> {
        let Some(value) = arg.filter(|value| value.kind != Kind::Undefined) else {
            return Ok(default);
        };
        let integer = self.array_to_integer_or_infinity(code, value)?;
        Ok(integer.clamp(0.0, len as f64) as i64)
    }

    /// Dispatch a `String.prototype` method (`xsString.c`) over the primitive
    /// receiver's UTF-16 code units (the stored form — indexing is direct, no
    /// boundary walk). Numeric arguments pass through the shared
    /// `ToIntegerOrInfinity` machinery, including observable `ToPrimitive`
    /// calls and catchable BigInt/Symbol errors. Meters exactly the pin's
    /// `mxMeterSome` + `fxNewChunk` (re-based to code-unit length), plus the
    /// (zero) native frame.
    /// Index-addressed String methods never decode the whole primitive/wrapper
    /// receiver. Reacquire the arena slice for each read, so guest coercions may
    /// allocate without a live ChunkSlice borrow across that re-entry.
    fn call_string_indexed(
        &mut self,
        m: NativeMethod,
        this: Slot,
        base: usize,
        argc: usize,
        code: &[u8],
    ) -> Result<Slot, Step> {
        if this.kind == Kind::Undefined {
            return Err(self.catchable_type_error_msg("this: undefined".into()));
        }
        if this.kind == Kind::Null {
            return Err(self.catchable_type_error_msg("this: null".into()));
        }
        let branded = self.string_receiver_offset(this);
        let primitive = if branded.is_none() && this.kind == Kind::Reference {
            self.to_primitive(code, this, true)?
        } else {
            this
        };
        let offset = branded.or(match primitive.value {
            Payload::String(off) => Some(off),
            _ => None,
        });
        let fallback = if offset.is_none() {
            // Non-string primitives need formatting; a string returned by a
            // generic receiver's ToPrimitive retains its offset above too.
            self.to_string_units(code, primitive)?
        } else {
            Vec::new()
        };
        let length = offset.map_or(fallback.len(), |off| self.str_len(off));
        let ulen = length as i64;
        let clamp = |unit: i64| -> usize { unit.clamp(0, ulen) as usize };
        let unit_at = |machine: &Self, index: usize| -> u16 {
            match offset {
                Some(off) => machine
                    .str_unit_at(off, index as u32)
                    .expect("in-range string index"),
                None => fallback[index],
            }
        };
        let args: Vec<Slot> = (0..argc)
            .map(|i| {
                self.stack
                    .get(base + 4 + i)
                    .copied()
                    .unwrap_or_else(Slot::undefined)
            })
            .collect();
        let argn = |i: usize| -> Option<Slot> { args.get(i).copied() };
        self.meter.tick_raw(STRING_METHOD_FRAME_METERING);
        use NativeMethod::*;
        let result = match m {
            StringSlice | StringSubstring => {
                // Convert in receiver/start/end order before borrowing any
                // arena bytes: coercion can allocate or re-enter the guest.
                let (start, end) = if m == StringSlice {
                    let start = self.string_arg_to_index(code, argn(0), 0, ulen)?;
                    let end = self.string_arg_to_index(code, argn(1), ulen, ulen)?;
                    (clamp(start), clamp(end).max(clamp(start)))
                } else {
                    let start = self.string_arg_to_position(code, argn(0), 0, ulen)?;
                    let end = self.string_arg_to_position(code, argn(1), ulen, ulen)?;
                    (clamp(start.min(end)), clamp(start.max(end)))
                };
                let count = self.reserve_units((end - start) as u64)?;
                let mut units = Self::reserved_vec(count)?;
                if let Some(off) = offset {
                    let bytes = self
                        .chunks
                        .payload_range(off, start * 2..end * 2)
                        .ok_or(Step::Host(Halt::EngineInvariant("string:slice-range")))?;
                    units.extend(
                        bytes
                            .chunks_exact(2)
                            .map(|pair| u16::from_be_bytes([pair[0], pair[1]])),
                    );
                } else {
                    units.extend_from_slice(&fallback[start..end]);
                }
                self.new_reserved_string_units(&units)
            }
            // charCodeAt(pos): the UTF-16 code unit at `pos`, else NaN. No
            // chunk, no mxMeterSome.
            StringCharCodeAt => {
                let pos = match argn(0) {
                    Some(s) if s.kind != Kind::Undefined => {
                        let n = self.array_to_integer_or_infinity(code, s)?;
                        if n < 0.0 {
                            return Ok(Slot::number(f64::NAN));
                        }
                        n as i64
                    }
                    _ => 0,
                };
                if pos < ulen {
                    Slot::integer(unit_at(self, pos as usize) as i32)
                } else {
                    Slot::number(f64::NAN)
                }
            }
            // codePointAt(pos): the code point at `pos` (combining a surrogate
            // pair into an astral scalar), else undefined.
            StringCodePointAt => {
                let pos = match argn(0) {
                    Some(s) if s.kind != Kind::Undefined => {
                        self.array_to_integer_or_infinity(code, s)? as i64
                    }
                    _ => 0,
                };
                if pos >= 0 && pos < ulen {
                    let hi = unit_at(self, pos as usize) as u32;
                    let cp = if (0xD800..=0xDBFF).contains(&hi) && pos + 1 < ulen {
                        let lo = unit_at(self, (pos + 1) as usize) as u32;
                        if (0xDC00..=0xDFFF).contains(&lo) {
                            0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00)
                        } else {
                            hi
                        }
                    } else {
                        hi
                    };
                    Slot::integer(cp as i32)
                } else {
                    Slot::undefined()
                }
            }
            // charAt(pos): the one-unit string at `pos`, else "". A negative
            // `pos` fails to the empty string (XS's `goto fail`).
            StringCharAt => {
                let pos = match argn(0) {
                    Some(s) if s.kind != Kind::Undefined => {
                        self.array_to_integer_or_infinity(code, s)? as i64
                    }
                    _ => 0,
                };
                if pos < 0 || pos >= ulen {
                    self.new_string_units(&[])
                } else {
                    self.new_string_units(&[unit_at(self, pos as usize)])
                }
            }
            // at(index): the one-unit string at `index` (negative from the
            // end), else undefined.
            StringAt => {
                let idx = match argn(0) {
                    Some(s) => self.array_to_integer_or_infinity(code, s)? as i64,
                    None => 0,
                };
                let idx = if idx < 0 { idx + ulen } else { idx };
                if idx < 0 || idx >= ulen {
                    Slot::undefined()
                } else {
                    self.new_string_units(&[unit_at(self, idx as usize)])
                }
            }
            // startsWith / endsWith: reject `IsRegExp(searchString)`, then
            // `ToString(searchString)`, then mxMeterSome(searchUnitLen) and a
            // byte compare (no per-byte meter).
            StringStartsWith | StringEndsWith => {
                let search = argn(0).unwrap_or_else(Slot::undefined);
                if self.string_is_regexp(code, search)? {
                    return Err(self.catchable_type_error_msg("future editions".into()));
                }
                let sub = self.to_string_units(code, search)?;
                let sub_units = sub.len() as u64;
                let is_start = m == StringStartsWith;
                // The position argument (code unit), clamped to [0, ulen].
                let pos = if is_start {
                    self.string_arg_to_position(code, argn(1), 0, ulen)?
                } else {
                    self.string_arg_to_position(code, argn(1), ulen, ulen)?
                };
                self.charge_and_check(STRING_METERSOME_FRAME_METERING)?;
                self.charge_builtin_work(sub_units)?;
                let at = clamp(pos);
                let matches = if is_start {
                    length >= at + sub.len()
                        && sub
                            .iter()
                            .enumerate()
                            .all(|(i, &unit)| unit_at(self, at + i) == unit)
                } else {
                    at >= sub.len()
                        && sub
                            .iter()
                            .enumerate()
                            .all(|(i, &unit)| unit_at(self, at - sub.len() + i) == unit)
                };
                Slot::boolean(matches)
            }
            // includes(search[,from]): whether `search` occurs. Charges the
            // fixed search-argument residual; its `includes_aux` scan does NOT
            // meter the per-byte compares (measured against the pin — a
            // distinct host-frame shape from `indexOf`), so the search runs
            // unmetered.
            StringIncludes => {
                let search = argn(0).unwrap_or_else(Slot::undefined);
                if self.string_is_regexp(code, search)? {
                    return Err(self.catchable_type_error_msg("future editions".into()));
                }
                let sub = self.to_string_units(code, search)?;
                let from = self.string_arg_to_position(code, argn(1), 0, ulen)?;
                self.meter.tick_raw(STRING_METERSOME_FRAME_METERING);
                let bfrom = clamp(from).min(length);
                let found = sub.is_empty()
                    || (sub.len() <= length - bfrom
                        && (bfrom..=length - sub.len()).any(|at| {
                            sub.iter()
                                .enumerate()
                                .all(|(i, &unit)| unit_at(self, at + i) == unit)
                        }));
                Slot::boolean(found)
            }
            // indexOf / lastIndexOf: search in UTF-16 code units, after the
            // observable ToString(searchString) and ToIntegerOrInfinity(position)
            // coercions. XS's inner UTF-8 scan meters only the matching prefix
            // at each candidate (one raw tick per CESU-8 leading byte because
            // of the pinned macro-precedence quirk), including a full match;
            // `string_search_match_meter` translates that charge to the VM's
            // UTF-16 storage without losing astral/lone-surrogate behavior.
            StringIndexOf | StringLastIndexOf => {
                let search = self.to_string_units(code, argn(0).unwrap_or_else(Slot::undefined))?;
                let last = m == StringLastIndexOf;
                let position =
                    if last && (argc < 2 || argn(1).is_some_and(|v| v.kind == Kind::Undefined)) {
                        f64::INFINITY
                    } else if argc < 2 {
                        0.0
                    } else if last {
                        // `lastIndexOf` maps *any* NaN position to +INFINITY, not
                        // only a missing or `undefined` one, so it cannot share
                        // `ToIntegerOrInfinity`'s NaN-to-zero rule.
                        self.string_last_index_of_position(
                            code,
                            argn(1).unwrap_or_else(Slot::undefined),
                        )?
                    } else {
                        self.array_to_integer_or_infinity(
                            code,
                            argn(1).unwrap_or_else(Slot::undefined),
                        )?
                    };
                let start = if position == f64::INFINITY {
                    length
                } else if position == f64::NEG_INFINITY || position <= 0.0 {
                    0
                } else if position >= length as f64 {
                    length
                } else {
                    position as usize
                };
                self.meter.tick_raw(STRING_INDEX_FRAME_METERING);

                if search.is_empty() {
                    Self::array_index_number(start as u64)
                } else if search.len() > length {
                    Slot::integer(-1)
                } else if last {
                    let mut candidate = start.min(length - search.len());
                    loop {
                        let mut matched = 0usize;
                        while matched < search.len()
                            && unit_at(self, candidate + matched) == search[matched]
                        {
                            self.charge_and_check(1)?;
                            matched += 1;
                        }
                        if matched == search.len() {
                            break Self::array_index_number(candidate as u64);
                        }
                        if candidate == 0 {
                            break Slot::integer(-1);
                        }
                        candidate -= 1;
                    }
                } else if start + search.len() > length {
                    Slot::integer(-1)
                } else {
                    let limit = length - search.len();
                    let mut candidate = start;
                    loop {
                        let mut matched = 0usize;
                        while matched < search.len()
                            && unit_at(self, candidate + matched) == search[matched]
                        {
                            self.charge_and_check(1)?;
                            matched += 1;
                        }
                        if matched == search.len() {
                            break Self::array_index_number(candidate as u64);
                        }
                        if candidate == limit {
                            break Slot::integer(-1);
                        }
                        candidate += 1;
                    }
                }
            }
            _ => unreachable!("only indexed String methods enter this helper"),
        };
        Ok(result)
    }

    pub(in crate::interp) fn call_string(
        &mut self,
        m: NativeMethod,
        this: Slot,
        base: usize,
        argc: usize,
        code: &[u8],
    ) -> Result<Slot, Step> {
        if matches!(
            m,
            NativeMethod::StringCharCodeAt
                | NativeMethod::StringCodePointAt
                | NativeMethod::StringCharAt
                | NativeMethod::StringAt
                | NativeMethod::StringStartsWith
                | NativeMethod::StringEndsWith
                | NativeMethod::StringIncludes
                | NativeMethod::StringIndexOf
                | NativeMethod::StringLastIndexOf
                | NativeMethod::StringSlice
                | NativeMethod::StringSubstring
        ) {
            return self.call_string_indexed(m, this, base, argc, code);
        }
        let content = self.string_this_units(code, this)?;
        let ulen = content.len() as i64; // UTF-16 code-unit length
        let args: Vec<Slot> = (0..argc)
            .map(|i| {
                self.stack
                    .get(base + 4 + i)
                    .copied()
                    .unwrap_or_else(Slot::undefined)
            })
            .collect();
        let argn = |i: usize| -> Option<Slot> { args.get(i).copied() };
        self.meter.tick_raw(STRING_METHOD_FRAME_METERING);
        use NativeMethod::*;
        let result = match m {
            // concat(...args): the receiver followed by each stringified
            // argument; mxMeterSome(argc) + the result chunk. Argument
            // `ToString` conversions run left-to-right and may re-enter guest
            // code or throw.
            StringConcat => {
                self.charge_and_check(STRING_METERSOME_FRAME_METERING)?;
                self.charge_builtin_work(argc as u64)?;
                let mut out = Vec::new();
                self.extend_reserved_units(&mut out, &content)?;
                for i in 0..argc {
                    let a = argn(i).unwrap();
                    let units = self.to_string_units(code, a)?;
                    self.extend_reserved_units(&mut out, &units)?;
                }
                self.new_reserved_string_units(&out)
            }
            // repeat(count): the receiver repeated `count` times; a negative or
            // over-large count is a RangeError. mxMeterSome(count) + chunk.
            StringRepeat => {
                let count = match argn(0) {
                    Some(s) if s.kind != Kind::Undefined => {
                        let n = self.array_to_integer_or_infinity(code, s)?;
                        if n < 0.0 {
                            return Err(self.catchable_range_error_msg("count < 0".into()));
                        }
                        if n > 0x7FFF_FFFF as f64 {
                            return Err(self.catchable_range_error_msg("count too big".into()));
                        }
                        n as i64
                    }
                    _ => 0,
                };
                self.meter.tick_raw(STRING_METERSOME_FRAME_METERING);
                self.charge_and_check(count as u64 * crate::meter::BUILTIN_METERING)?;
                // XS meters `count` above but guards its copy loop with
                // `if (length)`. Repeating the empty string therefore returns
                // immediately even for the maximum accepted count instead of
                // spending billions of no-op iterations.
                if content.is_empty() {
                    return Ok(self.new_string_units(&[]));
                }
                let size = self.reserve_units(content.len() as u64 * count as u64)?;
                let mut out = Self::reserved_vec(size)?;
                for _ in 0..count {
                    out.extend_from_slice(&content);
                }
                self.new_reserved_string_units(&out)
            }
            // toLowerCase / toUpperCase: Unicode Default Case Conversion over
            // scalar values, preserving lone UTF-16 surrogates unchanged.
            // Rust's whole-string conversion supplies the locale-insensitive
            // SpecialCasing mappings, including contextual final sigma and
            // one-to-many results. Meter against the input code units, then
            // charge the actual result chunk through `new_string_units`.
            StringToLowerCase | StringToUpperCase => {
                let up = m == StringToUpperCase;
                self.charge_and_check(STRING_METERSOME_FRAME_METERING)?;
                self.charge_builtin_work(ulen as u64)?;
                let out = unicode_case_convert_utf16(self, &content, up)?;
                self.new_reserved_string_units(&out)
            }
            StringToLocaleLowerCase | StringToLocaleUpperCase => {
                let locale =
                    self.intl_resolve_locale(code, argn(0).unwrap_or_else(Slot::undefined))?;
                let up = m == StringToLocaleUpperCase;
                self.charge_and_check(STRING_METERSOME_FRAME_METERING)?;
                self.charge_builtin_work(ulen as u64)?;
                let out = unicode_locale_case_convert_utf16(self, &content, up, &locale)?;
                self.new_reserved_string_units(&out)
            }
            StringLocaleCompare => {
                let right = self.to_string_units(code, argn(0).unwrap_or_else(Slot::undefined))?;
                let locale =
                    self.intl_resolve_locale(code, argn(1).unwrap_or_else(Slot::undefined))?;
                let mut data = CollatorData {
                    locale,
                    usage: "sort".to_string(),
                    sensitivity: "variant".to_string(),
                    collation: "default".to_string(),
                    numeric: false,
                    case_first: "false".to_string(),
                    ignore_punctuation: false,
                };
                if let Some(options) =
                    self.intl_get_options_object(argn(2).unwrap_or_else(Slot::undefined))?
                {
                    self.apply_collator_options(code, options, &mut data)?;
                }
                let left = String::from_utf16_lossy(&content);
                let right = String::from_utf16_lossy(&right);
                Slot::integer(collator_compare(&data, &left, &right))
            }
            // normalize: default to NFC, otherwise coerce `form` after the
            // receiver and accept only the four exact normalization names.
            // ICU4X performs the Unicode algorithm over valid scalar runs;
            // the helper retains JavaScript's unpaired UTF-16 surrogates.
            StringNormalize => {
                let form_units = match argn(0) {
                    None
                    | Some(Slot {
                        kind: Kind::Undefined,
                        ..
                    }) => vec![0x4E, 0x46, 0x43],
                    Some(value) => self.to_string_units(code, value)?,
                };
                let form = match form_units.as_slice() {
                    [0x4E, 0x46, 0x43] => UnicodeNormalizationForm::Nfc,
                    [0x4E, 0x46, 0x44] => UnicodeNormalizationForm::Nfd,
                    [0x4E, 0x46, 0x4B, 0x43] => UnicodeNormalizationForm::Nfkc,
                    [0x4E, 0x46, 0x4B, 0x44] => UnicodeNormalizationForm::Nfkd,
                    _ => return Err(self.catchable_range_error_msg("invalid form".into())),
                };
                self.charge_and_check(STRING_METERSOME_FRAME_METERING)?;
                self.charge_builtin_work(ulen as u64)?;
                let out = unicode_normalize_utf16(self, &content, form)?;
                self.new_reserved_string_units(&out)
            }
            // trim / trimStart / trimEnd: strip the ECMAScript WhiteSpace and
            // LineTerminator code points. The pin
            // meters mxMeterSome(leading byte count) and/or mxMeterSome(kept
            // length), then allocates the result chunk.
            StringTrim | StringTrimStart | StringTrimEnd => {
                let trim_start = m != StringTrimEnd;
                let trim_end = m != StringTrimStart;
                self.meter.tick_raw(STRING_METERSOME_FRAME_METERING);
                let mut lo = 0usize;
                if trim_start {
                    while lo < content.len() && is_ecma_whitespace(content[lo] as u32) {
                        self.charge_builtin_work(1)?;
                        lo += 1;
                    }
                }
                let mut hi = content.len();
                if trim_end {
                    while hi > lo && is_ecma_whitespace(content[hi - 1] as u32) {
                        self.charge_builtin_work(1)?;
                        hi -= 1;
                    }
                    self.charge_builtin_work((hi - lo) as u64)?;
                }
                self.new_string_units(&content[lo..hi])
            }
            StringPadStart | StringPadEnd => {
                let target = self.to_length_value(code, argn(0).unwrap_or_else(Slot::undefined))?;
                if target <= content.len() as u64 {
                    self.new_string_units(&content)
                } else {
                    let fill = match argn(1) {
                        None
                        | Some(Slot {
                            kind: Kind::Undefined,
                            ..
                        }) => vec![0x20],
                        Some(v) => self.to_string_units(code, v)?,
                    };
                    if fill.is_empty() {
                        self.new_string_units(&content)
                    } else {
                        // Allocation is an implementation limit, not a guest
                        // RangeError. XS also aborts at its chunk-size limit.
                        // Coerce the filler first: an empty filler needs no
                        // allocation, even when the requested length is huge.
                        const STRING_PAD_UNIT_CAP: u64 = 1 << 24;
                        if target > STRING_PAD_UNIT_CAP {
                            return Err(Step::Host(Halt::Refused(
                                "String.prototype.pad:result-too-large",
                            )));
                        }
                        let target = self.reserve_units(target)?;
                        let needed = target - content.len();
                        let mut out = Self::reserved_vec(target)?;
                        if m == StringPadEnd {
                            out.extend_from_slice(&content);
                        }
                        let mut filled = 0;
                        while filled < needed {
                            let take = (needed - filled).min(fill.len());
                            out.extend_from_slice(&fill[..take]);
                            filled += take;
                        }
                        if m == StringPadStart {
                            out.extend_from_slice(&content);
                        }
                        self.new_reserved_string_units(&out)
                    }
                }
            }
            StringIsWellFormed | StringToWellFormed => {
                let mut well_formed = true;
                let mut out = self.reserve_scratch(content.len())?;
                let mut i = 0usize;
                while i < content.len() {
                    let u = content[i];
                    if (0xD800..=0xDBFF).contains(&u) {
                        if i + 1 < content.len() && (0xDC00..=0xDFFF).contains(&content[i + 1]) {
                            out.push(u);
                            out.push(content[i + 1]);
                            i += 2;
                            continue;
                        }
                        well_formed = false;
                        out.push(0xFFFD);
                    } else if (0xDC00..=0xDFFF).contains(&u) {
                        well_formed = false;
                        out.push(0xFFFD);
                    } else {
                        out.push(u);
                    }
                    i += 1;
                }
                if m == StringIsWellFormed {
                    Slot::boolean(well_formed)
                } else if well_formed {
                    self.new_string_units(&content)
                } else {
                    self.new_string_units(&out)
                }
            }
            StringIterator => self.make_string_iterator(units_to_be16(&content)),
            _ => return Err(Step::Host(Halt::NotImplemented("string-method:unmodeled"))),
        };
        Ok(result)
    }

    /// `ToIntegerOrInfinity(? ToNumber(v))` (ECMA-262 7.1.5): `NaN` → 0,
    /// infinities pass through, else truncate toward zero.
    /// `String.prototype.lastIndexOf`'s position coercion (ECMA-262 22.1.3.9
    /// steps 4-6): `ToNumber(position)`, and then **any** NaN becomes
    /// `+INFINITY` -- the whole string is searched -- where
    /// [`Self::array_to_integer_or_infinity`] maps NaN to 0.
    ///
    /// Step 5 only *asserts* that an `undefined` position is NaN; it is not the
    /// sole way to get there. `"abcabc".lastIndexOf("a", NaN)`,
    /// `..., "zzz")` and `..., {})` are all NaN and all answer 3, and sharing
    /// the array rule started them at 0 instead. `indexOf` genuinely wants
    /// NaN to 0, so only this branch is affected.
    ///
    /// The coercion is observable, so this repeats the body rather than
    /// calling `ToNumber` a second time to inspect it.
    fn string_last_index_of_position(&mut self, code: &[u8], v: Slot) -> Result<f64, Step> {
        let n = self.to_number_f64(code, v)?;
        if n.is_nan() {
            Ok(f64::INFINITY)
        } else if n.is_infinite() {
            Ok(n)
        } else {
            Ok(n.trunc())
        }
    }
}

#[cfg(test)]
mod slice_tests;
