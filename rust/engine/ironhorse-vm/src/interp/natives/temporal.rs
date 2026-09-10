//! VM-facing temporal builtin algorithms.
use super::super::*;

impl Interp {
    pub(in crate::interp) fn temporal_bigint_to_i128(&self, value: Slot) -> Option<i128> {
        let Payload::BigInt(off) = value.value else {
            return None;
        };
        let (negative, limbs) = self.read_bigint(off);
        let mut magnitude = 0u128;
        for &limb in limbs.iter().rev() {
            magnitude = magnitude
                .checked_mul(1u128 << 32)?
                .checked_add(limb as u128)?;
        }
        if negative {
            if magnitude == (1u128 << 127) {
                Some(i128::MIN)
            } else {
                i128::try_from(magnitude).ok()?.checked_neg()
            }
        } else {
            i128::try_from(magnitude).ok()
        }
    }

    pub(in crate::interp) fn temporal_i128_bigint(&mut self, value: i128) -> Slot {
        let negative = value < 0;
        let mut magnitude = value.unsigned_abs();
        let mut limbs = Vec::new();
        while magnitude != 0 {
            limbs.push(magnitude as u32);
            magnitude >>= 32;
        }
        if limbs.is_empty() {
            limbs.push(0);
        }
        self.make_bigint(negative, limbs)
    }

    pub(in crate::interp) fn temporal_integer(&mut self, value: Slot) -> Result<i64, Step> {
        let value = self.to_number_value(&[], value)?;
        let n = to_number(&value);
        if !n.is_finite() || n.fract() != 0.0 || n.abs() > 9_007_199_254_740_991.0 {
            return Err(self.catchable_range_error_msg(
                "Temporal: expected a finite integral value within the supported range".into(),
            ));
        }
        Ok(n as i64)
    }

    pub(in crate::interp) fn temporal_new_instant(
        &mut self,
        epoch_nanoseconds: i128,
    ) -> Result<Slot, Step> {
        const LIMIT: i128 = 8_640_000_000_000_000_000_000;
        if !(-LIMIT..=LIMIT).contains(&epoch_nanoseconds) {
            return Err(
                self.catchable_range_error_msg("Temporal: epoch nanoseconds out of range".into())
            );
        }
        let inst = self
            .slots
            .alloc(Slot::instance(self.temporal_instant_proto));
        self.temporal_instants
            .insert(inst, TemporalInstantRecord { epoch_nanoseconds });
        Ok(Slot::of(Kind::Reference, Payload::Reference(inst)))
    }

    pub(in crate::interp) fn temporal_new_duration(
        &mut self,
        record: TemporalDurationRecord,
    ) -> Result<Slot, Step> {
        if !temporal_duration_sign_valid(record) {
            return Err(self.catchable_range_error_msg(
                "Temporal.Duration: fields must have a consistent sign".into(),
            ));
        }
        let inst = self
            .slots
            .alloc(Slot::instance(self.temporal_duration_proto));
        self.temporal_durations.insert(inst, record);
        Ok(Slot::of(Kind::Reference, Payload::Reference(inst)))
    }

    fn temporal_new_plain(&mut self, record: TemporalPlainRecord) -> Result<Slot, Step> {
        if !temporal_plain_valid(record) {
            return Err(self.catchable_range_error_msg("Temporal: invalid date/time fields".into()));
        }
        let inst = self.slots.alloc(Slot::instance(
            self.temporal_plain_protos[record.kind as usize],
        ));
        self.temporal_plains.insert(inst, record);
        Ok(Slot::of(Kind::Reference, Payload::Reference(inst)))
    }

    pub(in crate::interp) fn temporal_plain_construct(
        &mut self,
        kind: u8,
        args: &[Slot],
        code: &[u8],
    ) -> Result<Slot, Step> {
        if kind == 5 {
            let id =
                self.value_to_string(code, args.first().copied().unwrap_or_else(Slot::undefined))?;
            if id != "iso8601" {
                return Err(self.catchable_range_error_msg("Temporal: unsupported calendar".into()));
            }
            return self.temporal_new_plain(TemporalPlainRecord {
                kind,
                ..Default::default()
            });
        }
        let integer = |this: &mut Self, i: usize, default: i64| -> Result<i64, Step> {
            let value = args.get(i).copied().unwrap_or_else(Slot::undefined);
            if value.kind == Kind::Undefined {
                Ok(default)
            } else {
                this.temporal_integer(value)
            }
        };
        let mut r = TemporalPlainRecord {
            kind,
            ..Default::default()
        };
        match kind {
            0 | 2 => {
                r.year = integer(self, 0, 0)?;
                r.month = u32::try_from(integer(self, 1, 0)?).map_err(|_| {
                    self.catchable_range_error_msg("Temporal: month out of range".into())
                })?;
                r.day = u32::try_from(integer(self, 2, 0)?).map_err(|_| {
                    self.catchable_range_error_msg("Temporal: day out of range".into())
                })?;
                if kind == 2 {
                    temporal_set_time_args(self, &mut r, args, 3)?;
                }
            }
            1 => temporal_set_time_args(self, &mut r, args, 0)?,
            3 => {
                r.year = integer(self, 0, 0)?;
                r.month = u32::try_from(integer(self, 1, 0)?).map_err(|_| {
                    self.catchable_range_error_msg("Temporal: month out of range".into())
                })?;
                r.day = u32::try_from(integer(self, 3, 1)?).map_err(|_| {
                    self.catchable_range_error_msg("Temporal: day out of range".into())
                })?;
            }
            4 => {
                r.month = u32::try_from(integer(self, 0, 0)?).map_err(|_| {
                    self.catchable_range_error_msg("Temporal: month out of range".into())
                })?;
                r.day = u32::try_from(integer(self, 1, 0)?).map_err(|_| {
                    self.catchable_range_error_msg("Temporal: day out of range".into())
                })?;
                r.year = integer(self, 3, 1972)?;
            }
            _ => unreachable!(),
        }
        self.temporal_new_plain(r)
    }

    fn temporal_plain_from(
        &mut self,
        kind: u8,
        value: Slot,
        code: &[u8],
    ) -> Result<TemporalPlainRecord, Step> {
        if kind == 5 {
            if let Payload::Reference(i) = value.value {
                if let Some(r) = self.temporal_plains.get(&i).filter(|r| r.kind == 5) {
                    return Ok(*r);
                }
            }
            let id = self.value_to_string(code, value)?;
            return if id == "iso8601" {
                Ok(TemporalPlainRecord {
                    kind,
                    ..Default::default()
                })
            } else {
                Err(self.catchable_range_error_msg("Temporal: unsupported calendar".into()))
            };
        }
        if let Payload::Reference(i) = value.value {
            if let Some(r) = self.temporal_plains.get(&i).filter(|r| r.kind == kind) {
                return Ok(*r);
            }
            let mut r = TemporalPlainRecord {
                kind,
                year: if kind == 4 { 1972 } else { 0 },
                day: if kind == 3 { 1 } else { 0 },
                ..Default::default()
            };
            let names = [
                "year",
                "month",
                "day",
                "hour",
                "minute",
                "second",
                "millisecond",
                "microsecond",
                "nanosecond",
            ];
            let mut seen = [false; 9];
            for (n, name) in names.iter().enumerate() {
                let Some(&id) = self.symbol_ids.get(*name) else {
                    continue;
                };
                let item = self.ordinary_get(code, i, id, value)?;
                if item.kind == Kind::Undefined {
                    continue;
                }
                let v = self.temporal_integer(item)?;
                seen[n] = true;
                match n {
                    0 => r.year = v,
                    1 => {
                        r.month = u32::try_from(v).map_err(|_| {
                            self.catchable_range_error_msg("Temporal: month out of range".into())
                        })?
                    }
                    2 => {
                        r.day = u32::try_from(v).map_err(|_| {
                            self.catchable_range_error_msg("Temporal: day out of range".into())
                        })?
                    }
                    3 => {
                        r.hour = u32::try_from(v).map_err(|_| {
                            self.catchable_range_error_msg("Temporal: hour out of range".into())
                        })?
                    }
                    4 => {
                        r.minute = u32::try_from(v).map_err(|_| {
                            self.catchable_range_error_msg("Temporal: minute out of range".into())
                        })?
                    }
                    5 => {
                        r.second = u32::try_from(v).map_err(|_| {
                            self.catchable_range_error_msg("Temporal: second out of range".into())
                        })?
                    }
                    6 => {
                        r.millisecond = u32::try_from(v).map_err(|_| {
                            self.catchable_range_error_msg(
                                "Temporal: millisecond out of range".into(),
                            )
                        })?
                    }
                    7 => {
                        r.microsecond = u32::try_from(v).map_err(|_| {
                            self.catchable_range_error_msg(
                                "Temporal: microsecond out of range".into(),
                            )
                        })?
                    }
                    _ => {
                        r.nanosecond = u32::try_from(v).map_err(|_| {
                            self.catchable_range_error_msg(
                                "Temporal: nanosecond out of range".into(),
                            )
                        })?
                    }
                }
            }
            let required = match kind {
                0 | 2 => seen[0] && seen[1] && seen[2],
                1 => seen[3] || seen[4] || seen[5] || seen[6] || seen[7] || seen[8],
                3 => seen[0] && seen[1],
                4 => seen[1] && seen[2],
                _ => false,
            };
            if !required || !temporal_plain_valid(r) {
                return Err(self.catchable_type_error_msg(
                    "Temporal: missing or invalid required date/time fields".into(),
                ));
            }
            return Ok(r);
        }
        let text = self.value_to_string(code, value)?;
        parse_temporal_plain(kind, &text).ok_or_else(|| {
            self.catchable_range_error_msg("Temporal: invalid date/time string".into())
        })
    }

    pub(in crate::interp) fn temporal_plain_method(
        &mut self,
        kind: u8,
        op: u8,
        this: Slot,
        arg0: Slot,
        arg1: Slot,
        code: &[u8],
    ) -> Result<Slot, Step> {
        if op == 0 {
            let r = self.temporal_plain_from(kind, arg0, code)?;
            return self.temporal_new_plain(r);
        }
        if op == 1 {
            let a = self.temporal_plain_from(kind, arg0, code)?;
            let b = self.temporal_plain_from(kind, arg1, code)?;
            return Ok(Slot::integer(
                temporal_plain_key(a).cmp(&temporal_plain_key(b)) as i32,
            ));
        }
        let old = temporal_brand(this, &self.temporal_plains)
            .filter(|r| r.kind == kind)
            .ok_or_else(|| {
                self.catchable_type_error_msg(
                    "Temporal: incompatible plain date/time receiver".into(),
                )
            })?;
        match op {
            2 => {
                let Payload::Reference(i) = arg0.value else {
                    return Err(self.catchable_type_error_msg(
                        "Temporal.with: fields must be an object".into(),
                    ));
                };
                let mut r = old;
                let mut any = false;
                for (n, name) in [
                    "year",
                    "month",
                    "day",
                    "hour",
                    "minute",
                    "second",
                    "millisecond",
                    "microsecond",
                    "nanosecond",
                ]
                .iter()
                .enumerate()
                {
                    let Some(&id) = self.symbol_ids.get(*name) else {
                        continue;
                    };
                    let v = self.ordinary_get(code, i, id, arg0)?;
                    if v.kind == Kind::Undefined {
                        continue;
                    }
                    let v = self.temporal_integer(v)?;
                    any = true;
                    match n {
                        0 => r.year = v,
                        1 => {
                            r.month = u32::try_from(v).map_err(|_| {
                                self.catchable_range_error_msg(
                                    "Temporal: month out of range".into(),
                                )
                            })?
                        }
                        2 => {
                            r.day = u32::try_from(v).map_err(|_| {
                                self.catchable_range_error_msg("Temporal: day out of range".into())
                            })?
                        }
                        3 => {
                            r.hour = u32::try_from(v).map_err(|_| {
                                self.catchable_range_error_msg("Temporal: hour out of range".into())
                            })?
                        }
                        4 => {
                            r.minute = u32::try_from(v).map_err(|_| {
                                self.catchable_range_error_msg(
                                    "Temporal: minute out of range".into(),
                                )
                            })?
                        }
                        5 => {
                            r.second = u32::try_from(v).map_err(|_| {
                                self.catchable_range_error_msg(
                                    "Temporal: second out of range".into(),
                                )
                            })?
                        }
                        6 => {
                            r.millisecond = u32::try_from(v).map_err(|_| {
                                self.catchable_range_error_msg(
                                    "Temporal: millisecond out of range".into(),
                                )
                            })?
                        }
                        7 => {
                            r.microsecond = u32::try_from(v).map_err(|_| {
                                self.catchable_range_error_msg(
                                    "Temporal: microsecond out of range".into(),
                                )
                            })?
                        }
                        _ => {
                            r.nanosecond = u32::try_from(v).map_err(|_| {
                                self.catchable_range_error_msg(
                                    "Temporal: nanosecond out of range".into(),
                                )
                            })?
                        }
                    }
                }
                if !any {
                    return Err(self.catchable_type_error_msg(
                        "Temporal.with: at least one date/time field is required".into(),
                    ));
                }
                self.temporal_new_plain(r)
            }
            3 | 4 => {
                let mut d = self.temporal_duration_from(arg0, code)?;
                if op == 4 {
                    d = d.negated().ok_or_else(|| {
                        self.catchable_range_error_msg(
                            "Temporal.Duration: negation out of range".into(),
                        )
                    })?;
                }
                let r = temporal_plain_add(old, d).ok_or_else(|| {
                    self.catchable_range_error_msg(
                        "Temporal: date/time arithmetic out of range".into(),
                    )
                })?;
                self.temporal_new_plain(r)
            }
            5 | 6 => {
                let other = self.temporal_plain_from(kind, arg0, code)?;
                let (a, b) = if op == 5 { (old, other) } else { (other, old) };
                let d = temporal_plain_difference(a, b).ok_or(Step::Host(Halt::NotImplemented(
                    "Temporal.Plain:difference-calendar",
                )))?;
                self.temporal_new_duration(d)
            }
            7 => Ok(Slot::boolean(
                old == self.temporal_plain_from(kind, arg0, code)?,
            )),
            8 | 9 => Ok(self.new_string_metered(format_temporal_plain(old).as_bytes())),
            10 => Err(self.catchable_type_error_msg(
                "Temporal: valueOf cannot convert to a primitive".into(),
            )),
            11 => self.temporal_new_plain(TemporalPlainRecord { kind: 0, ..old }),
            12 => self.temporal_new_plain(TemporalPlainRecord {
                kind: 1,
                year: 0,
                month: 0,
                day: 0,
                ..old
            }),
            13 if kind == 0 => {
                let t = self.temporal_plain_from(1, arg0, code)?;
                self.temporal_new_plain(TemporalPlainRecord {
                    kind: 2,
                    year: old.year,
                    month: old.month,
                    day: old.day,
                    ..t
                })
            }
            13 if kind == 1 => {
                let d = self.temporal_plain_from(0, arg0, code)?;
                self.temporal_new_plain(TemporalPlainRecord {
                    kind: 2,
                    hour: old.hour,
                    minute: old.minute,
                    second: old.second,
                    millisecond: old.millisecond,
                    microsecond: old.microsecond,
                    nanosecond: old.nanosecond,
                    ..d
                })
            }
            _ => Err(Step::Host(Halt::NotImplemented("Temporal.Plain:method"))),
        }
    }

    fn temporal_instant_from(&mut self, value: Slot, code: &[u8]) -> Result<i128, Step> {
        if let Payload::Reference(r) = value.value {
            if let Some(record) = self.temporal_instants.get(&r) {
                return Ok(record.epoch_nanoseconds);
            }
        }
        let text = self.value_to_string(code, value)?;
        parse_temporal_instant(&text).ok_or_else(|| {
            self.catchable_range_error_msg("Temporal.Instant: invalid instant string".into())
        })
    }

    fn temporal_duration_from(
        &mut self,
        value: Slot,
        code: &[u8],
    ) -> Result<TemporalDurationRecord, Step> {
        if let Payload::Reference(r) = value.value {
            if let Some(record) = self.temporal_durations.get(&r) {
                return Ok(*record);
            }
            let names = [
                "years",
                "months",
                "weeks",
                "days",
                "hours",
                "minutes",
                "seconds",
                "milliseconds",
                "microseconds",
                "nanoseconds",
            ];
            let mut fields = [0i64; 10];
            let mut any = false;
            for (i, name) in names.iter().enumerate() {
                let Some(&id) = self.symbol_ids.get(*name) else {
                    continue;
                };
                let receiver = Slot::of(Kind::Reference, Payload::Reference(r));
                let item = self.ordinary_get(code, r, id, receiver)?;
                if item.kind != Kind::Undefined {
                    fields[i] = self.temporal_integer(item)?;
                    any = true;
                }
            }
            if !any {
                return Err(self.catchable_type_error_msg(
                    "Temporal.Duration: at least one duration field is required".into(),
                ));
            }
            let record = TemporalDurationRecord::from_fields(fields);
            if !temporal_duration_sign_valid(record) {
                return Err(self.catchable_range_error_msg(
                    "Temporal.Duration: fields must have a consistent sign".into(),
                ));
            }
            return Ok(record);
        }
        let text = self.value_to_string(code, value)?;
        parse_temporal_duration(&text).ok_or_else(|| {
            self.catchable_range_error_msg("Temporal.Duration: invalid duration string".into())
        })
    }

    fn temporal_unit_option(
        &mut self,
        value: Slot,
        code: &[u8],
        default: &str,
    ) -> Result<String, Step> {
        if value.kind == Kind::Undefined {
            return Ok(default.to_string());
        }
        if let Payload::Reference(r) = value.value {
            for name in ["smallestUnit", "unit"] {
                if let Some(text) = self.intl_option_string(code, r, name)? {
                    return Ok(text);
                }
            }
            return Ok(default.to_string());
        }
        self.value_to_string(code, value)
    }

    /// Resolve a `relativeTo` option to its ISO `PlainDate` (`kind == 0`). In
    /// the fixed-offset, constant-24-hour-day model the *date* is the only part
    /// of a relative reference that affects a duration total/round/compare — a
    /// `PlainDate`, `PlainDateTime`, or `ZonedDateTime` all reduce to their
    /// (local, for zoned) calendar date. Returns `None` when `relativeTo` is
    /// absent (`undefined`/`null`), letting the caller decide whether the
    /// operation needs a reference (a `RangeError` for calendar units).
    fn temporal_relative_to_date(
        &mut self,
        options: Slot,
        code: &[u8],
    ) -> Result<Option<TemporalPlainRecord>, Step> {
        if options.kind == Kind::Undefined {
            return Ok(None);
        }
        let Payload::Reference(r) = options.value else {
            // A non-object, non-undefined options argument is a TypeError for
            // every Temporal reader that accepts an options bag.
            return Err(self.catchable_type_error_msg("Temporal: options must be an object".into()));
        };
        if options.kind != Kind::Reference {
            return Err(self.catchable_type_error_msg("Temporal: options must be an object".into()));
        }
        let Some(&id) = self.symbol_ids.get("relativeTo") else {
            return Ok(None);
        };
        let value = self.ordinary_get(code, r, id, options)?;
        if value.kind == Kind::Undefined || value.kind == Kind::Null {
            return Ok(None);
        }
        // A branded `ZonedDateTime` resolves to its local wall-clock date; every
        // other date-bearing value (`PlainDate`/`PlainDateTime` brand, property
        // bag, or ISO string) is read as a `PlainDate` via the shared reader,
        // which sources `year`/`month`/`day` (getters on a branded instance,
        // own properties on a bag) or parses a string's date portion.
        if let Some(zoned) = self.temporal_zoned_brand(value) {
            let local = zoned_local_datetime(zoned.epoch_nanoseconds, zoned.offset_ns);
            return Ok(Some(iso_date(local.year, local.month, local.day)));
        }
        let date = self.temporal_plain_from(0, value, code)?;
        Ok(Some(iso_date(date.year, date.month, date.day)))
    }

    /// The exact nanosecond span a duration represents. With a `relative` date
    /// the calendar units are resolved by ISO `dateAdd`; without one a duration
    /// carrying calendar units (`years`/`months`/`weeks`) is a `RangeError`
    /// (`relativeTo` is required), while days are treated as fixed 24-hour days.
    fn temporal_duration_span(
        &mut self,
        d: TemporalDurationRecord,
        relative: Option<TemporalPlainRecord>,
    ) -> Result<i128, Step> {
        match relative {
            Some(start) => iso_duration_span_nanoseconds(start, d).ok_or_else(|| {
                self.catchable_range_error_msg("Temporal: duration span out of range".into())
            }),
            None => {
                if d.has_calendar_units() {
                    return Err(self.catchable_range_error_msg(
                        "Temporal: relativeTo is required for calendar units".into(),
                    ));
                }
                d.time_nanoseconds(true).ok_or_else(|| {
                    self.catchable_range_error_msg(
                        "Temporal: duration cannot be represented in nanoseconds".into(),
                    )
                })
            }
        }
    }

    /// `Temporal.Duration.prototype.round`: round a duration to a smallest unit /
    /// increment and re-balance to a largest unit. A bare string argument is the
    /// smallestUnit; an options bag supplies `smallestUnit`/`largestUnit`/
    /// `roundingIncrement`/`roundingMode`/`relativeTo`. Calendar units (in the
    /// duration, the smallest, or the largest unit) require a `relativeTo`; the
    /// exact nanosecond span is resolved against that ISO date under the
    /// constant-24-hour-day model.
    fn temporal_duration_round(
        &mut self,
        d: TemporalDurationRecord,
        options: Slot,
        code: &[u8],
    ) -> Result<TemporalDurationRecord, Step> {
        const DAY_NS: i128 = 86_400_000_000_000;
        let (smallest, largest_opt, increment, mode, relative) = if options.kind == Kind::String {
            (
                Some(self.value_to_string(code, options)?),
                None,
                1i64,
                "halfExpand".to_string(),
                None,
            )
        } else if let Payload::Reference(r) = options.value {
            if options.kind != Kind::Reference {
                return Err(self.catchable_type_error_msg(
                    "Temporal: expected a unit string or options object".into(),
                ));
            }
            let smallest = self.intl_option_string(code, r, "smallestUnit")?;
            let largest = self.intl_option_string(code, r, "largestUnit")?;
            if smallest.is_none() && largest.is_none() {
                return Err(self.catchable_range_error_msg(
                    "Temporal.round: smallestUnit or largestUnit is required".into(),
                ));
            }
            let increment = if let Some(&id) = self.symbol_ids.get("roundingIncrement") {
                let v = self.ordinary_get(code, r, id, options)?;
                if v.kind == Kind::Undefined {
                    1
                } else {
                    self.temporal_integer(v)?
                }
            } else {
                1
            };
            if increment < 1 {
                return Err(self.catchable_range_error_msg(
                    "Temporal: roundingIncrement must be positive".into(),
                ));
            }
            let mode = self
                .intl_option_string(code, r, "roundingMode")?
                .unwrap_or_else(|| "halfExpand".to_string());
            let relative = self.temporal_relative_to_date(options, code)?;
            (smallest, largest, increment, mode, relative)
        } else {
            return Err(self.catchable_type_error_msg(
                "Temporal: expected a unit string or options object".into(),
            ));
        };

        let default_present = temporal_duration_default_largest_rank(d);
        let smallest_rank = match &smallest {
            Some(s) => temporal_unit_rank(s).ok_or_else(|| {
                self.catchable_range_error_msg("Temporal: invalid duration unit".into())
            })?,
            None => 9,
        };
        let largest_rank = match largest_opt.as_deref() {
            Some("auto") | None => default_present.min(smallest_rank),
            Some(l) => temporal_unit_rank(l).ok_or_else(|| {
                self.catchable_range_error_msg("Temporal: invalid duration unit".into())
            })?,
        };
        // largestUnit must be the same size or coarser (smaller rank) than smallestUnit.
        if largest_rank > smallest_rank {
            return Err(self.catchable_range_error_msg(
                "Temporal: largestUnit must not be smaller than smallestUnit".into(),
            ));
        }
        validate_duration_increment(smallest_rank, increment).ok_or_else(|| {
            self.catchable_range_error_msg(
                "Temporal: invalid roundingIncrement for smallestUnit".into(),
            )
        })?;

        let smallest_name = temporal_unit_name(smallest_rank);
        let largest_name = temporal_unit_name(largest_rank);

        let calendar_involved = d.has_calendar_units() || smallest_rank < 3 || largest_rank < 3;
        if calendar_involved && relative.is_none() {
            return Err(self.catchable_range_error_msg(
                "Temporal: relativeTo is required for calendar units".into(),
            ));
        }

        if smallest_rank >= 3 {
            // Fixed-length smallest unit: round the exact nanosecond span.
            let span = self.temporal_duration_span(d, relative)?;
            let unit_ns = if smallest_name == "day" {
                DAY_NS
            } else {
                temporal_unit_nanoseconds(smallest_name).ok_or_else(|| {
                    self.catchable_range_error_msg("Temporal: invalid time unit".into())
                })?
            };
            let quantum = unit_ns.checked_mul(increment as i128).ok_or_else(|| {
                self.catchable_range_error_msg("Temporal: rounding increment out of range".into())
            })?;
            let rounded = round_temporal(span, quantum, &mode).ok_or_else(|| {
                self.catchable_range_error_msg(
                    "Temporal: invalid rounding mode or result out of range".into(),
                )
            })?;
            if largest_rank >= 3 {
                balance_zoned_diff(rounded, largest_name).ok_or_else(|| {
                    self.catchable_range_error_msg("Temporal: duration balance out of range".into())
                })
            } else {
                let start = relative.ok_or_else(|| {
                    self.catchable_range_error_msg(
                        "Temporal: relativeTo is required for calendar units".into(),
                    )
                })?;
                let start_days =
                    days_from_civil(start.year, start.month, start.day).ok_or_else(|| {
                        self.catchable_range_error_msg(
                            "Temporal: relativeTo date out of range".into(),
                        )
                    })?;
                let day_offset = rounded.div_euclid(DAY_NS);
                let time_ns = rounded.rem_euclid(DAY_NS);
                let (ey, em, ed) = civil_from_days(start_days + day_offset);
                let start_dt = TemporalPlainRecord {
                    kind: 2,
                    year: start.year,
                    month: start.month,
                    day: start.day,
                    ..Default::default()
                };
                let end_dt = TemporalPlainRecord {
                    kind: 2,
                    year: ey,
                    month: em,
                    day: ed,
                    hour: (time_ns / 3_600_000_000_000) as u32,
                    minute: ((time_ns / 60_000_000_000) % 60) as u32,
                    second: ((time_ns / 1_000_000_000) % 60) as u32,
                    millisecond: ((time_ns / 1_000_000) % 1000) as u32,
                    microsecond: ((time_ns / 1_000) % 1000) as u32,
                    nanosecond: (time_ns % 1000) as u32,
                };
                iso_datetime_difference(start_dt, end_dt, largest_name).ok_or_else(|| {
                    self.catchable_range_error_msg(
                        "Temporal: date/time difference out of range".into(),
                    )
                })
            }
        } else {
            // Calendar smallest unit: round the fractional calendar total, then
            // re-express the whole-unit endpoint as a calendar difference.
            let start = relative.ok_or_else(|| {
                self.catchable_range_error_msg(
                    "Temporal: relativeTo is required for calendar units".into(),
                )
            })?;
            let span = iso_duration_span_nanoseconds(start, d).ok_or_else(|| {
                self.catchable_range_error_msg("Temporal: duration span out of range".into())
            })?;
            let total = match smallest_name {
                "year" | "month" => iso_total_calendar_units(start, span, smallest_name)
                    .ok_or_else(|| {
                        self.catchable_range_error_msg(
                            "Temporal: calendar duration total out of range".into(),
                        )
                    })?,
                _ => span as f64 / (7.0 * DAY_NS as f64), // week
            };
            let count = round_number_to_increment(total, increment, &mode) as i64;
            let dest = match smallest_name {
                "year" => iso_date_add(start, count, 0, 0, 0),
                "month" => iso_date_add(start, 0, count, 0, 0),
                _ => iso_date_add(start, 0, 0, count, 0), // week
            }
            .ok_or_else(|| {
                self.catchable_range_error_msg(
                    "Temporal: rounded calendar date out of range".into(),
                )
            })?;
            iso_date_until(start, dest, largest_name).ok_or_else(|| {
                self.catchable_range_error_msg("Temporal: calendar difference out of range".into())
            })
        }
    }

    pub(in crate::interp) fn temporal_method(
        &mut self,
        method: NativeMethod,
        this: Slot,
        arg0: Slot,
        arg1: Slot,
        arg2: Slot,
        code: &[u8],
    ) -> Result<Slot, Step> {
        use NativeMethod::*;
        match method {
            TemporalInstantFrom => {
                let ns = self.temporal_instant_from(arg0, code)?;
                self.temporal_new_instant(ns)
            }
            TemporalInstantFromEpochMilliseconds => {
                let n = self.temporal_integer(arg0)? as i128;
                let ns = match n.checked_mul(1_000_000) {
                    Some(ns) => ns,
                    None => {
                        return Err(self.catchable_range_error_msg(
                            "Temporal: epoch nanoseconds out of range".into(),
                        ))
                    }
                };
                self.temporal_new_instant(ns)
            }
            TemporalInstantFromEpochNanoseconds => {
                let ns = self.temporal_bigint_to_i128(arg0).ok_or_else(|| {
                    self.catchable_type_error_msg(
                        "Temporal.Instant: epochNanoseconds must be a supported BigInt".into(),
                    )
                })?;
                self.temporal_new_instant(ns)
            }
            TemporalInstantCompare => {
                let a = self.temporal_instant_from(arg0, code)?;
                let b = self.temporal_instant_from(arg1, code)?;
                Ok(Slot::integer(a.cmp(&b) as i32))
            }
            TemporalInstantAdd | TemporalInstantSubtract => {
                let inst = temporal_brand(this, &self.temporal_instants).ok_or_else(|| {
                    self.catchable_type_error_msg("Temporal.Instant: incompatible receiver".into())
                })?;
                let d = self.temporal_duration_from(arg0, code)?;
                let mut delta = d.time_nanoseconds(false).ok_or_else(|| {
                    self.catchable_range_error_msg(
                        "Temporal: duration cannot be represented in nanoseconds".into(),
                    )
                })?;
                if method == TemporalInstantSubtract {
                    delta = delta.checked_neg().ok_or_else(|| {
                        self.catchable_range_error_msg(
                            "Temporal.Duration: negation out of range".into(),
                        )
                    })?;
                }
                let ns = match inst.epoch_nanoseconds.checked_add(delta) {
                    Some(ns) => ns,
                    None => {
                        return Err(self.catchable_range_error_msg(
                            "Temporal: epoch nanoseconds out of range".into(),
                        ))
                    }
                };
                self.temporal_new_instant(ns)
            }
            TemporalInstantUntil | TemporalInstantSince => {
                let inst = temporal_brand(this, &self.temporal_instants).ok_or_else(|| {
                    self.catchable_type_error_msg("Temporal.Instant: incompatible receiver".into())
                })?;
                let other = self.temporal_instant_from(arg0, code)?;
                let delta = if method == TemporalInstantUntil {
                    other - inst.epoch_nanoseconds
                } else {
                    inst.epoch_nanoseconds - other
                };
                self.temporal_new_duration(duration_from_nanoseconds(delta))
            }
            TemporalInstantRound => {
                let inst = temporal_brand(this, &self.temporal_instants).ok_or_else(|| {
                    self.catchable_type_error_msg("Temporal.Instant: incompatible receiver".into())
                })?;
                let unit = self.temporal_unit_option(arg0, code, "nanosecond")?;
                let quantum = temporal_unit_nanoseconds(&unit).ok_or_else(|| {
                    self.catchable_range_error_msg("Temporal: invalid time unit".into())
                })?;
                let ns = round_half_expand(inst.epoch_nanoseconds, quantum);
                self.temporal_new_instant(ns)
            }
            TemporalInstantEquals => {
                let inst = temporal_brand(this, &self.temporal_instants).ok_or_else(|| {
                    self.catchable_type_error_msg("Temporal.Instant: incompatible receiver".into())
                })?;
                Ok(Slot::boolean(
                    inst.epoch_nanoseconds == self.temporal_instant_from(arg0, code)?,
                ))
            }
            TemporalInstantToString | TemporalInstantToJSON => {
                let inst = temporal_brand(this, &self.temporal_instants).ok_or_else(|| {
                    self.catchable_type_error_msg("Temporal.Instant: incompatible receiver".into())
                })?;
                Ok(self
                    .new_string_metered(format_temporal_instant(inst.epoch_nanoseconds).as_bytes()))
            }
            TemporalInstantValueOf | TemporalDurationValueOf => Err(self.catchable_type_error_msg(
                "Temporal: valueOf cannot convert to a primitive".into(),
            )),
            TemporalDurationFrom => {
                let record = self.temporal_duration_from(arg0, code)?;
                self.temporal_new_duration(record)
            }
            TemporalDurationCompare => {
                let a = self.temporal_duration_from(arg0, code)?;
                let b = self.temporal_duration_from(arg1, code)?;
                // Field-identical durations compare equal without a relativeTo
                // (spec: identical internal slots return +0), even when they
                // carry calendar units a bare comparison could not resolve.
                if a.fields() == b.fields() {
                    // A relativeTo is still observed if present (its getters run),
                    // but never required for the identical case.
                    let _ = self.temporal_relative_to_date(arg2, code)?;
                    return Ok(Slot::integer(0));
                }
                let relative = self.temporal_relative_to_date(arg2, code)?;
                let av = self.temporal_duration_span(a, relative)?;
                let bv = self.temporal_duration_span(b, relative)?;
                Ok(Slot::integer(av.cmp(&bv) as i32))
            }
            TemporalDurationNegated | TemporalDurationAbs => {
                let mut d = temporal_brand(this, &self.temporal_durations).ok_or_else(|| {
                    self.catchable_type_error_msg("Temporal.Duration: incompatible receiver".into())
                })?;
                if method == TemporalDurationNegated || d.sign() < 0 {
                    d = d.negated().ok_or_else(|| {
                        self.catchable_range_error_msg(
                            "Temporal.Duration: negation out of range".into(),
                        )
                    })?;
                }
                self.temporal_new_duration(d)
            }
            TemporalDurationAdd | TemporalDurationSubtract => {
                let a = temporal_brand(this, &self.temporal_durations).ok_or_else(|| {
                    self.catchable_type_error_msg("Temporal.Duration: incompatible receiver".into())
                })?;
                let mut b = self.temporal_duration_from(arg0, code)?;
                if method == TemporalDurationSubtract {
                    b = b.negated().ok_or_else(|| {
                        self.catchable_range_error_msg(
                            "Temporal.Duration: negation out of range".into(),
                        )
                    })?;
                }
                let af = a.fields();
                let bf = b.fields();
                let mut out = [0i64; 10];
                for i in 0..10 {
                    out[i] = af[i].checked_add(bf[i]).ok_or_else(|| {
                        self.catchable_range_error_msg(
                            "Temporal.Duration: field addition out of range".into(),
                        )
                    })?;
                }
                self.temporal_new_duration(TemporalDurationRecord::from_fields(out))
            }
            TemporalDurationWith => {
                let old = temporal_brand(this, &self.temporal_durations).ok_or_else(|| {
                    self.catchable_type_error_msg("Temporal.Duration: incompatible receiver".into())
                })?;
                let Payload::Reference(r) = arg0.value else {
                    return Err(self.catchable_type_error_msg(
                        "Temporal.with: fields must be an object".into(),
                    ));
                };
                let names = [
                    "years",
                    "months",
                    "weeks",
                    "days",
                    "hours",
                    "minutes",
                    "seconds",
                    "milliseconds",
                    "microseconds",
                    "nanoseconds",
                ];
                let mut fields = old.fields();
                let mut any = false;
                for (i, name) in names.iter().enumerate() {
                    let Some(&id) = self.symbol_ids.get(*name) else {
                        continue;
                    };
                    let item = self.ordinary_get(code, r, id, arg0)?;
                    if item.kind != Kind::Undefined {
                        fields[i] = self.temporal_integer(item)?;
                        any = true;
                    }
                }
                if !any {
                    return Err(self.catchable_type_error_msg(
                        "Temporal.Duration: at least one duration field is required".into(),
                    ));
                }
                self.temporal_new_duration(TemporalDurationRecord::from_fields(fields))
            }
            TemporalDurationRound => {
                let d = temporal_brand(this, &self.temporal_durations).ok_or_else(|| {
                    self.catchable_type_error_msg("Temporal.Duration: incompatible receiver".into())
                })?;
                let record = self.temporal_duration_round(d, arg0, code)?;
                self.temporal_new_duration(record)
            }
            TemporalDurationTotal => {
                let d = temporal_brand(this, &self.temporal_durations).ok_or_else(|| {
                    self.catchable_type_error_msg("Temporal.Duration: incompatible receiver".into())
                })?;
                // `total` requires a `unit`: a bare string argument IS the unit,
                // an options bag must carry a `unit` property (no default), and
                // anything else is a TypeError.
                let (unit, relative) = if arg0.kind == Kind::String {
                    (self.value_to_string(code, arg0)?, None)
                } else if let Payload::Reference(r) = arg0.value {
                    if arg0.kind != Kind::Reference {
                        return Err(self.catchable_type_error_msg(
                            "Temporal: expected a unit string or options object".into(),
                        ));
                    }
                    let unit = self.intl_option_string(code, r, "unit")?.ok_or_else(|| {
                        self.catchable_range_error_msg(
                            "Temporal.Duration.total: unit is required".into(),
                        )
                    })?;
                    (unit, self.temporal_relative_to_date(arg0, code)?)
                } else {
                    return Err(self.catchable_type_error_msg(
                        "Temporal: expected a unit string or options object".into(),
                    ));
                };
                let unit_key = unit.trim_end_matches('s');
                match unit_key {
                    "year" | "month" => {
                        let start = relative.ok_or_else(|| {
                            self.catchable_range_error_msg(
                                "Temporal: relativeTo is required for calendar units".into(),
                            )
                        })?;
                        let span = iso_duration_span_nanoseconds(start, d).ok_or_else(|| {
                            self.catchable_range_error_msg(
                                "Temporal: duration span out of range".into(),
                            )
                        })?;
                        let total =
                            iso_total_calendar_units(start, span, unit_key).ok_or_else(|| {
                                self.catchable_range_error_msg(
                                    "Temporal: calendar duration total out of range".into(),
                                )
                            })?;
                        Ok(Slot::number(total))
                    }
                    "week" | "day" | "hour" | "minute" | "second" | "millisecond"
                    | "microsecond" | "nanosecond" => {
                        let span = self.temporal_duration_span(d, relative)?;
                        let q = if unit_key == "week" {
                            7 * 86_400_000_000_000i128
                        } else {
                            temporal_unit_nanoseconds(unit_key).ok_or_else(|| {
                                self.catchable_range_error_msg("Temporal: invalid time unit".into())
                            })?
                        };
                        Ok(Slot::number(span as f64 / q as f64))
                    }
                    _ => Err(self
                        .catchable_range_error_msg("Temporal.Duration.total: invalid unit".into())),
                }
            }
            TemporalDurationToString | TemporalDurationToJSON => {
                let d = temporal_brand(this, &self.temporal_durations).ok_or_else(|| {
                    self.catchable_type_error_msg("Temporal.Duration: incompatible receiver".into())
                })?;
                Ok(self.new_string_metered(format_temporal_duration(d).as_bytes()))
            }
            _ => unreachable!("non-Temporal method routed to temporal_method"),
        }
    }

    pub(in crate::interp) fn temporal_new_zoned(
        &mut self,
        epoch_nanoseconds: i128,
        time_zone: String,
        offset_ns: i64,
    ) -> Result<Slot, Step> {
        const LIMIT: i128 = 8_640_000_000_000_000_000_000;
        if !(-LIMIT..=LIMIT).contains(&epoch_nanoseconds) {
            return Err(
                self.catchable_range_error_msg("Temporal: epoch nanoseconds out of range".into())
            );
        }
        let inst = self.slots.alloc(Slot::instance(self.temporal_zoned_proto));
        self.temporal_zoneds.insert(
            inst,
            TemporalZonedRecord {
                epoch_nanoseconds,
                time_zone,
                offset_ns,
            },
        );
        Ok(Slot::of(Kind::Reference, Payload::Reference(inst)))
    }

    /// The branded `TemporalZonedRecord` of a `this` value, or `None` if the
    /// receiver is not a `Temporal.ZonedDateTime` (the `TypeError` at the call site).
    fn temporal_zoned_brand(&self, this: Slot) -> Option<TemporalZonedRecord> {
        match this.value {
            Payload::Reference(r) if this.kind == Kind::Reference => {
                self.temporal_zoneds.get(&r).cloned()
            }
            _ => None,
        }
    }

    /// ToTemporalZonedDateTime: an existing brand (copied), a property bag with a
    /// required `timeZone` plus ISO fields, or an ISO string with a `[timeZone]`
    /// annotation.
    fn temporal_zoned_from(
        &mut self,
        value: Slot,
        code: &[u8],
    ) -> Result<TemporalZonedRecord, Step> {
        if let Some(rec) = self.temporal_zoned_brand(value) {
            return Ok(rec);
        }
        if let Payload::Reference(r) = value.value {
            if value.kind == Kind::Reference {
                let Some(&tz_id) = self.symbol_ids.get("timeZone") else {
                    return Err(self.catchable_type_error_msg(
                        "Temporal.ZonedDateTime: timeZone is required".into(),
                    ));
                };
                let tz_val = self.ordinary_get(code, r, tz_id, value)?;
                if tz_val.kind == Kind::Undefined {
                    return Err(self.catchable_type_error_msg(
                        "Temporal.ZonedDateTime: timeZone is required".into(),
                    ));
                }
                let tz_text = self.value_to_string(code, tz_val)?;
                let (time_zone, offset_ns) =
                    resolve_zoned_time_zone(&tz_text).ok_or_else(|| {
                        self.catchable_range_error_msg(
                            "Temporal: invalid or unsupported time zone".into(),
                        )
                    })?;
                let mut p = TemporalPlainRecord {
                    kind: 2,
                    ..Default::default()
                };
                let names = [
                    "year",
                    "month",
                    "day",
                    "hour",
                    "minute",
                    "second",
                    "millisecond",
                    "microsecond",
                    "nanosecond",
                ];
                let mut seen = [false; 9];
                for (n, name) in names.iter().enumerate() {
                    let Some(&fid) = self.symbol_ids.get(*name) else {
                        continue;
                    };
                    let item = self.ordinary_get(code, r, fid, value)?;
                    if item.kind == Kind::Undefined {
                        continue;
                    }
                    let v = self.temporal_integer(item)?;
                    seen[n] = true;
                    match n {
                        0 => p.year = v,
                        1 => {
                            p.month = u32::try_from(v).map_err(|_| {
                                self.catchable_range_error_msg(
                                    "Temporal: month out of range".into(),
                                )
                            })?
                        }
                        2 => {
                            p.day = u32::try_from(v).map_err(|_| {
                                self.catchable_range_error_msg("Temporal: day out of range".into())
                            })?
                        }
                        3 => {
                            p.hour = u32::try_from(v).map_err(|_| {
                                self.catchable_range_error_msg("Temporal: hour out of range".into())
                            })?
                        }
                        4 => {
                            p.minute = u32::try_from(v).map_err(|_| {
                                self.catchable_range_error_msg(
                                    "Temporal: minute out of range".into(),
                                )
                            })?
                        }
                        5 => {
                            p.second = u32::try_from(v).map_err(|_| {
                                self.catchable_range_error_msg(
                                    "Temporal: second out of range".into(),
                                )
                            })?
                        }
                        6 => {
                            p.millisecond = u32::try_from(v).map_err(|_| {
                                self.catchable_range_error_msg(
                                    "Temporal: millisecond out of range".into(),
                                )
                            })?
                        }
                        7 => {
                            p.microsecond = u32::try_from(v).map_err(|_| {
                                self.catchable_range_error_msg(
                                    "Temporal: microsecond out of range".into(),
                                )
                            })?
                        }
                        _ => {
                            p.nanosecond = u32::try_from(v).map_err(|_| {
                                self.catchable_range_error_msg(
                                    "Temporal: nanosecond out of range".into(),
                                )
                            })?
                        }
                    }
                }
                if !(seen[0] && seen[1] && seen[2]) || !temporal_plain_valid(p) {
                    return Err(self.catchable_type_error_msg(
                        "Temporal: missing or invalid required date/time fields".into(),
                    ));
                }
                // A provided `offset` must agree with the fixed zone offset
                // (Temporal's default `offset: "reject"`).
                if let Some(&off_id) = self.symbol_ids.get("offset") {
                    let off_val = self.ordinary_get(code, r, off_id, value)?;
                    if off_val.kind != Kind::Undefined {
                        let s = self.value_to_string(code, off_val)?;
                        let provided = parse_offset_ns(&s).ok_or_else(|| {
                            self.catchable_range_error_msg("Temporal: invalid UTC offset".into())
                        })?;
                        if provided != offset_ns {
                            return Err(self.catchable_range_error_msg(
                                "Temporal.ZonedDateTime: offset does not match timeZone".into(),
                            ));
                        }
                    }
                }
                let epoch = local_datetime_to_epoch(&p, offset_ns).ok_or_else(|| {
                    self.catchable_range_error_msg(
                        "Temporal: date/time outside supported epoch range".into(),
                    )
                })?;
                return Ok(TemporalZonedRecord {
                    epoch_nanoseconds: epoch,
                    time_zone,
                    offset_ns,
                });
            }
        }
        let text = self.value_to_string(code, value)?;
        parse_temporal_zoned(&text).ok_or_else(|| {
            self.catchable_range_error_msg(
                "Temporal.ZonedDateTime: invalid zoned date/time string".into(),
            )
        })
    }

    /// Resolve `round`/`until`/`since`'s options argument (a string smallestUnit
    /// shorthand, an object, or `undefined`) into `(smallestUnit, largestUnit,
    /// roundingIncrement, roundingMode)`. `largest_default`/`smallest_default` are
    /// the per-operation defaults; a required-but-absent smallestUnit yields `None`.
    fn temporal_zoned_round_options(
        &mut self,
        arg: Slot,
        code: &[u8],
        smallest_default: Option<&str>,
        largest_default: &str,
        mode_default: &str,
    ) -> Result<(String, String, i128, String), Step> {
        // A bare string argument is the smallestUnit.
        if arg.kind == Kind::String {
            let unit = self.value_to_string(code, arg)?;
            return Ok((
                unit,
                largest_default.to_string(),
                1,
                mode_default.to_string(),
            ));
        }
        let Payload::Reference(r) = arg.value else {
            return match smallest_default {
                Some(d) => Ok((
                    d.to_string(),
                    largest_default.to_string(),
                    1,
                    mode_default.to_string(),
                )),
                None => Err(self.catchable_type_error_msg(
                    "Temporal: expected a unit string or options object".into(),
                )),
            };
        };
        if arg.kind != Kind::Reference {
            return Err(self.catchable_type_error_msg("Temporal: options must be an object".into()));
        }
        let smallest = match self.intl_option_string(code, r, "smallestUnit")? {
            Some(u) => u,
            None => match smallest_default {
                Some(d) => d.to_string(),
                None => {
                    return Err(self.catchable_range_error_msg(
                        "Temporal.round: smallestUnit is required".into(),
                    ))
                }
            },
        };
        let largest = self
            .intl_option_string(code, r, "largestUnit")?
            .unwrap_or_else(|| largest_default.to_string());
        let mode = self
            .intl_option_string(code, r, "roundingMode")?
            .unwrap_or_else(|| mode_default.to_string());
        let increment = if let Some(&id) = self.symbol_ids.get("roundingIncrement") {
            let v = self.instance_get(r, id);
            if v.kind == Kind::Undefined {
                1
            } else {
                self.temporal_integer(v)? as i128
            }
        } else {
            1
        };
        if increment < 1 {
            return Err(self
                .catchable_range_error_msg("Temporal: roundingIncrement must be positive".into()));
        }
        Ok((smallest, largest, increment, mode))
    }

    pub(in crate::interp) fn temporal_zoned_method(
        &mut self,
        op: u8,
        this: Slot,
        arg0: Slot,
        arg1: Slot,
        code: &[u8],
    ) -> Result<Slot, Step> {
        // Statics: from(0), compare(1) — no `this` brand.
        if op == 0 {
            let rec = self.temporal_zoned_from(arg0, code)?;
            return self.temporal_new_zoned(rec.epoch_nanoseconds, rec.time_zone, rec.offset_ns);
        }
        if op == 1 {
            let a = self.temporal_zoned_from(arg0, code)?;
            let b = self.temporal_zoned_from(arg1, code)?;
            return Ok(Slot::integer(
                a.epoch_nanoseconds.cmp(&b.epoch_nanoseconds) as i32
            ));
        }
        let old = self.temporal_zoned_brand(this).ok_or_else(|| {
            self.catchable_type_error_msg("Temporal.ZonedDateTime: incompatible receiver".into())
        })?;
        match op {
            2 => {
                // with(fields): override present ISO date/time fields; the zone is fixed.
                let Payload::Reference(r) = arg0.value else {
                    return Err(self.catchable_type_error_msg(
                        "Temporal.with: fields must be an object".into(),
                    ));
                };
                if arg0.kind != Kind::Reference {
                    return Err(self.catchable_type_error_msg(
                        "Temporal.with: fields must be an object".into(),
                    ));
                }
                let mut p = zoned_local_datetime(old.epoch_nanoseconds, old.offset_ns);
                let mut any = false;
                for (n, name) in [
                    "year",
                    "month",
                    "day",
                    "hour",
                    "minute",
                    "second",
                    "millisecond",
                    "microsecond",
                    "nanosecond",
                ]
                .iter()
                .enumerate()
                {
                    let Some(&id) = self.symbol_ids.get(*name) else {
                        continue;
                    };
                    let v = self.ordinary_get(code, r, id, arg0)?;
                    if v.kind == Kind::Undefined {
                        continue;
                    }
                    let v = self.temporal_integer(v)?;
                    any = true;
                    match n {
                        0 => p.year = v,
                        1 => {
                            p.month = u32::try_from(v).map_err(|_| {
                                self.catchable_range_error_msg(
                                    "Temporal: month out of range".into(),
                                )
                            })?
                        }
                        2 => {
                            p.day = u32::try_from(v).map_err(|_| {
                                self.catchable_range_error_msg("Temporal: day out of range".into())
                            })?
                        }
                        3 => {
                            p.hour = u32::try_from(v).map_err(|_| {
                                self.catchable_range_error_msg("Temporal: hour out of range".into())
                            })?
                        }
                        4 => {
                            p.minute = u32::try_from(v).map_err(|_| {
                                self.catchable_range_error_msg(
                                    "Temporal: minute out of range".into(),
                                )
                            })?
                        }
                        5 => {
                            p.second = u32::try_from(v).map_err(|_| {
                                self.catchable_range_error_msg(
                                    "Temporal: second out of range".into(),
                                )
                            })?
                        }
                        6 => {
                            p.millisecond = u32::try_from(v).map_err(|_| {
                                self.catchable_range_error_msg(
                                    "Temporal: millisecond out of range".into(),
                                )
                            })?
                        }
                        7 => {
                            p.microsecond = u32::try_from(v).map_err(|_| {
                                self.catchable_range_error_msg(
                                    "Temporal: microsecond out of range".into(),
                                )
                            })?
                        }
                        _ => {
                            p.nanosecond = u32::try_from(v).map_err(|_| {
                                self.catchable_range_error_msg(
                                    "Temporal: nanosecond out of range".into(),
                                )
                            })?
                        }
                    }
                }
                if !any || !temporal_plain_valid(p) {
                    return Err(self.catchable_type_error_msg(
                        "Temporal: missing or invalid required date/time fields".into(),
                    ));
                }
                let epoch = local_datetime_to_epoch(&p, old.offset_ns).ok_or_else(|| {
                    self.catchable_range_error_msg(
                        "Temporal: date/time outside supported epoch range".into(),
                    )
                })?;
                self.temporal_new_zoned(epoch, old.time_zone, old.offset_ns)
            }
            3 | 4 => {
                // add / subtract a duration.
                let mut d = self.temporal_duration_from(arg0, code)?;
                if op == 4 {
                    d = d.negated().ok_or_else(|| {
                        self.catchable_range_error_msg(
                            "Temporal.Duration: negation out of range".into(),
                        )
                    })?;
                }
                let mut p = zoned_local_datetime(old.epoch_nanoseconds, old.offset_ns);
                // Add the date part (years/months/weeks/days) to the wall-clock
                // *date* only — a bare `PlainDate` (kind 0) so `temporal_plain_add`
                // never routes days through its time branch — then recombine with
                // the original wall-clock time.
                let date = TemporalPlainRecord {
                    kind: 0,
                    year: p.year,
                    month: p.month,
                    day: p.day,
                    ..Default::default()
                };
                let date_only = TemporalDurationRecord {
                    years: d.years,
                    months: d.months,
                    weeks: d.weeks,
                    days: d.days,
                    ..Default::default()
                };
                let shifted = temporal_plain_add(date, date_only).ok_or_else(|| {
                    self.catchable_range_error_msg(
                        "Temporal: date/time arithmetic out of range".into(),
                    )
                })?;
                p.year = shifted.year;
                p.month = shifted.month;
                p.day = shifted.day;
                let intermediate = local_datetime_to_epoch(&p, old.offset_ns).ok_or_else(|| {
                    self.catchable_range_error_msg(
                        "Temporal: date/time outside supported epoch range".into(),
                    )
                })?;
                let time_ns = TemporalDurationRecord {
                    hours: d.hours,
                    minutes: d.minutes,
                    seconds: d.seconds,
                    milliseconds: d.milliseconds,
                    microseconds: d.microseconds,
                    nanoseconds: d.nanoseconds,
                    ..Default::default()
                }
                .time_nanoseconds(false)
                .ok_or_else(|| {
                    self.catchable_range_error_msg(
                        "Temporal: duration cannot be represented in nanoseconds".into(),
                    )
                })?;
                let epoch = intermediate.checked_add(time_ns).ok_or_else(|| {
                    self.catchable_range_error_msg(
                        "Temporal: epoch nanoseconds out of range".into(),
                    )
                })?;
                self.temporal_new_zoned(epoch, old.time_zone, old.offset_ns)
            }
            5 | 6 => {
                // until / since: exact difference, balanced to the requested units.
                let other = self.temporal_zoned_from(arg0, code)?;
                let (a, b) = if op == 5 {
                    (&old, &other)
                } else {
                    (&other, &old)
                };
                let (smallest, largest, increment, mode) = self.temporal_zoned_round_options(
                    arg1,
                    code,
                    Some("nanosecond"),
                    "hour",
                    "trunc",
                )?;
                let smallest_rank = temporal_unit_rank(&smallest).ok_or_else(|| {
                    self.catchable_range_error_msg("Temporal: invalid duration unit".into())
                })?;
                let largest_rank = temporal_unit_rank(&largest).ok_or_else(|| {
                    self.catchable_range_error_msg("Temporal: invalid duration unit".into())
                })?;
                // largestUnit must be the same size or coarser than smallestUnit.
                if largest_rank > smallest_rank {
                    return Err(self.catchable_range_error_msg(
                        "Temporal: largestUnit must not be smaller than smallestUnit".into(),
                    ));
                }
                validate_duration_increment(smallest_rank, increment as i64).ok_or_else(|| {
                    self.catchable_range_error_msg(
                        "Temporal: invalid roundingIncrement for smallestUnit".into(),
                    )
                })?;
                if largest_rank >= 3 {
                    // Fixed-length largest unit: round the exact instant difference.
                    let mut diff = b.epoch_nanoseconds - a.epoch_nanoseconds;
                    let quantum = temporal_unit_nanoseconds(temporal_unit_name(smallest_rank))
                        .ok_or_else(|| {
                            self.catchable_range_error_msg("Temporal: invalid time unit".into())
                        })?
                        .checked_mul(increment)
                        .ok_or_else(|| {
                            self.catchable_range_error_msg(
                                "Temporal: rounding increment out of range".into(),
                            )
                        })?;
                    diff = round_temporal(diff, quantum, &mode).ok_or_else(|| {
                        self.catchable_range_error_msg(
                            "Temporal: invalid rounding mode or result out of range".into(),
                        )
                    })?;
                    let record = balance_zoned_diff(diff, temporal_unit_name(largest_rank))
                        .ok_or_else(|| {
                            self.catchable_range_error_msg(
                                "Temporal: duration balance out of range".into(),
                            )
                        })?;
                    self.temporal_new_duration(record)
                } else {
                    // Calendar largest unit (week/month/year): difference the local
                    // wall-clock datetimes on the ISO calendar. Under the fixed
                    // offset the wall clock and the instant advance together, so
                    // this is exact. A sub-day smallestUnit rounds the time part.
                    let a_local = zoned_local_datetime(a.epoch_nanoseconds, a.offset_ns);
                    let b_local = zoned_local_datetime(b.epoch_nanoseconds, b.offset_ns);
                    let mut record =
                        iso_datetime_difference(a_local, b_local, temporal_unit_name(largest_rank))
                            .ok_or_else(|| {
                                self.catchable_range_error_msg(
                                    "Temporal: date/time difference out of range".into(),
                                )
                            })?;
                    if smallest_rank > 3 {
                        let time_ns = record.time_only_nanoseconds().ok_or_else(|| {
                            self.catchable_range_error_msg(
                                "Temporal: duration cannot be represented in nanoseconds".into(),
                            )
                        })?;
                        let quantum = temporal_unit_nanoseconds(temporal_unit_name(smallest_rank))
                            .ok_or_else(|| {
                                self.catchable_range_error_msg("Temporal: invalid time unit".into())
                            })?
                            .checked_mul(increment)
                            .ok_or_else(|| {
                                self.catchable_range_error_msg(
                                    "Temporal: rounding increment out of range".into(),
                                )
                            })?;
                        let rounded = round_temporal(time_ns, quantum, &mode).ok_or_else(|| {
                            self.catchable_range_error_msg(
                                "Temporal: invalid rounding mode or result out of range".into(),
                            )
                        })?;
                        let t = duration_from_nanoseconds(rounded);
                        record.hours = t.hours;
                        record.minutes = t.minutes;
                        record.seconds = t.seconds;
                        record.milliseconds = t.milliseconds;
                        record.microseconds = t.microseconds;
                        record.nanoseconds = t.nanoseconds;
                    }
                    self.temporal_new_duration(record)
                }
            }
            7 => {
                // round(smallestUnit | options).
                let (smallest, _largest, increment, mode) =
                    self.temporal_zoned_round_options(arg0, code, None, "hour", "halfExpand")?;
                let unit_ns = temporal_unit_nanoseconds(&smallest).ok_or_else(|| {
                    self.catchable_range_error_msg("Temporal: invalid time unit".into())
                })?;
                let quantum = unit_ns.checked_mul(increment).ok_or_else(|| {
                    self.catchable_range_error_msg(
                        "Temporal: rounding increment out of range".into(),
                    )
                })?;
                // Fixed-offset day boundaries align to every sub-day quantum, so
                // rounding the local wall-time value is exact for all units.
                let local = old.epoch_nanoseconds + old.offset_ns as i128;
                let rounded_local = round_temporal(local, quantum, &mode).ok_or_else(|| {
                    self.catchable_range_error_msg(
                        "Temporal: invalid rounding mode or result out of range".into(),
                    )
                })?;
                let epoch = rounded_local - old.offset_ns as i128;
                self.temporal_new_zoned(epoch, old.time_zone, old.offset_ns)
            }
            8 => {
                let other = self.temporal_zoned_from(arg0, code)?;
                Ok(Slot::boolean(
                    old.epoch_nanoseconds == other.epoch_nanoseconds
                        && old.time_zone == other.time_zone,
                ))
            }
            9 => {
                // startOfDay: local midnight of the same calendar day.
                let local = old.epoch_nanoseconds + old.offset_ns as i128;
                let day_start = local.div_euclid(86_400_000_000_000) * 86_400_000_000_000;
                let epoch = day_start - old.offset_ns as i128;
                self.temporal_new_zoned(epoch, old.time_zone, old.offset_ns)
            }
            10 => {
                // getTimeZoneTransition(direction): a fixed offset never transitions.
                if arg0.kind == Kind::Undefined {
                    return Err(self.catchable_type_error_msg(
                        "Temporal.ZonedDateTime.getTimeZoneTransition: direction is required"
                            .into(),
                    ));
                }
                Ok(Slot::null())
            }
            11 => self.temporal_new_instant(old.epoch_nanoseconds),
            12 => {
                let p = zoned_local_datetime(old.epoch_nanoseconds, old.offset_ns);
                self.temporal_new_plain(TemporalPlainRecord {
                    kind: 0,
                    year: p.year,
                    month: p.month,
                    day: p.day,
                    ..Default::default()
                })
            }
            13 => {
                let p = zoned_local_datetime(old.epoch_nanoseconds, old.offset_ns);
                self.temporal_new_plain(TemporalPlainRecord {
                    kind: 1,
                    hour: p.hour,
                    minute: p.minute,
                    second: p.second,
                    millisecond: p.millisecond,
                    microsecond: p.microsecond,
                    nanosecond: p.nanosecond,
                    ..Default::default()
                })
            }
            14 => {
                let p = zoned_local_datetime(old.epoch_nanoseconds, old.offset_ns);
                self.temporal_new_plain(p)
            }
            15 => {
                // withPlainTime(plainTimeLike?): keep the date, replace the time.
                let mut p = zoned_local_datetime(old.epoch_nanoseconds, old.offset_ns);
                let t = if arg0.kind == Kind::Undefined {
                    TemporalPlainRecord {
                        kind: 1,
                        ..Default::default()
                    }
                } else {
                    self.temporal_plain_from(1, arg0, code)?
                };
                p.hour = t.hour;
                p.minute = t.minute;
                p.second = t.second;
                p.millisecond = t.millisecond;
                p.microsecond = t.microsecond;
                p.nanosecond = t.nanosecond;
                let epoch = local_datetime_to_epoch(&p, old.offset_ns).ok_or_else(|| {
                    self.catchable_range_error_msg(
                        "Temporal: date/time outside supported epoch range".into(),
                    )
                })?;
                self.temporal_new_zoned(epoch, old.time_zone, old.offset_ns)
            }
            16 => {
                // withTimeZone: same instant, different zone.
                let text = self.value_to_string(code, arg0)?;
                let (time_zone, offset_ns) = resolve_zoned_time_zone(&text).ok_or_else(|| {
                    self.catchable_range_error_msg(
                        "Temporal: invalid or unsupported time zone".into(),
                    )
                })?;
                self.temporal_new_zoned(old.epoch_nanoseconds, time_zone, offset_ns)
            }
            17 => {
                // withCalendar: only iso8601 is modeled.
                let id = self.value_to_string(code, arg0)?;
                if id.to_ascii_lowercase() != "iso8601" {
                    return Err(
                        self.catchable_range_error_msg("Temporal: unsupported calendar".into())
                    );
                }
                self.temporal_new_zoned(old.epoch_nanoseconds, old.time_zone, old.offset_ns)
            }
            18 | 19 => {
                // toString / toJSON.
                let s = if op == 18 {
                    self.temporal_zoned_to_string(&old, arg0, code)?
                } else {
                    format_zoned(&old, "auto", true, true)
                };
                Ok(self.new_string_metered(s.as_bytes()))
            }
            20 => Err(Step::Host(Halt::NotImplemented(
                "Temporal.ZonedDateTime.toLocaleString:needs-intl",
            ))),
            21 => Err(self.catchable_type_error_msg(
                "Temporal: valueOf cannot convert to a primitive".into(),
            )),
            _ => Err(Step::Host(Halt::NotImplemented(
                "Temporal.ZonedDateTime:method",
            ))),
        }
    }

    /// `toString(options)`: validate and apply the `calendarName`/`offset`/
    /// `timeZoneName` display toggles, then render.
    fn temporal_zoned_to_string(
        &mut self,
        rec: &TemporalZonedRecord,
        options: Slot,
        code: &[u8],
    ) -> Result<String, Step> {
        let mut calendar_name = "auto".to_string();
        let mut show_offset = true;
        let mut show_zone = true;
        if options.kind == Kind::Reference {
            if let Payload::Reference(r) = options.value {
                if let Some(cn) = self.intl_option_string(code, r, "calendarName")? {
                    if !matches!(cn.as_str(), "auto" | "always" | "never" | "critical") {
                        return Err(self.catchable_range_error_msg(
                            "Temporal.toString: invalid calendarName option".into(),
                        ));
                    }
                    calendar_name = cn;
                }
                if let Some(off) = self.intl_option_string(code, r, "offset")? {
                    match off.as_str() {
                        "auto" => {}
                        "never" => show_offset = false,
                        _ => {
                            return Err(self.catchable_range_error_msg(
                                "Temporal.toString: invalid offset option".into(),
                            ))
                        }
                    }
                }
                if let Some(tzn) = self.intl_option_string(code, r, "timeZoneName")? {
                    match tzn.as_str() {
                        "auto" | "critical" => {}
                        "never" => show_zone = false,
                        _ => {
                            return Err(self.catchable_range_error_msg(
                                "Temporal.toString: invalid timeZoneName option".into(),
                            ))
                        }
                    }
                }
            }
        } else if options.kind != Kind::Undefined {
            return Err(self.catchable_type_error_msg("Temporal: options must be an object".into()));
        }
        let show_cal = matches!(calendar_name.as_str(), "always" | "critical");
        Ok(format_zoned(
            rec,
            if show_cal { "always" } else { "auto" },
            show_offset,
            show_zone,
        ))
    }

    pub(in crate::interp) fn temporal_now_method(
        &mut self,
        op: u8,
        arg0: Slot,
        code: &[u8],
    ) -> Result<Slot, Step> {
        // Deterministic host clock: the Unix epoch, and the `UTC` system zone.
        const NOW_EPOCH_NS: i128 = 0;
        let zone_offset = |this: &mut Self, arg: Slot| -> Result<i64, Step> {
            if arg.kind == Kind::Undefined {
                return Ok(0);
            }
            let s = this.value_to_string(code, arg)?;
            resolve_zoned_time_zone(&s)
                .map(|(_, off)| off)
                .ok_or_else(|| {
                    this.catchable_range_error_msg(
                        "Temporal: invalid or unsupported time zone".into(),
                    )
                })
        };
        match op {
            0 => self.temporal_new_instant(NOW_EPOCH_NS),
            1 => Ok(self.new_string_metered(b"UTC")),
            2 => {
                let (time_zone, offset_ns) = if arg0.kind == Kind::Undefined {
                    ("UTC".to_string(), 0)
                } else {
                    let s = self.value_to_string(code, arg0)?;
                    resolve_zoned_time_zone(&s).ok_or_else(|| {
                        self.catchable_range_error_msg(
                            "Temporal: invalid or unsupported time zone".into(),
                        )
                    })?
                };
                self.temporal_new_zoned(NOW_EPOCH_NS, time_zone, offset_ns)
            }
            3 => {
                let off = zone_offset(self, arg0)?;
                let p = zoned_local_datetime(NOW_EPOCH_NS, off);
                self.temporal_new_plain(TemporalPlainRecord {
                    kind: 0,
                    year: p.year,
                    month: p.month,
                    day: p.day,
                    ..Default::default()
                })
            }
            4 => {
                let off = zone_offset(self, arg0)?;
                self.temporal_new_plain(zoned_local_datetime(NOW_EPOCH_NS, off))
            }
            5 => {
                let off = zone_offset(self, arg0)?;
                let p = zoned_local_datetime(NOW_EPOCH_NS, off);
                self.temporal_new_plain(TemporalPlainRecord {
                    kind: 1,
                    hour: p.hour,
                    minute: p.minute,
                    second: p.second,
                    millisecond: p.millisecond,
                    microsecond: p.microsecond,
                    nanosecond: p.nanosecond,
                    ..Default::default()
                })
            }
            _ => Err(Step::Host(Halt::NotImplemented("Temporal.Now:method"))),
        }
    }
}
