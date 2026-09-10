//! VM-facing intl builtin algorithms.
use super::super::*;

impl Interp {
    pub(in crate::interp) fn intl_locale_argument(
        &mut self,
        code: &[u8],
        value: Slot,
    ) -> Result<String, Step> {
        if let Payload::Reference(r) = value.value {
            if let Some(locale) = self.locales.get(&r) {
                return Ok(locale.tag.clone());
            }
        }
        let primitive = if value.kind == Kind::Reference {
            self.to_primitive(code, value, true)?
        } else {
            value
        };
        if primitive.kind != Kind::String {
            return Err(self.catchable_type_error_msg(
                "Intl: locale must be a string or string-convertible object".into(),
            ));
        }
        match primitive.value {
            Payload::String(off) => self.str_scalar_text(off).ok_or_else(|| {
                self.catchable_range_error_msg("Intl: locale contains an unpaired surrogate".into())
            }),
            _ => Err(self.catchable_type_error_msg("Intl: locale must be a string".into())),
        }
    }

    pub(in crate::interp) fn intl_first_locale(
        &mut self,
        code: &[u8],
        value: Slot,
    ) -> Result<Option<String>, Step> {
        if value.kind == Kind::Undefined {
            return Ok(None);
        }
        if let Payload::Reference(r) = value.value {
            if let Some(locale) = self.locales.get(&r) {
                return Ok(Some(locale.tag.clone()));
            }
            if let Some(array) = self.arrays.get(&r) {
                let first = array.items().get(&0).copied();
                return first
                    .map(|slot| self.intl_locale_argument(code, slot).map(Some))
                    .unwrap_or(Ok(None));
            }
        }
        self.intl_locale_argument(code, value).map(Some)
    }

    pub(in crate::interp) fn intl_locale_list(
        &mut self,
        code: &[u8],
        value: Slot,
    ) -> Result<Vec<String>, Step> {
        if value.kind == Kind::Undefined {
            return Ok(Vec::new());
        }
        let values = if let Payload::Reference(r) = value.value {
            if let Some(array) = self.arrays.get(&r) {
                (0..array.length)
                    .filter_map(|i| array.items().get(&i).copied())
                    .collect::<Vec<_>>()
            } else {
                vec![value]
            }
        } else {
            vec![value]
        };
        let mut result = Vec::new();
        for item in values {
            let raw = self.intl_locale_argument(code, item)?;
            let canonical = canonicalize_locale(&raw)
                .ok_or_else(|| self.catchable_range_error_msg("Intl: invalid language tag".into()))?
                .tag;
            if !result.contains(&canonical) {
                result.push(canonical);
            }
        }
        Ok(result)
    }

    pub(in crate::interp) fn intl_string(&mut self, text: &str) -> Slot {
        self.new_string_metered(text.as_bytes())
    }

    pub(in crate::interp) fn new_locale_from_data(&mut self, locale: LocaleData) -> Slot {
        let inst = self.slots.alloc(Slot::instance(self.locale_proto));
        self.locales.insert(inst, locale);
        Slot::of(Kind::Reference, Payload::Reference(inst))
    }

    pub(in crate::interp) fn intl_option_string(
        &mut self,
        code: &[u8],
        options: crate::value::SlotIndex,
        name: &'static str,
    ) -> Result<Option<String>, Step> {
        let value = self.mop_get_option_field(
            code,
            options,
            name,
            Slot::of(Kind::Reference, Payload::Reference(options)),
        )?;
        if value.kind == Kind::Undefined {
            return Ok(None);
        }
        let units = self.to_string_units(code, value)?;
        Ok(Some(String::from_utf16(&units).map_err(|_| {
            self.catchable_range_error_msg("Intl: option contains an unpaired surrogate".into())
        })?))
    }

    fn intl_option_bool(
        &mut self,
        code: &[u8],
        options: crate::value::SlotIndex,
        name: &'static str,
    ) -> Result<Option<bool>, Step> {
        let value = self.mop_get_option_field(
            code,
            options,
            name,
            Slot::of(Kind::Reference, Payload::Reference(options)),
        )?;
        Ok((value.kind != Kind::Undefined).then(|| self.truthy(&value)))
    }

    pub(in crate::interp) fn apply_locale_options(
        &mut self,
        code: &[u8],
        options: crate::value::SlotIndex,
        locale: &mut LocaleData,
    ) -> Result<(), Step> {
        if let Some(language) = self.intl_option_string(code, options, "language")? {
            if !valid_language(&language) {
                return Err(
                    self.catchable_range_error_msg("Intl.Locale: invalid language option".into())
                );
            }
            locale.language = language.to_ascii_lowercase();
        }
        if let Some(script) = self.intl_option_string(code, options, "script")? {
            if !valid_script(&script) {
                return Err(
                    self.catchable_range_error_msg("Intl.Locale: invalid script option".into())
                );
            }
            locale.script = Some(titlecase_ascii(&script));
        }
        if let Some(region) = self.intl_option_string(code, options, "region")? {
            if !valid_region(&region) {
                return Err(
                    self.catchable_range_error_msg("Intl.Locale: invalid region option".into())
                );
            }
            locale.region = Some(region.to_ascii_uppercase());
        }
        for (option, key, allowed) in [
            ("calendar", "ca", &[][..]),
            ("collation", "co", &[][..]),
            ("hourCycle", "hc", &["h11", "h12", "h23", "h24"][..]),
            ("caseFirst", "kf", &["upper", "lower", "false"][..]),
            ("numberingSystem", "nu", &[][..]),
            (
                "firstDayOfWeek",
                "fw",
                &["mon", "tue", "wed", "thu", "fri", "sat", "sun"][..],
            ),
        ] {
            if let Some(value) = self.intl_option_string(code, options, option)? {
                let value = value.to_ascii_lowercase();
                if !valid_unicode_type(&value)
                    || (!allowed.is_empty() && !allowed.contains(&value.as_str()))
                {
                    return Err(self.catchable_range_error_msg(format!(
                        "Intl.Locale: invalid {option} option"
                    )));
                }
                locale.unicode.insert(key.to_string(), value);
            }
        }
        if let Some(numeric) = self.intl_option_bool(code, options, "numeric")? {
            locale.unicode.insert(
                "kn".to_string(),
                if numeric { "true" } else { "false" }.to_string(),
            );
        }
        Ok(())
    }

    pub(in crate::interp) fn apply_collator_options(
        &mut self,
        code: &[u8],
        options: crate::value::SlotIndex,
        data: &mut CollatorData,
    ) -> Result<(), Step> {
        for (name, target, allowed) in [
            ("usage", &mut data.usage, &["sort", "search"][..]),
            (
                "sensitivity",
                &mut data.sensitivity,
                &["base", "accent", "case", "variant"][..],
            ),
            (
                "caseFirst",
                &mut data.case_first,
                &["upper", "lower", "false"][..],
            ),
            ("collation", &mut data.collation, &[][..]),
        ] {
            if let Some(value) = self.intl_option_string(code, options, name)? {
                let value = value.to_ascii_lowercase();
                if (!allowed.is_empty() && !allowed.contains(&value.as_str()))
                    || (name == "collation" && !valid_unicode_type(&value))
                {
                    return Err(self.catchable_range_error_msg(format!(
                        "Intl.Collator: invalid {name} option"
                    )));
                }
                *target = value;
            }
        }
        if let Some(v) = self.intl_option_bool(code, options, "numeric")? {
            data.numeric = v;
        }
        if let Some(v) = self.intl_option_bool(code, options, "ignorePunctuation")? {
            data.ignore_punctuation = v;
        }
        Ok(())
    }

    /// `GetOptionsObject(options)` (ECMA-402): `undefined` yields no options
    /// object (defaults apply), an object is returned as-is, and any other
    /// value throws a `TypeError`.
    pub(in crate::interp) fn intl_get_options_object(
        &mut self,
        options_arg: Slot,
    ) -> Result<Option<crate::value::SlotIndex>, Step> {
        match options_arg.kind {
            Kind::Undefined => Ok(None),
            Kind::Reference => match options_arg.value {
                Payload::Reference(r) => Ok(Some(r)),
                _ => Err(self.catchable_type_error_msg("Intl: options must be an object".into())),
            },
            _ => Err(self.catchable_type_error_msg("Intl: options must be an object".into())),
        }
    }

    /// `GetOption(options, property, "string", values, default)`: read the
    /// property (running any accessor), coerce it to a string, and require the
    /// result to appear in `allowed` (`RangeError` otherwise). An absent or
    /// `undefined` property yields `default`.
    pub(in crate::interp) fn intl_get_option_enum(
        &mut self,
        code: &[u8],
        options: crate::value::SlotIndex,
        name: &'static str,
        allowed: &[&str],
        default: &str,
    ) -> Result<String, Step> {
        let receiver = Slot::of(Kind::Reference, Payload::Reference(options));
        let value = self.mop_get_option_field(code, options, name, receiver)?;
        if value.kind == Kind::Undefined {
            return Ok(default.to_string());
        }
        let text = self.value_to_scalar_text(code, value)?;
        if allowed.iter().any(|a| *a == text) {
            Ok(text)
        } else {
            Err(self.catchable_range_error_msg(format!("Intl: invalid {name} option")))
        }
    }

    /// `GetNumberOption(options, property, minimum, maximum, fallback)`: read
    /// the property (running any accessor), coerce to a number, and require it
    /// to be a finite value within `[minimum, maximum]` (`RangeError`
    /// otherwise). An absent/`undefined` property yields `default`. Returns the
    /// floored integer when present.
    fn intl_get_number_option(
        &mut self,
        code: &[u8],
        options: crate::value::SlotIndex,
        name: &'static str,
        minimum: f64,
        maximum: f64,
        default: Option<u32>,
    ) -> Result<Option<u32>, Step> {
        let receiver = Slot::of(Kind::Reference, Payload::Reference(options));
        let value = self.mop_get_option_field(code, options, name, receiver)?;
        if value.kind == Kind::Undefined {
            return Ok(default);
        }
        let n = self.to_number_value(code, value)?;
        let number = to_number(&n);
        if number.is_nan() || number < minimum || number > maximum {
            return Err(self.catchable_range_error_msg(format!(
                "Intl: {name} must be between {minimum} and {maximum}"
            )));
        }
        Ok(Some(number.floor() as u32))
    }

    /// Resolve the requested locale list to a single available data locale.
    /// ironhorse's frozen ECMA-402 profile carries `en` and `es` list/plural
    /// data; every other request falls back to `en`. The returned tag preserves
    /// the requested region/script (its base name, extensions dropped), matching
    /// ResolveLocale's lookup result for the tested locales.
    pub(in crate::interp) fn intl_resolve_locale(
        &mut self,
        code: &[u8],
        locale_arg: Slot,
    ) -> Result<String, Step> {
        let requested = self.intl_first_locale(code, locale_arg)?;
        match requested {
            Some(raw) => {
                let locale = canonicalize_locale(&raw).ok_or_else(|| {
                    self.catchable_range_error_msg("Intl: invalid language tag".into())
                })?;
                Ok(locale_base_name(&locale))
            }
            None => Ok("en".to_string()),
        }
    }

    /// Build one segment-data object (`CreateSegmentDataObject`): the
    /// `{segment, index, input[, isWordLike]}` record a `%Segments%` iterator
    /// yields or `containing` returns, in that own-property enumeration order.
    /// `isWordLike` is present only for `word` granularity.
    pub(in crate::interp) fn make_segment_data_object(
        &mut self,
        segments_inst: crate::value::SlotIndex,
        seg_index: usize,
    ) -> Slot {
        let (start, end, is_word_like, is_word) = {
            let s = &self.segments[&segments_inst];
            let (st, en, wl) = s.segments[seg_index];
            (st, en, wl, s.granularity == "word")
        };
        let seg_units = self.segments[&segments_inst].units[start..end].to_vec();
        let input_units = self.segments[&segments_inst].units.clone();
        let obj = self.slots.alloc(Slot::instance(self.object_proto));
        let segment = self.new_string_units(&seg_units);
        self.define_descriptor_field(obj, "segment", segment);
        self.define_descriptor_field(obj, "index", Slot::number(start as f64));
        let input = self.new_string_units(&input_units);
        self.define_descriptor_field(obj, "input", input);
        if is_word {
            self.define_descriptor_field(obj, "isWordLike", Slot::boolean(is_word_like));
        }
        Slot::of(Kind::Reference, Payload::Reference(obj))
    }

    /// `GetOption(options, property, "string", values, undefined)` returning
    /// `None` when the property is absent/`undefined` rather than a default —
    /// the presence-sensitive form the DateTimeFormat option resolution needs.
    fn intl_get_option_enum_opt(
        &mut self,
        code: &[u8],
        options: crate::value::SlotIndex,
        name: &'static str,
        allowed: &[&str],
    ) -> Result<Option<String>, Step> {
        let receiver = Slot::of(Kind::Reference, Payload::Reference(options));
        let value = self.mop_get_option_field(code, options, name, receiver)?;
        if value.kind == Kind::Undefined {
            return Ok(None);
        }
        let text = self.value_to_scalar_text(code, value)?;
        if allowed.iter().any(|a| *a == text) {
            Ok(Some(text))
        } else {
            Err(self
                .catchable_range_error_msg(format!("Intl.DateTimeFormat: invalid {name} option")))
        }
    }

    /// `CreateDateTimeFormat` (ECMA-402): resolve the locale, calendar,
    /// numbering system, time zone, hour cycle, and the date/time component or
    /// style options against the frozen profile. Order of reads mirrors the
    /// spec so `constructor-options-order` observes the same get sequence.
    pub(in crate::interp) fn build_date_time_format(
        &mut self,
        code: &[u8],
        locale_arg: Slot,
        options_arg: Slot,
    ) -> Result<DateTimeFormatData, Step> {
        let requested = self.intl_first_locale(code, locale_arg)?;
        let (locale_base, ext) = match &requested {
            Some(raw) => {
                let loc = canonicalize_locale(raw).ok_or_else(|| {
                    self.catchable_range_error_msg("Intl: invalid language tag".into())
                })?;
                (locale_base_name(&loc), loc.unicode.clone())
            }
            None => ("en".to_string(), std::collections::BTreeMap::new()),
        };
        let options = self.intl_get_options_object(options_arg)?;
        if let Some(opts) = options {
            self.intl_get_option_enum(
                code,
                opts,
                "localeMatcher",
                &["lookup", "best fit"],
                "best fit",
            )?;
        }
        // calendar / numberingSystem: well-formed Unicode `type` subtags.
        let mut calendar = ext.get("ca").cloned();
        let mut numbering = ext.get("nu").cloned();
        if let Some(opts) = options {
            if let Some(v) = self.intl_option_string(code, opts, "calendar")? {
                let v = v.to_ascii_lowercase();
                if !valid_unicode_type(&v) {
                    return Err(self.catchable_range_error_msg(
                        "Intl.DateTimeFormat: invalid calendar option".into(),
                    ));
                }
                calendar = Some(v);
            }
            if let Some(v) = self.intl_option_string(code, opts, "numberingSystem")? {
                let v = v.to_ascii_lowercase();
                if !valid_unicode_type(&v) {
                    return Err(self.catchable_range_error_msg(
                        "Intl.DateTimeFormat: invalid numberingSystem option".into(),
                    ));
                }
                numbering = Some(v);
            }
        }
        // hour12 / hourCycle.
        let mut hour12 = None;
        let mut hour_cycle = ext.get("hc").cloned();
        if let Some(opts) = options {
            hour12 = self.intl_option_bool(code, opts, "hour12")?;
            if let Some(hc) = self.intl_get_option_enum_opt(
                code,
                opts,
                "hourCycle",
                &["h11", "h12", "h23", "h24"],
            )? {
                hour_cycle = Some(hc);
            }
        }
        // timeZone: default UTC, else canonicalize the requested identifier.
        let (time_zone, offset_minutes) = match options {
            Some(opts) => match self.intl_option_string(code, opts, "timeZone")? {
                Some(raw) => resolve_time_zone(&raw).ok_or_else(|| {
                    self.catchable_range_error_msg(
                        "Intl.DateTimeFormat: invalid or unsupported timeZone".into(),
                    )
                })?,
                None => ("UTC".to_string(), 0),
            },
            None => ("UTC".to_string(), 0),
        };
        // Component and style options.
        let (date_style, time_style) = match options {
            Some(opts) => (
                self.intl_get_option_enum_opt(
                    code,
                    opts,
                    "dateStyle",
                    &["full", "long", "medium", "short"],
                )?,
                self.intl_get_option_enum_opt(
                    code,
                    opts,
                    "timeStyle",
                    &["full", "long", "medium", "short"],
                )?,
            ),
            None => (None, None),
        };
        // Each date/time component option and its allowed representations.
        let component_specs: &[(&'static str, &[&str])] = &[
            ("weekday", &["narrow", "short", "long"]),
            ("era", &["narrow", "short", "long"]),
            ("year", &["2-digit", "numeric"]),
            ("month", &["2-digit", "numeric", "narrow", "short", "long"]),
            ("day", &["2-digit", "numeric"]),
            ("dayPeriod", &["narrow", "short", "long"]),
            ("hour", &["2-digit", "numeric"]),
            ("minute", &["2-digit", "numeric"]),
            ("second", &["2-digit", "numeric"]),
        ];
        let mut components: Vec<(&'static str, String)> = Vec::new();
        let mut any_component = false;
        if let Some(opts) = options {
            for (name, allowed) in component_specs {
                if let Some(v) = self.intl_get_option_enum_opt(code, opts, name, allowed)? {
                    components.push((name, v));
                    any_component = true;
                }
            }
            // fractionalSecondDigits: GetNumberOption 1..3.
            if let Some(n) =
                self.intl_get_number_option(code, opts, "fractionalSecondDigits", 1.0, 3.0, None)?
            {
                components.push(("fractionalSecondDigits", n.to_string()));
                any_component = true;
            }
            // timeZoneName.
            if let Some(v) = self.intl_get_option_enum_opt(
                code,
                opts,
                "timeZoneName",
                &[
                    "short",
                    "long",
                    "shortOffset",
                    "longOffset",
                    "shortGeneric",
                    "longGeneric",
                ],
            )? {
                components.push(("timeZoneName", v));
                any_component = true;
            }
            // formatMatcher is read and validated but does not steer the frozen
            // pattern set.
            self.intl_get_option_enum(
                code,
                opts,
                "formatMatcher",
                &["basic", "best fit"],
                "best fit",
            )?;
        }
        // A dateStyle/timeStyle cannot combine with explicit components.
        if (date_style.is_some() || time_style.is_some()) && any_component {
            return Err(self.catchable_type_error_msg(
                "Intl.DateTimeFormat: dateStyle/timeStyle cannot be combined with components"
                    .into(),
            ));
        }
        // Default: with neither style nor components, the date defaults to
        // numeric year/month/day (ToDateTimeOptions "date" required, "any").
        if date_style.is_none() && time_style.is_none() && !any_component {
            components.push(("year", "numeric".to_string()));
            components.push(("month", "numeric".to_string()));
            components.push(("day", "numeric".to_string()));
        }
        // The resolved hour cycle only surfaces when an hour is formatted.
        let formats_hour = components.iter().any(|(k, _)| *k == "hour") || time_style.is_some();
        // Resolve the hour cycle: an explicit `hour12` wins (h12/h11 for true,
        // h23 for false), then an explicit `hourCycle`, then the locale
        // default. The frozen profile uses h12 everywhere except Japanese,
        // whose 24-hour default is h23 and 12-hour is h11.
        let is_ja = locale_base.starts_with("ja");
        let resolved_hour_cycle = if formats_hour {
            let cycle = match hour12 {
                Some(true) => {
                    if is_ja {
                        "h11".to_string()
                    } else {
                        "h12".to_string()
                    }
                }
                Some(false) => "h23".to_string(),
                None => hour_cycle.clone().unwrap_or_else(|| {
                    if is_ja {
                        "h23".to_string()
                    } else {
                        "h12".to_string()
                    }
                }),
            };
            Some(cycle)
        } else {
            None
        };
        Ok(DateTimeFormatData {
            locale: locale_base,
            calendar: calendar.unwrap_or_else(|| "gregory".to_string()),
            numbering_system: numbering.unwrap_or_else(|| "latn".to_string()),
            time_zone,
            offset_minutes,
            hour_cycle: resolved_hour_cycle,
            components,
            date_style,
            time_style,
        })
    }

    /// Dispatch the DateTimeFormat prototype methods (`format`,
    /// `formatToParts`, `formatRange`, `formatRangeToParts`,
    /// `resolvedOptions`), each branded on the receiver.
    pub(in crate::interp) fn date_time_format_method(
        &mut self,
        m: NativeMethod,
        this: Slot,
        arg0: Slot,
        arg1: Slot,
        code: &[u8],
    ) -> Result<Slot, Step> {
        let inst = match this.value {
            Payload::Reference(r) if self.date_time_formats.contains_key(&r) => r,
            _ => {
                return Err(self
                    .catchable_type_error_msg("Intl.DateTimeFormat: incompatible receiver".into()))
            }
        };
        let data = self.date_time_formats[&inst].clone();
        match m {
            NativeMethod::DateTimeFormatResolvedOptions => {
                Ok(self.date_time_format_resolved_options(&data))
            }
            NativeMethod::DateTimeFormatFormat | NativeMethod::DateTimeFormatFormatToParts => {
                let t = self.date_time_arg_to_time(code, arg0)?;
                let parts = format_date_time_parts(&data, t);
                if m == NativeMethod::DateTimeFormatFormat {
                    let mut s = String::new();
                    for (_, v) in &parts {
                        s.push_str(v);
                    }
                    Ok(self.intl_string(&s))
                } else {
                    Ok(self.date_time_parts_array(&parts, false))
                }
            }
            NativeMethod::DateTimeFormatFormatRange
            | NativeMethod::DateTimeFormatFormatRangeToParts => {
                if arg0.kind == Kind::Undefined || arg1.kind == Kind::Undefined {
                    return Err(self.catchable_type_error_msg(
                        "Intl.DateTimeFormat: range endpoints are required".into(),
                    ));
                }
                let t1 = self.date_time_arg_to_time(code, arg0)?;
                let t2 = self.date_time_arg_to_time(code, arg1)?;
                let (parts, source_shared) = format_date_time_range_parts(&data, t1, t2);
                if m == NativeMethod::DateTimeFormatFormatRange {
                    let mut s = String::new();
                    for (_, v, _) in &parts {
                        s.push_str(v);
                    }
                    Ok(self.intl_string(&s))
                } else {
                    let _ = source_shared;
                    Ok(self.date_time_range_parts_array(&parts))
                }
            }
            _ => unreachable!("date_time_format_method dispatched a non-DTF method"),
        }
    }

    /// `? ToNumber` the date argument (or `undefined` → epoch), then require a
    /// finite integral time value in range (a non-finite one is a RangeError).
    fn date_time_arg_to_time(&mut self, code: &[u8], arg: Slot) -> Result<f64, Step> {
        let n = if arg.kind == Kind::Undefined {
            0.0
        } else {
            let v = self.to_number_value(code, arg)?;
            to_number(&v)
        };
        if !n.is_finite() || n.abs() > 8.64e15 {
            return Err(self
                .catchable_range_error_msg("Intl.DateTimeFormat: time value out of range".into()));
        }
        Ok(n.trunc())
    }

    fn date_time_format_resolved_options(&mut self, data: &DateTimeFormatData) -> Slot {
        let result = self.slots.alloc(Slot::instance(self.object_proto));
        let locale = self.intl_string(&data.locale);
        self.define_descriptor_field(result, "locale", locale);
        let calendar = self.intl_string(&data.calendar);
        self.define_descriptor_field(result, "calendar", calendar);
        let nu = self.intl_string(&data.numbering_system);
        self.define_descriptor_field(result, "numberingSystem", nu);
        let tz = self.intl_string(&data.time_zone);
        self.define_descriptor_field(result, "timeZone", tz);
        if let Some(hc) = &data.hour_cycle {
            let hc_s = self.intl_string(hc);
            self.define_descriptor_field(result, "hourCycle", hc_s);
            let h12 = Slot::boolean(hc == "h11" || hc == "h12");
            self.define_descriptor_field(result, "hour12", h12);
        }
        // Explicit component options, in the spec's fixed enumeration order
        // (weekday … timeZoneName), as built in `build_date_time_format`.
        for (key, value) in &data.components {
            if *key == "fractionalSecondDigits" {
                if let Ok(n) = value.parse::<i32>() {
                    self.define_descriptor_field(result, key, Slot::integer(n));
                }
            } else {
                let v = self.intl_string(value);
                self.define_descriptor_field(result, key, v);
            }
        }
        // dateStyle / timeStyle come last (ECMA-402 resolvedOptions order).
        if let Some(ds) = &data.date_style {
            let s = self.intl_string(ds);
            self.define_descriptor_field(result, "dateStyle", s);
        }
        if let Some(ts) = &data.time_style {
            let s = self.intl_string(ts);
            self.define_descriptor_field(result, "timeStyle", s);
        }
        Slot::of(Kind::Reference, Payload::Reference(result))
    }

    /// Build the `formatToParts` result array from `(type, value)` parts.
    fn date_time_parts_array(&mut self, parts: &[(&'static str, String)], _range: bool) -> Slot {
        let arr = self.new_array();
        for (i, (ty, value)) in parts.iter().enumerate() {
            let obj = self.slots.alloc(Slot::instance(self.object_proto));
            let type_slot = self.intl_string(ty);
            let value_slot = self.intl_string(value);
            self.define_descriptor_field(obj, "type", type_slot);
            self.define_descriptor_field(obj, "value", value_slot);
            let mut item = Slot::of(Kind::Reference, Payload::Reference(obj));
            item.id = 0;
            item.next = crate::value::SlotIndex::NULL;
            self.arrays
                .get_mut(&arr)
                .unwrap()
                .insert_item(i as u32, item, &mut self.side_refs);
        }
        self.arrays.get_mut(&arr).unwrap().length = parts.len() as u32;
        Slot::of(Kind::Reference, Payload::Reference(arr))
    }

    fn date_time_range_parts_array(
        &mut self,
        parts: &[(&'static str, String, &'static str)],
    ) -> Slot {
        let arr = self.new_array();
        for (i, (ty, value, source)) in parts.iter().enumerate() {
            let obj = self.slots.alloc(Slot::instance(self.object_proto));
            let type_slot = self.intl_string(ty);
            let value_slot = self.intl_string(value);
            let source_slot = self.intl_string(source);
            self.define_descriptor_field(obj, "type", type_slot);
            self.define_descriptor_field(obj, "value", value_slot);
            self.define_descriptor_field(obj, "source", source_slot);
            let mut item = Slot::of(Kind::Reference, Payload::Reference(obj));
            item.id = 0;
            item.next = crate::value::SlotIndex::NULL;
            self.arrays
                .get_mut(&arr)
                .unwrap()
                .insert_item(i as u32, item, &mut self.side_refs);
        }
        self.arrays.get_mut(&arr).unwrap().length = parts.len() as u32;
        Slot::of(Kind::Reference, Payload::Reference(arr))
    }

    /// A single list element must be a String (ECMA-402 StringListFromIterable
    /// step: `If Type(next) is not String, throw a TypeError`).
    fn list_element_string(&mut self, value: Slot) -> Result<Vec<u16>, Step> {
        match value.value {
            Payload::String(off) if value.kind == Kind::String => Ok(self.str_units(off)),
            _ => Err(self
                .catchable_type_error_msg("Intl.ListFormat: list elements must be strings".into())),
        }
    }

    /// `StringListFromIterable(iterable)` (ECMA-402): drive the iterator
    /// protocol, requiring every yielded value to be a String (`TypeError`
    /// otherwise). `undefined` yields the empty list; a primitive string is
    /// iterated by code point. Re-enters user code for a guest-defined iterator
    /// exactly as `for..of` does.
    pub(in crate::interp) fn string_list_from_iterable(
        &mut self,
        code: &[u8],
        iterable: Slot,
    ) -> Result<Vec<Vec<u16>>, Step> {
        if iterable.kind == Kind::Undefined {
            return Ok(Vec::new());
        }
        if iterable.kind == Kind::String {
            if let Payload::String(off) = iterable.value {
                let units = self.str_units(off);
                let mut result = Vec::new();
                for decoded in char::decode_utf16(units) {
                    result.push(match decoded {
                        Ok(ch) => ch.encode_utf16(&mut [0u16; 2]).to_vec(),
                        Err(error) => vec![error.unpaired_surrogate()],
                    });
                }
                return Ok(result);
            }
        }
        let obj = match iterable.value {
            Payload::Reference(r) => r,
            _ => {
                return Err(
                    self.catchable_type_error_msg("Intl.ListFormat: expected an iterable".into())
                )
            }
        };
        // GetIterator: a guest-defined `@@iterator` takes precedence. Arrays and
        // the intrinsic array iterators do not expose `@@iterator`/`next` as
        // ordinary properties (ironhorse special-cases them in `for..of`), so
        // read their elements directly rather than driving a native protocol.
        let iterator_id = self
            .well_known_symbol_property_id("iterator")
            .unwrap_or(crate::value::XS_NO_ID);
        let intrinsic_array_iterator = self.arrays.contains_key(&obj)
            && iterator_id != crate::value::XS_NO_ID
            && self.ordinary_get_own_descriptor(obj, iterator_id).is_none();
        let custom = if iterator_id == crate::value::XS_NO_ID || intrinsic_array_iterator {
            Slot::undefined()
        } else {
            self.mop_get(code, obj, iterator_id, iterable)?
        };
        if custom.kind == Kind::Undefined {
            // Dense array: iterate its elements in index order.
            if let Some(array) = self.arrays.get(&obj) {
                let length = array.length;
                let mut result = Vec::new();
                for i in 0..length {
                    let item = self
                        .arrays
                        .get(&obj)
                        .and_then(|a| a.items().get(&i))
                        .copied()
                        .unwrap_or_else(Slot::undefined);
                    let s = self.list_element_string(item)?;
                    result.push(s);
                }
                return Ok(result);
            }
            // An intrinsic array iterator handed in directly
            // (`array[Symbol.iterator]()`): read its remaining array elements.
            if let Some(state) = self.iterators.get(&obj) {
                if state.done {
                    return Ok(Vec::new());
                }
                let source = state.iterable;
                let start = state.index;
                if let Some(array) = self.arrays.get(&source) {
                    let length = array.length;
                    let mut result = Vec::new();
                    for i in start..length {
                        let item = self
                            .arrays
                            .get(&source)
                            .and_then(|a| a.items().get(&i))
                            .copied()
                            .unwrap_or_else(Slot::undefined);
                        let s = self.list_element_string(item)?;
                        result.push(s);
                    }
                    if let Some(st) = self.iterators.get_mut(&obj) {
                        st.index = length;
                        st.done = true;
                    }
                    return Ok(result);
                }
            }
            return Err(
                self.catchable_type_error_msg("Intl.ListFormat: expected an iterable".into())
            );
        }
        let iterator = self.call_primitive_method(code, custom, iterable, &[])?;
        let iterator_inst = match iterator.value {
            Payload::Reference(r) => r,
            _ => {
                return Err(self.catchable_type_error_msg(
                    "Intl.ListFormat: iterator must be an object".into(),
                ))
            }
        };
        let next_id = self.intern_static_key("next");
        let value_id = match self.value_id {
            Some(v) => v,
            None => self.intern_static_key("value"),
        };
        let done_id = match self.done_id {
            Some(v) => v,
            None => self.intern_static_key("done"),
        };
        let mut result = Vec::new();
        // A defensive bound: the tested iterables are short; this only guards a
        // pathological non-terminating guest iterator from wedging the host.
        for _ in 0..1_000_000 {
            let next_method = self.mop_get(code, iterator_inst, next_id, iterator)?;
            let step = self.call_primitive_method(code, next_method, iterator, &[])?;
            let step_inst = match step.value {
                Payload::Reference(r) => r,
                _ => {
                    return Err(self.catchable_type_error_msg(
                        "Intl.ListFormat: iterator result must be an object".into(),
                    ))
                }
            };
            let done = self.mop_get(code, step_inst, done_id, step)?;
            if self.truthy(&done) {
                return Ok(result);
            }
            let value = self.mop_get(code, step_inst, value_id, step)?;
            if value.kind != Kind::String {
                // The specification calls IteratorClose here; a plain guest
                // iterator has no `return` method, so closing is a no-op, and
                // the observable effect is the TypeError with the iterator left
                // where it stopped.
                return Err(self.catchable_type_error_msg(
                    "Intl.ListFormat: list elements must be strings".into(),
                ));
            }
            let s = match value.value {
                Payload::String(off) => self.str_units(off),
                _ => {
                    return Err(self.catchable_type_error_msg(
                        "Intl.ListFormat: list elements must be strings".into(),
                    ))
                }
            };
            result.push(s);
        }
        Err(self.catchable_range_error_msg("Intl.ListFormat: iteration limit exceeded".into()))
    }

    /// `SetNumberFormatDigitOptions(intlObj, options, mnfdDefault, mxfdDefault,
    /// notation)` (ECMA-402), storing the resolved digit fields onto a
    /// [`PluralRulesData`]. Faithful to the fraction/significant-digit
    /// defaulting and the rounding-increment/mode/priority validation.
    pub(in crate::interp) fn set_number_digit_options(
        &mut self,
        code: &[u8],
        options: crate::value::SlotIndex,
        data: &mut PluralRulesData,
        mnfd_default: u32,
        mxfd_default: u32,
        _compact: bool,
    ) -> Result<(), Step> {
        data.minimum_integer_digits = self
            .intl_get_number_option(code, options, "minimumIntegerDigits", 1.0, 21.0, Some(1))?
            .unwrap_or(1);
        let mnfd =
            self.intl_get_number_option(code, options, "minimumFractionDigits", 0.0, 100.0, None)?;
        let mxfd =
            self.intl_get_number_option(code, options, "maximumFractionDigits", 0.0, 100.0, None)?;
        let mnsd = self.intl_get_number_option(
            code,
            options,
            "minimumSignificantDigits",
            1.0,
            21.0,
            None,
        )?;
        let mxsd = self.intl_get_number_option(
            code,
            options,
            "maximumSignificantDigits",
            1.0,
            21.0,
            None,
        )?;
        let rounding_increment = self
            .intl_get_number_option(code, options, "roundingIncrement", 1.0, 5000.0, Some(1))?
            .unwrap_or(1);
        const VALID_INCREMENTS: &[u32] = &[
            1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000,
        ];
        if !VALID_INCREMENTS.contains(&rounding_increment) {
            return Err(self
                .catchable_range_error_msg("Intl.NumberFormat: invalid roundingIncrement".into()));
        }
        data.rounding_increment = rounding_increment;
        data.rounding_mode = self.intl_get_option_enum(
            code,
            options,
            "roundingMode",
            &[
                "ceil",
                "floor",
                "expand",
                "trunc",
                "halfCeil",
                "halfFloor",
                "halfExpand",
                "halfTrunc",
                "halfEven",
            ],
            "halfExpand",
        )?;
        data.rounding_priority = self.intl_get_option_enum(
            code,
            options,
            "roundingPriority",
            &["auto", "morePrecision", "lessPrecision"],
            "auto",
        )?;
        data.trailing_zero_display = self.intl_get_option_enum(
            code,
            options,
            "trailingZeroDisplay",
            &["auto", "stripIfInteger"],
            "auto",
        )?;
        let (mut mxfd_default, mnfd_default) = (mxfd_default, mnfd_default);
        if rounding_increment != 1 {
            mxfd_default = mnfd_default;
        }
        let has_sd = mnsd.is_some() || mxsd.is_some();
        let has_fd = mnfd.is_some() || mxfd.is_some();
        // Significant-digit resolution.
        if has_sd {
            let rmnsd = mnsd.unwrap_or(1);
            let rmxsd = mxsd.unwrap_or(21);
            if rmnsd > rmxsd {
                return Err(self.catchable_range_error_msg(
                    "Intl.NumberFormat: minimumSignificantDigits exceeds maximumSignificantDigits"
                        .into(),
                ));
            }
            data.minimum_significant_digits = Some(rmnsd);
            data.maximum_significant_digits = Some(rmxsd);
        }
        // Fraction-digit resolution.
        if has_fd {
            let (rmnfd, rmxfd) = match (mnfd, mxfd) {
                (Some(a), Some(b)) => {
                    if a > b {
                        return Err(self.catchable_range_error_msg("Intl.NumberFormat: minimumFractionDigits exceeds maximumFractionDigits".into()));
                    }
                    (a, b)
                }
                (Some(a), None) => (a, mxfd_default.max(a)),
                (None, Some(b)) => (mnfd_default.min(b), b),
                (None, None) => (mnfd_default, mxfd_default),
            };
            data.minimum_fraction_digits = rmnfd;
            data.maximum_fraction_digits = rmxfd;
        }
        let priority = data.rounding_priority.as_str();
        if priority == "morePrecision" || priority == "lessPrecision" {
            data.rounding_type = priority.to_string();
            // Both digit families participate; fill any absent defaults.
            if !has_sd {
                data.minimum_significant_digits = Some(1);
                data.maximum_significant_digits = Some(21);
            }
            if !has_fd {
                data.minimum_fraction_digits = mnfd_default;
                data.maximum_fraction_digits = mxfd_default;
            }
        } else if has_sd {
            data.rounding_type = "significantDigits".to_string();
        } else {
            data.rounding_type = "fractionDigits".to_string();
            // Plain fraction-digit rounding: apply the caller defaults when the
            // options named no fraction digits.
            if !has_fd {
                data.minimum_fraction_digits = mnfd_default;
                data.maximum_fraction_digits = mxfd_default;
            }
            data.minimum_significant_digits = None;
            data.maximum_significant_digits = None;
        }
        Ok(())
    }

    /// `InitializeNumberFormat` (ECMA-402): resolve the locale, numbering
    /// system, style/currency/unit, notation, digit options, grouping, and sign
    /// display against the frozen profile. The option-read order mirrors the
    /// specification so `constructor-order` and the option-getter tests observe
    /// the same get sequence.
    pub(in crate::interp) fn build_number_format(
        &mut self,
        code: &[u8],
        locale_arg: Slot,
        options_arg: Slot,
    ) -> Result<NumberFormatData, Step> {
        let requested = self.intl_first_locale(code, locale_arg)?;
        let (locale_base, ext) = match &requested {
            Some(raw) => {
                let loc = canonicalize_locale(raw).ok_or_else(|| {
                    self.catchable_range_error_msg("Intl: invalid language tag".into())
                })?;
                (locale_base_name(&loc), loc.unicode.clone())
            }
            None => ("en".to_string(), std::collections::BTreeMap::new()),
        };
        let options = self.intl_get_options_object(options_arg)?;
        if let Some(opts) = options {
            self.intl_get_option_enum(
                code,
                opts,
                "localeMatcher",
                &["lookup", "best fit"],
                "best fit",
            )?;
        }
        let mut numbering = ext.get("nu").cloned();
        if let Some(opts) = options {
            if let Some(v) = self.intl_option_string(code, opts, "numberingSystem")? {
                let v = v.to_ascii_lowercase();
                if !valid_unicode_type(&v) {
                    return Err(self.catchable_range_error_msg(
                        "Intl.NumberFormat: invalid numberingSystem option".into(),
                    ));
                }
                numbering = Some(v);
            }
        }
        let numbering_system = numbering.unwrap_or_else(|| "latn".to_string());

        // SetNumberFormatUnitOptions.
        let style = match options {
            Some(o) => self.intl_get_option_enum(
                code,
                o,
                "style",
                &["decimal", "percent", "currency", "unit"],
                "decimal",
            )?,
            None => "decimal".to_string(),
        };
        let mut currency = None;
        let mut currency_display = "symbol".to_string();
        let mut currency_sign = "standard".to_string();
        let mut unit = None;
        let mut unit_display = "short".to_string();
        if let Some(o) = options {
            if let Some(c) = self.intl_option_string(code, o, "currency")? {
                if !is_well_formed_currency_code(&c) {
                    return Err(self.catchable_range_error_msg(
                        "Intl.NumberFormat: invalid currency code".into(),
                    ));
                }
                currency = Some(c.to_ascii_uppercase());
            }
            if style == "currency" && currency.is_none() {
                return Err(self.catchable_type_error_msg(
                    "Intl.NumberFormat: currency is required for currency style".into(),
                ));
            }
            currency_display = self.intl_get_option_enum(
                code,
                o,
                "currencyDisplay",
                &["symbol", "narrowSymbol", "code", "name"],
                "symbol",
            )?;
            currency_sign = self.intl_get_option_enum(
                code,
                o,
                "currencySign",
                &["standard", "accounting"],
                "standard",
            )?;
            if let Some(u) = self.intl_option_string(code, o, "unit")? {
                if !is_well_formed_unit_identifier(&u) {
                    return Err(self.catchable_range_error_msg(
                        "Intl.NumberFormat: invalid unit identifier".into(),
                    ));
                }
                unit = Some(u);
            }
            if style == "unit" && unit.is_none() {
                return Err(self.catchable_type_error_msg(
                    "Intl.NumberFormat: unit is required for unit style".into(),
                ));
            }
            unit_display = self.intl_get_option_enum(
                code,
                o,
                "unitDisplay",
                &["short", "narrow", "long"],
                "short",
            )?;
        } else if style == "currency" || style == "unit" {
            // Unreachable — style defaults to decimal when no options object.
            return Err(self.catchable_type_error_msg(
                "Intl.NumberFormat: currency or unit option is required".into(),
            ));
        }

        let (mnfd_default, mxfd_default) = if style == "currency" {
            let d = currency_digits(currency.as_deref().unwrap_or("USD"));
            (d, d)
        } else if style == "percent" {
            (0, 0)
        } else {
            (0, 3)
        };

        let notation = match options {
            Some(o) => self.intl_get_option_enum(
                code,
                o,
                "notation",
                &["standard", "scientific", "engineering", "compact"],
                "standard",
            )?,
            None => "standard".to_string(),
        };

        let mut scratch = PluralRulesData {
            locale: locale_base.clone(),
            kind: "cardinal".to_string(),
            notation: notation.clone(),
            minimum_integer_digits: 1,
            minimum_fraction_digits: 0,
            maximum_fraction_digits: 3,
            minimum_significant_digits: None,
            maximum_significant_digits: None,
            rounding_type: "fractionDigits".to_string(),
            rounding_priority: "auto".to_string(),
            rounding_mode: "halfExpand".to_string(),
            rounding_increment: 1,
            trailing_zero_display: "auto".to_string(),
        };
        if let Some(o) = options {
            self.set_number_digit_options(
                code,
                o,
                &mut scratch,
                mnfd_default,
                mxfd_default,
                notation == "compact",
            )?;
        } else {
            scratch.minimum_fraction_digits = mnfd_default;
            scratch.maximum_fraction_digits = mxfd_default;
        }

        let compact_display = match options {
            Some(o) => {
                self.intl_get_option_enum(code, o, "compactDisplay", &["short", "long"], "short")?
            }
            None => "short".to_string(),
        };
        let default_grouping = if notation == "compact" {
            "min2"
        } else {
            "auto"
        };
        let use_grouping = match options {
            Some(o) => {
                self.get_string_or_boolean_option(code, o, "useGrouping", default_grouping)?
            }
            None => default_grouping.to_string(),
        };
        let sign_display = match options {
            Some(o) => self.intl_get_option_enum(
                code,
                o,
                "signDisplay",
                &["auto", "never", "always", "exceptZero", "negative"],
                "auto",
            )?,
            None => "auto".to_string(),
        };

        Ok(NumberFormatData {
            locale: locale_base,
            numbering_system,
            style,
            notation,
            compact_display,
            sign_display,
            use_grouping,
            currency,
            currency_display,
            currency_sign,
            unit,
            unit_display,
            minimum_integer_digits: scratch.minimum_integer_digits,
            minimum_fraction_digits: scratch.minimum_fraction_digits,
            maximum_fraction_digits: scratch.maximum_fraction_digits,
            minimum_significant_digits: scratch.minimum_significant_digits,
            maximum_significant_digits: scratch.maximum_significant_digits,
            rounding_type: scratch.rounding_type,
            rounding_priority: scratch.rounding_priority,
            rounding_mode: scratch.rounding_mode,
            rounding_increment: scratch.rounding_increment,
            trailing_zero_display: scratch.trailing_zero_display,
            bound_format: None,
        })
    }

    /// `GetStringOrBooleanOption(options, property, ...)` specialized for
    /// `useGrouping`: `true` → `"always"`, a falsy value → `"false"`, a string
    /// in `{min2, auto, always}` returns itself, and anything else is a
    /// `RangeError`. An absent/`undefined` value yields `fallback`.
    fn get_string_or_boolean_option(
        &mut self,
        code: &[u8],
        options: crate::value::SlotIndex,
        name: &'static str,
        fallback: &str,
    ) -> Result<String, Step> {
        let receiver = Slot::of(Kind::Reference, Payload::Reference(options));
        let value = self.mop_get_option_field(code, options, name, receiver)?;
        if value.kind == Kind::Undefined {
            return Ok(fallback.to_string());
        }
        if value.kind == Kind::Boolean {
            return Ok(if self.truthy(&value) {
                "always"
            } else {
                "false"
            }
            .to_string());
        }
        if !self.truthy(&value) {
            return Ok("false".to_string());
        }
        let text = self.value_to_scalar_text(code, value)?;
        if matches!(text.as_str(), "min2" | "auto" | "always") {
            Ok(text)
        } else {
            Err(self
                .catchable_range_error_msg("Intl.NumberFormat: invalid useGrouping option".into()))
        }
    }

    /// Convert a resolved [`NumberFormatData`] into the value engine's
    /// decoupled option record.
    pub(in crate::interp) fn nf_resolved(
        &self,
        data: &NumberFormatData,
    ) -> crate::intl_number::NfResolved {
        use crate::intl_number as inf;
        inf::NfResolved {
            locale: data.locale.clone(),
            numbering_system: data.numbering_system.clone(),
            style: match data.style.as_str() {
                "percent" => inf::Style::Percent,
                "currency" => inf::Style::Currency,
                "unit" => inf::Style::Unit,
                _ => inf::Style::Decimal,
            },
            notation: match data.notation.as_str() {
                "scientific" => inf::Notation::Scientific,
                "engineering" => inf::Notation::Engineering,
                "compact" => inf::Notation::Compact,
                _ => inf::Notation::Standard,
            },
            compact_display: if data.compact_display == "long" {
                inf::CompactDisplay::Long
            } else {
                inf::CompactDisplay::Short
            },
            sign_display: match data.sign_display.as_str() {
                "always" => inf::SignDisplay::Always,
                "never" => inf::SignDisplay::Never,
                "exceptZero" => inf::SignDisplay::ExceptZero,
                "negative" => inf::SignDisplay::Negative,
                _ => inf::SignDisplay::Auto,
            },
            grouping: match data.use_grouping.as_str() {
                "always" => inf::Grouping::Always,
                "min2" => inf::Grouping::Min2,
                "false" => inf::Grouping::Never,
                _ => inf::Grouping::Auto,
            },
            currency: data.currency.clone(),
            currency_display: match data.currency_display.as_str() {
                "narrowSymbol" => inf::CurrencyDisplay::NarrowSymbol,
                "code" => inf::CurrencyDisplay::Code,
                "name" => inf::CurrencyDisplay::Name,
                _ => inf::CurrencyDisplay::Symbol,
            },
            currency_sign: if data.currency_sign == "accounting" {
                inf::CurrencySign::Accounting
            } else {
                inf::CurrencySign::Standard
            },
            unit: data.unit.clone(),
            unit_display: match data.unit_display.as_str() {
                "narrow" => inf::UnitDisplay::Narrow,
                "long" => inf::UnitDisplay::Long,
                _ => inf::UnitDisplay::Short,
            },
            min_integer_digits: data.minimum_integer_digits,
            min_fraction_digits: data.minimum_fraction_digits,
            max_fraction_digits: data.maximum_fraction_digits,
            min_significant_digits: data.minimum_significant_digits,
            max_significant_digits: data.maximum_significant_digits,
            rounding_type: match data.rounding_type.as_str() {
                "significantDigits" => inf::RoundingType::SignificantDigits,
                "morePrecision" => inf::RoundingType::MorePrecision,
                "lessPrecision" => inf::RoundingType::LessPrecision,
                _ => inf::RoundingType::FractionDigits,
            },
            rounding_increment: data.rounding_increment,
            rounding_mode: inf::RoundingMode::from_str(&data.rounding_mode)
                .unwrap_or(inf::RoundingMode::HalfExpand),
            trailing_zero_display: if data.trailing_zero_display == "stripIfInteger" {
                inf::TrailingZeroDisplay::StripIfInteger
            } else {
                inf::TrailingZeroDisplay::Auto
            },
        }
    }

    /// Build the `Array<{type, value}>` a `formatToParts` call returns.
    pub(in crate::interp) fn number_format_parts_array(
        &mut self,
        parts: Vec<crate::intl_number::Part>,
    ) -> Slot {
        let arr = self.new_array();
        for (i, part) in parts.iter().enumerate() {
            let obj = self.slots.alloc(Slot::instance(self.object_proto));
            let ty = self.intl_string(part.kind.as_str());
            self.define_descriptor_field(obj, "type", ty);
            let val = self.intl_string(&part.value);
            self.define_descriptor_field(obj, "value", val);
            let mut item = Slot::of(Kind::Reference, Payload::Reference(obj));
            item.id = 0;
            item.next = crate::value::SlotIndex::NULL;
            self.arrays
                .get_mut(&arr)
                .unwrap()
                .insert_item(i as u32, item, &mut self.side_refs);
        }
        self.arrays.get_mut(&arr).unwrap().length = parts.len() as u32;
        Slot::of(Kind::Reference, Payload::Reference(arr))
    }
}
