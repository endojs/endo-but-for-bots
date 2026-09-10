//! Property read opcode semantics.
//! Return transfers unchanged; only the dispatch loop owns catch resumption.
use super::super::*;

impl Interp {
    pub(super) fn dispatch_get_property(&mut self, code: &[u8], id: u16) -> Result<(), Step> {
        let obj = self.pop();
        let kind = match (obj.kind, obj.value) {
            (Kind::Reference, Payload::Reference(inst)) => self.classes.get(inst),
            _ => ExoticKind::default(),
        };
        let v = match obj.value {
            Payload::Reference(inst)
                if kind.has(ExoticKind::ARRAYS)
                    && !self.arguments_objects.contains(&inst)
                    && Some(id) == self.length_id =>
            {
                // `arr.length`: the exotic-array length accessor
                // getter (`fxArrayLengthGetter`).
                self.meter.tick_raw(ARRAY_LENGTH_GET_METERING);
                Self::array_index_number(u64::from(self.arrays[&inst].length))
            }
            Payload::Reference(inst)
                if kind.has(ExoticKind::WRAPPER_DATA)
                    && Some(id) == self.length_id
                    && matches!(
                        self.wrapper_data.get(&inst),
                        Some(Slot {
                            kind: Kind::String,
                            value: Payload::String(_),
                            ..
                        })
                    ) =>
            {
                let prim = self.wrapper_data[&inst];
                let Payload::String(off) = prim.value else {
                    unreachable!()
                };
                Slot::integer(self.str_len(off) as i32)
            }
            Payload::Reference(inst) if kind.has(ExoticKind::TEMPORAL_INSTANTS) => {
                let ns = self.temporal_instants[&inst].epoch_nanoseconds;
                match self.scalar_key_text(id).as_deref() {
                    Some("epochNanoseconds") => self.temporal_i128_bigint(ns),
                    Some("epochMilliseconds") => Slot::number((ns / 1_000_000) as f64),
                    _ => self.instance_get(inst, id),
                }
            }
            Payload::Reference(inst) if kind.has(ExoticKind::TEMPORAL_DURATIONS) => {
                let d = self.temporal_durations[&inst];
                match self.scalar_key_text(id).as_deref() {
                    Some("years") => Slot::number(d.years as f64),
                    Some("months") => Slot::number(d.months as f64),
                    Some("weeks") => Slot::number(d.weeks as f64),
                    Some("days") => Slot::number(d.days as f64),
                    Some("hours") => Slot::number(d.hours as f64),
                    Some("minutes") => Slot::number(d.minutes as f64),
                    Some("seconds") => Slot::number(d.seconds as f64),
                    Some("milliseconds") => Slot::number(d.milliseconds as f64),
                    Some("microseconds") => Slot::number(d.microseconds as f64),
                    Some("nanoseconds") => Slot::number(d.nanoseconds as f64),
                    Some("sign") => Slot::number(d.sign() as f64),
                    Some("blank") => Slot::boolean(d.sign() == 0),
                    _ => self.instance_get(inst, id),
                }
            }
            Payload::Reference(inst) if kind.has(ExoticKind::TEMPORAL_PLAINS) => {
                let r = self.temporal_plains[&inst];
                let key = self.scalar_key_text(id);
                match key.as_deref() {
                    Some("year") => Slot::number(r.year as f64),
                    Some("month") => Slot::number(r.month as f64),
                    Some("monthCode") => {
                        self.new_string_metered(format!("M{:02}", r.month).as_bytes())
                    }
                    Some("day") => Slot::number(r.day as f64),
                    Some("hour") => Slot::number(r.hour as f64),
                    Some("minute") => Slot::number(r.minute as f64),
                    Some("second") => Slot::number(r.second as f64),
                    Some("millisecond") => Slot::number(r.millisecond as f64),
                    Some("microsecond") => Slot::number(r.microsecond as f64),
                    Some("nanosecond") => Slot::number(r.nanosecond as f64),
                    Some("calendarId") | Some("id") => self.new_string_metered(b"iso8601"),
                    Some("era") => {
                        self.new_string_metered(if r.year <= 0 { b"bce" } else { b"ce" })
                    }
                    Some("eraYear") => Slot::number(if r.year <= 0 {
                        (1 - r.year) as f64
                    } else {
                        r.year as f64
                    }),
                    Some("dayOfWeek") => Slot::number(
                        (days_from_civil(r.year, r.month, r.day).unwrap_or(0) + 3).rem_euclid(7)
                            as f64
                            + 1.0,
                    ),
                    Some("dayOfYear") => Slot::number(
                        (days_from_civil(r.year, r.month, r.day).unwrap_or(0)
                            - days_from_civil(r.year, 1, 1).unwrap_or(0)
                            + 1) as f64,
                    ),
                    Some("daysInMonth") => Slot::number(
                        (1..=31)
                            .rev()
                            .find(|&d| days_from_civil(r.year, r.month, d).is_some())
                            .unwrap_or(0) as f64,
                    ),
                    Some("daysInYear") => {
                        Slot::number(if days_from_civil(r.year, 2, 29).is_some() {
                            366.0
                        } else {
                            365.0
                        })
                    }
                    Some("monthsInYear") => Slot::number(12.0),
                    Some("inLeapYear") => Slot::boolean(days_from_civil(r.year, 2, 29).is_some()),
                    _ => self.instance_get(inst, id),
                }
            }
            Payload::Reference(inst) if kind.has(ExoticKind::TEMPORAL_ZONEDS) => {
                let rec = self.temporal_zoneds[&inst].clone();
                let p = zoned_local_datetime(rec.epoch_nanoseconds, rec.offset_ns);
                match self.scalar_key_text(id).as_deref() {
                    Some("year") => Slot::number(p.year as f64),
                    Some("month") => Slot::number(p.month as f64),
                    Some("monthCode") => {
                        self.new_string_metered(format!("M{:02}", p.month).as_bytes())
                    }
                    Some("day") => Slot::number(p.day as f64),
                    Some("hour") => Slot::number(p.hour as f64),
                    Some("minute") => Slot::number(p.minute as f64),
                    Some("second") => Slot::number(p.second as f64),
                    Some("millisecond") => Slot::number(p.millisecond as f64),
                    Some("microsecond") => Slot::number(p.microsecond as f64),
                    Some("nanosecond") => Slot::number(p.nanosecond as f64),
                    Some("calendarId") => self.new_string_metered(b"iso8601"),
                    Some("timeZoneId") => self.new_string_metered(rec.time_zone.as_bytes()),
                    Some("offset") => {
                        self.new_string_metered(format_offset_string(rec.offset_ns).as_bytes())
                    }
                    Some("offsetNanoseconds") => Slot::number(rec.offset_ns as f64),
                    Some("epochMilliseconds") => {
                        Slot::number(rec.epoch_nanoseconds.div_euclid(1_000_000) as f64)
                    }
                    Some("epochNanoseconds") => self.temporal_i128_bigint(rec.epoch_nanoseconds),
                    Some("hoursInDay") => Slot::number(24.0),
                    Some("dayOfWeek") => Slot::number(
                        (days_from_civil(p.year, p.month, p.day).unwrap_or(0) + 3).rem_euclid(7)
                            as f64
                            + 1.0,
                    ),
                    Some("dayOfYear") => Slot::number(
                        (days_from_civil(p.year, p.month, p.day).unwrap_or(0)
                            - days_from_civil(p.year, 1, 1).unwrap_or(0)
                            + 1) as f64,
                    ),
                    Some("weekOfYear") => {
                        let (w, _) = iso_week_of_year(p.year, p.month, p.day);
                        Slot::number(w as f64)
                    }
                    Some("yearOfWeek") => {
                        let (_, y) = iso_week_of_year(p.year, p.month, p.day);
                        Slot::number(y as f64)
                    }
                    Some("daysInWeek") => Slot::number(7.0),
                    Some("daysInMonth") => Slot::number(
                        (1..=31)
                            .rev()
                            .find(|&d| days_from_civil(p.year, p.month, d).is_some())
                            .unwrap_or(0) as f64,
                    ),
                    Some("daysInYear") => {
                        Slot::number(if days_from_civil(p.year, 2, 29).is_some() {
                            366.0
                        } else {
                            365.0
                        })
                    }
                    Some("monthsInYear") => Slot::number(12.0),
                    Some("inLeapYear") => Slot::boolean(days_from_civil(p.year, 2, 29).is_some()),
                    // The ISO 8601 calendar exposes no era/eraYear.
                    Some("era") | Some("eraYear") => Slot::undefined(),
                    _ => self.instance_get(inst, id),
                }
            }
            Payload::Reference(inst)
                if self.symbol_ids.get("disposed") == Some(&id)
                    && kind.has(ExoticKind::DISPOSABLE_STACKS) =>
            {
                Slot::boolean(self.disposable_stacks[&inst].disposed)
            }
            Payload::Reference(inst)
                if Some(id) == self.size_id
                    && kind.has(ExoticKind::COLLECTIONS)
                    && self
                        .collections
                        .get(&inst)
                        .map(|c| matches!(c.kind, CollKind::Map | CollKind::Set))
                        .unwrap_or(false) =>
            {
                // `map.size` / `set.size`: the collection size
                // accessor getter (`fx_Map_prototype_size`), reading
                // the size slot. WeakMap/WeakSet have no `size`.
                self.meter.tick_raw(COLLECTION_SIZE_GET_METERING);
                Slot::integer(self.collections[&inst].live_len() as i32)
            }
            Payload::Reference(inst)
                if (kind.has(ExoticKind::ARRAY_BUFFERS)
                    && !self.shared_buffers.contains(&inst))
                    || kind.has(ExoticKind::TYPED_ARRAYS)
                    || kind.has(ExoticKind::DATA_VIEWS) =>
            {
                // These are real accessors on the intrinsic
                // prototypes. Ordinary lookup preserves guest
                // deletion, replacement, and own-property shadows.
                (self.ordinary_get(code, inst, id, obj))?
            }
            Payload::Reference(inst)
                if Some(id) == self.byte_length_id
                    && kind.has(ExoticKind::ARRAY_BUFFERS)
                    && self.shared_buffers.contains(&inst) =>
            {
                self.meter.tick_raw(ARRAY_BUFFER_BYTE_LENGTH_GET_METERING);
                Slot::integer(self.array_buffers[&inst].length as i32)
            }
            Payload::Reference(inst) if kind.has(ExoticKind::REGEXPS) => {
                // The RegExp accessor getters (`fx_RegExp_prototype_
                // get_*`). `source`/`flags` return strings (a fresh
                // chunk); the per-flag getters read `code[0]` and
                // return a boolean. The ordinary `lastIndex` data
                // property falls through to `instance_get` below.
                // Any other name (`exec`/`test`/`toString`/
                // `constructor`) resolves up the prototype chain.
                let g = self.regexp_getter_ids;
                if Some(id) == g.source {
                    self.meter.tick_raw(REGEXP_GETTER_METERING);
                    let (bytes, allocated) = (self.regexp_source_bytes_metered(inst))?;
                    if allocated {
                        self.new_string_metered(&bytes)
                    } else {
                        // XS returns the constructor's existing
                        // source key when no escaping is needed;
                        // materialize the equivalent primitive in
                        // our arena without charging a new chunk.
                        let offset = self.alloc_str_text(&bytes);
                        Slot::of(Kind::String, Payload::String(offset))
                    }
                } else if Some(id) == g.flags {
                    self.meter.tick_raw(REGEXP_FLAGS_GETTER_METERING);
                    let flags = self.regexps[&inst].flags.clone();
                    self.new_string_metered(flags.as_bytes())
                } else if let Some(bit) = regexp_flag_bit_for(g, id) {
                    self.meter.tick_raw(REGEXP_GETTER_METERING);
                    let f = self.regexps[&inst].program.flags();
                    Slot::boolean(f & bit != 0)
                } else {
                    self.instance_get(inst, id)
                }
            }
            Payload::Reference(inst) if kind.has(ExoticKind::LOCALES) => {
                let name = self
                    .symbol_names
                    .get(id.saturating_sub(1) as usize)
                    .cloned()
                    .unwrap_or_default();
                let locale = self.locales[&inst].clone();
                if name == "numeric" {
                    Slot::boolean(locale.unicode.get("kn").map_or(false, |v| v == "true"))
                } else {
                    let (recognized, text) = match name.as_str().unwrap_or("") {
                        "baseName" => (true, Some(locale_base_name(&locale))),
                        "language" => (true, Some(locale.language)),
                        "script" => (true, locale.script),
                        "region" => (true, locale.region),
                        "variants" => (true, Some(locale.variants.join("-"))),
                        "calendar" => (true, locale.unicode.get("ca").cloned()),
                        "caseFirst" => (true, locale.unicode.get("kf").cloned()),
                        "collation" => (true, locale.unicode.get("co").cloned()),
                        "firstDayOfWeek" => (true, locale.unicode.get("fw").cloned()),
                        "hourCycle" => (true, locale.unicode.get("hc").cloned()),
                        "numberingSystem" => (true, locale.unicode.get("nu").cloned()),
                        _ => (false, None),
                    };
                    if let Some(text) = text {
                        self.intl_string(&text)
                    } else if recognized {
                        Slot::undefined()
                    } else {
                        self.instance_get(inst, id)
                    }
                }
            }
            Payload::Reference(inst)
                if kind.has(ExoticKind::COLLATORS)
                    && self.symbol_ids.get("compare") == Some(&id) =>
            {
                let existing = self
                    .collator_compare_functions
                    .iter()
                    .find_map(|(function, owner)| (*owner == inst).then_some(*function));
                let function = existing.unwrap_or_else(|| {
                    let f = self.alloc_method(NativeMethod::CollatorCompare);
                    self.collator_compare_functions.insert(f, inst);
                    f
                });
                Slot::of(Kind::Reference, Payload::Reference(function))
            }
            Payload::Reference(inst)
                if (Some(id) == self.length_id || Some(id) == self.name_id)
                    && kind.has(ExoticKind::FUNCTIONS)
                    && !self.deleted_fn_meta.contains(&(inst, id))
                    && self.find_property(inst, id).is_none() =>
            {
                // A user function's own `length`/`name` data
                // properties (`XS_DONT_ENUM|XS_DONT_SET`), created
                // at `fxNewFunctionInstance` and filled in at `code`
                // (`length`) / `fxNewFunctionName` (`name`). Reading
                // them is a plain own-property read — no built-in
                // step, no allocation (the value/chunk already
                // exist), so metering is unchanged, exactly as XS.
                // A guest `delete` tombstones the pair (then the read
                // resolves up the prototype chain → `undefined`); a
                // `defineProperty`-installed ordinary slot shadows
                // this synthesized value (handled by `ordinary_get`).
                let fi = &self.functions[&inst];
                if Some(id) == self.length_id {
                    Slot::integer(fi.arity as i32)
                } else {
                    Slot::of(Kind::String, Payload::String(fi.name_chunk))
                }
            }
            // A primitive symbol boxes to `%Symbol.prototype%`
            // (XS's symbol behavior): `sym.toString`/`valueOf`
            // resolve the inherited method up the prototype chain.
            // (A symbol value carries `Payload::Reference(desc)`,
            // so this must precede the generic reference arm and be
            // gated on `Kind::Symbol`.)
            //
            // Through the full `[[Get]]`, not a raw chain scan, so
            // the `description` accessor runs with the reading
            // symbol as its receiver. A data property costs the
            // same: the ordinary chain walk meters nothing.
            Payload::Reference(_) if obj.kind == Kind::Symbol && !self.symbol_proto.is_null() => {
                (self.ordinary_get(code, self.symbol_proto, id, obj))?
            }
            // …and with no `%Symbol.prototype%` linked there is
            // nothing to resolve against — never the description.
            Payload::Reference(_) if obj.kind == Kind::Symbol => Slot::undefined(),
            // A proxy `p.k` routes through the `get` trap
            // (ECMA-262 10.5.8), never the ordinary store.
            Payload::Reference(inst) if kind.has(ExoticKind::PROXIES) => {
                (self.proxy_get(code, inst, id, obj))?
            }
            // Route a thrown getter through the enclosing
            // `catch` (`Step::Unwound`), exactly as a throwing
            // native call does — a raw `return halt` would exit the
            // dispatch loop with the Resume unhandled, so a getter
            // that throws (the `format` accessor read on a
            // non-NumberFormat `this`, or any user getter) inside a
            // `try` would escape its handler.
            Payload::Reference(inst) => (self.ordinary_get(code, inst, id, obj))?,
            // A primitive string boxes to `%String.prototype%`
            // (XS's `fxCoerceToString`/string behavior): `.length`
            // is the UTF-16 code-unit count; any other name
            // resolves up the prototype chain.
            Payload::String(off) => (self.string_property_get(code, off, id, obj))?,
            // A primitive number boxes to `%Number.prototype%`
            // (`(42).toString(2)`): resolve the inherited method.
            Payload::Integer(_) | Payload::Number(_) if !self.number_proto.is_null() => {
                (self.ordinary_get(code, self.number_proto, id, obj))?
            }
            // A primitive bigint boxes to `%BigInt.prototype%`.
            Payload::BigInt(_) if !self.bigint_proto.is_null() => {
                (self.ordinary_get(code, self.bigint_proto, id, obj))?
            }
            // A primitive boolean boxes to `%Boolean.prototype%`
            // (`true.toString()`): resolve the inherited method.
            Payload::Boolean(_) if !self.boolean_proto.is_null() => {
                (self.ordinary_get(code, self.boolean_proto, id, obj))?
            }
            // `null.f` / `undefined.f`: `mxToInstance(mxStack)` throws
            // before the lookup (`fxToInstance`). Reading a property
            // of a nullish base is a catchable `TypeError`, never
            // `undefined`.
            _ if matches!(obj.kind, Kind::Null | Kind::Undefined) => {
                return Err(self.catchable_type_error_msg(cannot_coerce_to_object(obj.kind)))
            }
            _ => Slot::undefined(),
        };
        self.push(v);
        Ok(())
    }
}
