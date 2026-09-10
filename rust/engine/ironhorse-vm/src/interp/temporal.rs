//! Temporal records, ISO calendar arithmetic, duration rounding, and text conversion.

use crate::value::{Kind, Payload, Slot};

/// Records backing branded Temporal values. Their fields live outside the
/// ordinary-property store, so guest properties cannot replace internal state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct TemporalInstantRecord {
    pub(super) epoch_nanoseconds: i128,
}

pub(super) const TEMPORAL_PLAIN_NAMES: [&str; 6] = [
    "PlainDate",
    "PlainTime",
    "PlainDateTime",
    "PlainYearMonth",
    "PlainMonthDay",
    "Calendar",
];

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct TemporalDurationRecord {
    pub(super) years: i64,
    pub(super) months: i64,
    pub(super) weeks: i64,
    pub(super) days: i64,
    pub(super) hours: i64,
    pub(super) minutes: i64,
    pub(super) seconds: i64,
    pub(super) milliseconds: i64,
    pub(super) microseconds: i64,
    pub(super) nanoseconds: i64,
}

/// ISO-8601 fields shared by PlainDate, PlainTime, PlainDateTime,
/// PlainYearMonth, and PlainMonthDay.  `kind` identifies which fields are
/// observable.  Calendar instances use kind 5 and otherwise-zero fields.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct TemporalPlainRecord {
    pub(super) kind: u8,
    pub(super) year: i64,
    pub(super) month: u32,
    pub(super) day: u32,
    pub(super) hour: u32,
    pub(super) minute: u32,
    pub(super) second: u32,
    pub(super) millisecond: u32,
    pub(super) microsecond: u32,
    pub(super) nanosecond: u32,
}

/// A `Temporal.ZonedDateTime`: an exact instant (`epoch_nanoseconds`) paired
/// with a resolved time zone. The time-zone model is **fixed-offset** (shared with `Intl.DateTimeFormat`, see [`resolve_time_zone`]):
/// UTC and its aliases, numeric `±HH:MM[:SS]` offsets, the `Etc/GMT±N` zones, and
/// a table of common IANA names carried at their standard offset.  A fixed offset
/// has no DST transitions, so disambiguation never triggers, `hoursInDay` is
/// always 24, and `getTimeZoneTransition` is always `null` — each of which is the
/// correct answer for an offset zone.  Only `iso8601` is modeled for the calendar.
/// Not `Copy` because the time-zone identifier is an owned string.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct TemporalZonedRecord {
    pub(super) epoch_nanoseconds: i128,
    /// The canonical time-zone identifier `timeZoneId` renders (`"UTC"`,
    /// `"+05:30"`, `"America/New_York"`, …).
    pub(super) time_zone: String,
    /// The zone's fixed offset, nanoseconds east of UTC.
    pub(super) offset_ns: i64,
}

impl TemporalDurationRecord {
    pub(super) fn fields(self) -> [i64; 10] {
        [
            self.years,
            self.months,
            self.weeks,
            self.days,
            self.hours,
            self.minutes,
            self.seconds,
            self.milliseconds,
            self.microseconds,
            self.nanoseconds,
        ]
    }

    pub(super) fn sign(self) -> i64 {
        self.fields()
            .into_iter()
            .find(|&v| v != 0)
            .map(i64::signum)
            .unwrap_or(0)
    }

    pub(super) fn negated(self) -> Option<Self> {
        let mut f = self.fields();
        for v in &mut f {
            *v = v.checked_neg()?;
        }
        Some(Self::from_fields(f))
    }

    pub(super) fn from_fields(f: [i64; 10]) -> Self {
        Self {
            years: f[0],
            months: f[1],
            weeks: f[2],
            days: f[3],
            hours: f[4],
            minutes: f[5],
            seconds: f[6],
            milliseconds: f[7],
            microseconds: f[8],
            nanoseconds: f[9],
        }
    }

    pub(super) fn time_nanoseconds(self, allow_days: bool) -> Option<i128> {
        if self.years != 0 || self.months != 0 || self.weeks != 0 || (!allow_days && self.days != 0)
        {
            return None;
        }
        let mut n = if allow_days {
            self.days as i128 * 86_400
        } else {
            0
        };
        n = n.checked_add(self.hours as i128 * 3_600)?;
        n = n.checked_add(self.minutes as i128 * 60)?;
        n = n.checked_add(self.seconds as i128)?;
        n = n.checked_mul(1_000_000_000)?;
        n = n.checked_add(self.milliseconds as i128 * 1_000_000)?;
        n = n.checked_add(self.microseconds as i128 * 1_000)?;
        n.checked_add(self.nanoseconds as i128)
    }

    /// The pure time part (`hours`…`nanoseconds`) as a single nanosecond count,
    /// ignoring the calendar/day fields entirely. Unlike [`time_nanoseconds`]
    /// this never rejects a duration that also carries date units — the caller
    /// handles those through calendar arithmetic against a `relativeTo` date.
    pub(super) fn time_only_nanoseconds(self) -> Option<i128> {
        let mut n = (self.hours as i128).checked_mul(3_600)?;
        n = n.checked_add(self.minutes as i128 * 60)?;
        n = n.checked_add(self.seconds as i128)?;
        n = n.checked_mul(1_000_000_000)?;
        n = n.checked_add(self.milliseconds as i128 * 1_000_000)?;
        n = n.checked_add(self.microseconds as i128 * 1_000)?;
        n.checked_add(self.nanoseconds as i128)
    }

    /// Does this duration carry any calendar (non-fixed-length) unit? Years,
    /// months, and weeks are the units that cannot be resolved to an exact
    /// nanosecond span without a `relativeTo` reference point.
    pub(super) fn has_calendar_units(self) -> bool {
        self.years != 0 || self.months != 0 || self.weeks != 0
    }
}

pub(super) fn temporal_plain_valid(r: TemporalPlainRecord) -> bool {
    if r.kind >= 6 {
        return false;
    }
    if r.kind == 5 {
        return true;
    }
    if matches!(r.kind, 0 | 2 | 3 | 4) && days_from_civil(r.year, r.month, r.day).is_none() {
        return false;
    }
    if matches!(r.kind, 1 | 2)
        && (r.hour > 23
            || r.minute > 59
            || r.second > 59
            || r.millisecond > 999
            || r.microsecond > 999
            || r.nanosecond > 999)
    {
        return false;
    }
    true
}

pub(super) fn parse_temporal_plain(kind: u8, text: &str) -> Option<TemporalPlainRecord> {
    let text = text.split('[').next()?;
    if kind == 5 {
        return (text == "iso8601").then_some(TemporalPlainRecord {
            kind,
            ..Default::default()
        });
    }
    let (date, time) = match text.find(['T', 't']) {
        Some(at) => (&text[..at], Some(&text[at + 1..])),
        None if kind == 1 => ("", Some(text)),
        None => (text, None),
    };
    let mut r = TemporalPlainRecord {
        kind,
        year: if kind == 4 { 1972 } else { 0 },
        day: if kind == 3 { 1 } else { 0 },
        ..Default::default()
    };
    if matches!(kind, 0 | 2 | 3 | 4) {
        let basic = !date.is_empty() && date.bytes().all(|b| b.is_ascii_digit());
        if basic && matches!(kind, 0 | 2) && date.len() == 8 {
            // ISO 8601 basic-format calendar date `YYYYMMDD`.
            r.year = date[0..4].parse().ok()?;
            r.month = date[4..6].parse().ok()?;
            r.day = date[6..8].parse().ok()?;
        } else if basic && kind == 3 && date.len() == 6 {
            // Basic-format year-month `YYYYMM`.
            r.year = date[0..4].parse().ok()?;
            r.month = date[4..6].parse().ok()?;
        } else if kind == 4 && date.matches('-').count() == 1 {
            let mut p = date.trim_start_matches('-').split('-');
            r.month = p.next()?.parse().ok()?;
            r.day = p.next()?.parse().ok()?;
            if p.next().is_some() {
                return None;
            }
        } else {
            let mut p = date.rsplitn(3, '-');
            if kind == 3 {
                r.month = p.next()?.parse().ok()?;
                r.year = p.next()?.parse().ok()?;
            } else {
                r.day = p.next()?.parse().ok()?;
                r.month = p.next()?.parse().ok()?;
                r.year = p.next()?.parse().ok()?;
            }
        }
    }
    if matches!(kind, 1 | 2) {
        let mut p = time?.split(':');
        r.hour = p.next()?.parse().ok()?;
        r.minute = p.next().unwrap_or("0").parse().ok()?;
        let sec = p.next().unwrap_or("0");
        if p.next().is_some() {
            return None;
        }
        let (whole, frac) = sec.split_once('.').unwrap_or((sec, ""));
        r.second = whole.parse().ok()?;
        if frac.len() > 9 || !frac.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let f = format!("{frac:0<9}");
        if !frac.is_empty() {
            let n: u32 = f.parse().ok()?;
            r.millisecond = n / 1_000_000;
            r.microsecond = (n / 1_000) % 1_000;
            r.nanosecond = n % 1_000;
        }
    }
    temporal_plain_valid(r).then_some(r)
}

pub(super) fn temporal_plain_key(
    r: TemporalPlainRecord,
) -> (i64, u32, u32, u32, u32, u32, u32, u32, u32) {
    (
        r.year,
        r.month,
        r.day,
        r.hour,
        r.minute,
        r.second,
        r.millisecond,
        r.microsecond,
        r.nanosecond,
    )
}

fn temporal_plain_time_ns(r: TemporalPlainRecord) -> i128 {
    (((((r.hour as i128 * 60 + r.minute as i128) * 60 + r.second as i128) * 1000
        + r.millisecond as i128)
        * 1000
        + r.microsecond as i128)
        * 1000)
        + r.nanosecond as i128
}

pub(super) fn temporal_plain_add(
    mut r: TemporalPlainRecord,
    d: TemporalDurationRecord,
) -> Option<TemporalPlainRecord> {
    if r.kind == 5 {
        return None;
    }
    if matches!(r.kind, 0 | 2 | 3 | 4) {
        let mut year = r.year.checked_add(d.years)?;
        let month0 = (r.month as i64 - 1).checked_add(d.months)?;
        year = year.checked_add(month0.div_euclid(12))?;
        r.month = (month0.rem_euclid(12) + 1) as u32;
        let max_day = (1..=31)
            .rev()
            .find(|&day| days_from_civil(year, r.month, day).is_some())?;
        r.day = r.day.min(max_day);
        r.year = year;
        let base = days_from_civil(r.year, r.month, r.day)?;
        let days = base
            .checked_add((d.weeks as i128).checked_mul(7)?)?
            .checked_add(d.days as i128)?;
        (r.year, r.month, r.day) = civil_from_days(days);
    } else if d.years != 0 || d.months != 0 || d.weeks != 0 || d.days != 0 {
        return None;
    }
    if matches!(r.kind, 1 | 2) {
        let delta = d.time_nanoseconds(false)?;
        let total = temporal_plain_time_ns(r).checked_add(delta)?;
        let carry = total.div_euclid(86_400_000_000_000);
        let n = total.rem_euclid(86_400_000_000_000);
        if r.kind == 2 && carry != 0 {
            let day = days_from_civil(r.year, r.month, r.day)?.checked_add(carry)?;
            (r.year, r.month, r.day) = civil_from_days(day);
        }
        r.hour = (n / 3_600_000_000_000) as u32;
        r.minute = ((n / 60_000_000_000) % 60) as u32;
        r.second = ((n / 1_000_000_000) % 60) as u32;
        r.millisecond = ((n / 1_000_000) % 1000) as u32;
        r.microsecond = ((n / 1000) % 1000) as u32;
        r.nanosecond = (n % 1000) as u32;
    } else if d.hours != 0
        || d.minutes != 0
        || d.seconds != 0
        || d.milliseconds != 0
        || d.microseconds != 0
        || d.nanoseconds != 0
    {
        return None;
    }
    temporal_plain_valid(r).then_some(r)
}

pub(super) fn temporal_plain_difference(
    a: TemporalPlainRecord,
    b: TemporalPlainRecord,
) -> Option<TemporalDurationRecord> {
    if a.kind != b.kind {
        return None;
    }
    match a.kind {
        0 => Some(TemporalDurationRecord {
            days: i64::try_from(
                days_from_civil(b.year, b.month, b.day)? - days_from_civil(a.year, a.month, a.day)?,
            )
            .ok()?,
            ..Default::default()
        }),
        1 => Some(duration_from_nanoseconds(
            temporal_plain_time_ns(b) - temporal_plain_time_ns(a),
        )),
        2 => {
            let days =
                days_from_civil(b.year, b.month, b.day)? - days_from_civil(a.year, a.month, a.day)?;
            Some(duration_from_nanoseconds(
                days * 86_400_000_000_000 + temporal_plain_time_ns(b) - temporal_plain_time_ns(a),
            ))
        }
        3 => Some(TemporalDurationRecord {
            months: (b.year - a.year)
                .checked_mul(12)?
                .checked_add(b.month as i64 - a.month as i64)?,
            ..Default::default()
        }),
        _ => None,
    }
}

/// A bare ISO `PlainDate` record (`kind == 0`) at the given civil date.
pub(super) fn iso_date(year: i64, month: u32, day: u32) -> TemporalPlainRecord {
    TemporalPlainRecord {
        kind: 0,
        year,
        month,
        day,
        ..Default::default()
    }
}

/// ISO-calendar `dateAdd`: `start`'s date advanced by `(years, months, weeks,
/// days)` with the day clamped to the target month's length (the ISO
/// `overflow: "constrain"` default). Operates on the date fields only.
pub(super) fn iso_date_add(
    start: TemporalPlainRecord,
    years: i64,
    months: i64,
    weeks: i64,
    days: i64,
) -> Option<TemporalPlainRecord> {
    temporal_plain_add(
        iso_date(start.year, start.month, start.day),
        TemporalDurationRecord {
            years,
            months,
            weeks,
            days,
            ..Default::default()
        },
    )
}

/// The signed civil-day offset from `start`'s date to `end`'s date.
fn iso_days_between(start: TemporalPlainRecord, end: TemporalPlainRecord) -> Option<i128> {
    Some(
        days_from_civil(end.year, end.month, end.day)?
            - days_from_civil(start.year, start.month, start.day)?,
    )
}

/// The ISO-calendar `dateUntil`: the difference between two ISO dates expressed
/// as `(years, months, weeks, days)` bounded by `largest` (`"year"`, `"month"`,
/// `"week"`, or `"day"`). The result carries the sign of `end - start`. Whole
/// years/months are counted by `dateAdd` from `start` so day-clamping matches
/// the constructive Temporal semantics (e.g. Jan 31 + 1 month = Feb 28).
pub(super) fn iso_date_until(
    start: TemporalPlainRecord,
    end: TemporalPlainRecord,
    largest: &str,
) -> Option<TemporalDurationRecord> {
    let total_days = iso_days_between(start, end)?;
    match largest {
        "day" => Some(TemporalDurationRecord {
            days: i64::try_from(total_days).ok()?,
            ..Default::default()
        }),
        "week" => {
            let weeks = total_days / 7;
            let days = total_days % 7;
            Some(TemporalDurationRecord {
                weeks: i64::try_from(weeks).ok()?,
                days: i64::try_from(days).ok()?,
                ..Default::default()
            })
        }
        "year" | "month" => {
            if total_days == 0 {
                return Some(TemporalDurationRecord::default());
            }
            let end_days = days_from_civil(end.year, end.month, end.day)?;
            let sign: i64 = if total_days > 0 { 1 } else { -1 };
            // How does `cand` compare to `end`, in units of `sign`? Positive
            // means `cand` has overshot `end` in the travel direction.
            let overshoot = |cand: TemporalPlainRecord| -> Option<i64> {
                let cmp = days_from_civil(cand.year, cand.month, cand.day)?.cmp(&end_days) as i64;
                Some(cmp * sign)
            };
            // Whole years: the largest count (in the sign direction) whose
            // dateAdd from `start` has not passed `end`.
            let mut years = end.year - start.year;
            while overshoot(iso_date_add(start, years, 0, 0, 0)?)? > 0 {
                years -= sign;
            }
            while overshoot(iso_date_add(start, years + sign, 0, 0, 0)?)? <= 0 {
                years += sign;
            }
            // Whole months from `start + years`.
            let mut months = 0i64;
            while overshoot(iso_date_add(start, years, months + sign, 0, 0)?)? <= 0 {
                months += sign;
            }
            let mid = iso_date_add(start, years, months, 0, 0)?;
            let days = i64::try_from(iso_days_between(mid, end)?).ok()?;
            if largest == "month" {
                let months = years.checked_mul(12)?.checked_add(months)?;
                Some(TemporalDurationRecord {
                    months,
                    days,
                    ..Default::default()
                })
            } else {
                Some(TemporalDurationRecord {
                    years,
                    months,
                    days,
                    ..Default::default()
                })
            }
        }
        _ => None,
    }
}

/// `DifferenceISODateTime`: the calendar-aware difference between two wall-clock
/// ISO datetimes (`kind == 2`), bounded by `largest`. The time part is balanced
/// into `hours`…`nanoseconds`; a day is borrowed toward `end` when the
/// time-of-day difference opposes the date-of-month difference so the result
/// carries a single sign. Correct for the fixed-offset (constant 24-hour-day)
/// model, where the wall clock and the exact instant advance together.
pub(super) fn iso_datetime_difference(
    start: TemporalPlainRecord,
    end: TemporalPlainRecord,
    largest: &str,
) -> Option<TemporalDurationRecord> {
    const DAY_NS: i128 = 86_400_000_000_000;
    let mut time_diff = temporal_plain_time_ns(end) - temporal_plain_time_ns(start);
    let start_date = iso_date(start.year, start.month, start.day);
    let end_date = iso_date(end.year, end.month, end.day);
    let date_sign = iso_days_between(start_date, end_date)?.signum() as i64;
    let time_sign = time_diff.signum() as i64;
    let mut adjusted_start = start_date;
    if date_sign != 0 && time_sign != 0 && time_sign == -date_sign {
        // The time-of-day runs opposite the date direction: borrow one day
        // toward `end` so the residual time part shares the date's sign.
        adjusted_start = iso_date_add(start_date, 0, 0, 0, date_sign)?;
        time_diff += (date_sign as i128) * DAY_NS;
    }
    let mut record = iso_date_until(adjusted_start, end_date, largest)?;
    let time = duration_from_nanoseconds(time_diff);
    record.hours = time.hours;
    record.minutes = time.minutes;
    record.seconds = time.seconds;
    record.milliseconds = time.milliseconds;
    record.microseconds = time.microseconds;
    record.nanoseconds = time.nanoseconds;
    Some(record)
}

/// The exact nanosecond span from `start`'s date to `start + duration`, in the
/// constant-24-hour-day ISO model: the date part advances the calendar date
/// (day-clamped) and the time part is a plain nanosecond addend. `None` on
/// calendar overflow. The time-of-day of `start` is irrelevant to a duration in
/// this model, so only its date matters.
pub(super) fn iso_duration_span_nanoseconds(
    start: TemporalPlainRecord,
    d: TemporalDurationRecord,
) -> Option<i128> {
    const DAY_NS: i128 = 86_400_000_000_000;
    // The ISO datetime limit: `nsMaxInstant` (±10^8 days) plus a one-day margin.
    // A `start + duration` endpoint beyond it is a `RangeError` — and bounds the
    // span so the calendar-unit total loop can never run away.
    const LIMIT_NS: i128 = 8_640_000_000_000_000_000_000 + DAY_NS;
    let end = iso_date_add(start, d.years, d.months, d.weeks, d.days)?;
    let time = d.time_only_nanoseconds()?;
    let end_epoch = days_from_civil(end.year, end.month, end.day)?
        .checked_mul(DAY_NS)?
        .checked_add(time)?;
    if end_epoch.abs() > LIMIT_NS {
        return None;
    }
    let date_ns = iso_days_between(start, end)?.checked_mul(DAY_NS)?;
    date_ns.checked_add(time)
}

/// The fractional count of `unit` (`"year"` or `"month"`) that a nanosecond
/// span `span_ns` measured from `start` represents. Whole units are stepped by
/// `dateAdd`; the residual is a linear fraction of the unit that contains the
/// endpoint. Matches the Temporal `total` semantics for calendar units under
/// the constant-24-hour-day model.
pub(super) fn iso_total_calendar_units(
    start: TemporalPlainRecord,
    span_ns: i128,
    unit: &str,
) -> Option<f64> {
    const DAY_NS: i128 = 86_400_000_000_000;
    let sign: i64 = match span_ns.cmp(&0) {
        std::cmp::Ordering::Greater => 1,
        std::cmp::Ordering::Less => -1,
        std::cmp::Ordering::Equal => return Some(0.0),
    };
    let boundary = |k: i64| -> Option<i128> {
        let d = match unit {
            "year" => iso_date_add(start, k, 0, 0, 0)?,
            "month" => iso_date_add(start, 0, k, 0, 0)?,
            _ => return None,
        };
        Some(iso_days_between(start, d)?.checked_mul(DAY_NS)?)
    };
    // Seed `k` near the answer so the adjustment loops are O(1) rather than
    // stepping one unit at a time across a span that can be ~10^8 days.
    let avg_unit_days = if unit == "year" { 365.2425 } else { 30.436875 };
    let mut k = (span_ns as f64 / (avg_unit_days * DAY_NS as f64)) as i64;
    while (sign as i128) * (span_ns - boundary(k)?) < 0 {
        k -= sign;
    }
    while (sign as i128) * (span_ns - boundary(k + sign)?) >= 0 {
        k += sign;
    }
    let lower = boundary(k)?;
    let upper = boundary(k + sign)?;
    let denom = upper - lower;
    if denom == 0 {
        return Some(k as f64);
    }
    let frac = (span_ns - lower) as f64 / denom as f64;
    Some(k as f64 + sign as f64 * frac)
}

pub(super) fn format_temporal_plain(r: TemporalPlainRecord) -> String {
    if r.kind == 5 {
        return "iso8601".to_string();
    }
    let y = if (0..=9999).contains(&r.year) {
        format!("{:04}", r.year)
    } else {
        format!("{:+07}", r.year)
    };
    let date = match r.kind {
        3 => format!("{y}-{:02}", r.month),
        4 => format!("{:02}-{:02}", r.month, r.day),
        _ => format!("{y}-{:02}-{:02}", r.month, r.day),
    };
    if !matches!(r.kind, 1 | 2) {
        return date;
    }
    let fraction = r.millisecond * 1_000_000 + r.microsecond * 1_000 + r.nanosecond;
    let time = if fraction == 0 {
        format!("{:02}:{:02}:{:02}", r.hour, r.minute, r.second)
    } else {
        format!(
            "{:02}:{:02}:{:02}.{}",
            r.hour,
            r.minute,
            r.second,
            format!("{fraction:09}").trim_end_matches('0')
        )
    };
    if r.kind == 1 {
        time
    } else {
        format!("{date}T{time}")
    }
}

pub(super) fn temporal_brand<T: Copy>(
    value: Slot,
    records: &std::collections::HashMap<crate::value::SlotIndex, T>,
) -> Option<T> {
    match value.value {
        Payload::Reference(r) if value.kind == Kind::Reference => records.get(&r).copied(),
        _ => None,
    }
}

pub(super) fn temporal_duration_sign_valid(record: TemporalDurationRecord) -> bool {
    let sign = record.sign();
    sign == 0
        || record
            .fields()
            .into_iter()
            .all(|v| v == 0 || v.signum() == sign)
}

pub(super) fn temporal_unit_nanoseconds(unit: &str) -> Option<i128> {
    Some(match unit.trim_end_matches('s') {
        "day" => 86_400_000_000_000,
        "hour" => 3_600_000_000_000,
        "minute" => 60_000_000_000,
        "second" => 1_000_000_000,
        "millisecond" => 1_000_000,
        "microsecond" => 1_000,
        "nanosecond" => 1,
        _ => return None,
    })
}

/// The coarse-to-fine rank of a Temporal duration unit (`year` = 0 … `nanosecond`
/// = 9), accepting the singular or plural spelling. A *larger* unit has a
/// *smaller* rank. `None` for an unrecognized unit.
pub(super) fn temporal_unit_rank(unit: &str) -> Option<u8> {
    Some(match unit.trim_end_matches('s') {
        "year" => 0,
        "month" => 1,
        "week" => 2,
        "day" => 3,
        "hour" => 4,
        "minute" => 5,
        "second" => 6,
        "millisecond" => 7,
        "microsecond" => 8,
        "nanosecond" => 9,
        _ => return None,
    })
}

/// The canonical singular unit name for a rank produced by [`temporal_unit_rank`].
pub(super) fn temporal_unit_name(rank: u8) -> &'static str {
    [
        "year",
        "month",
        "week",
        "day",
        "hour",
        "minute",
        "second",
        "millisecond",
        "microsecond",
        "nanosecond",
    ][rank as usize]
}

/// The rank of a duration's largest *present* (non-zero) unit — the `"auto"`
/// `largestUnit` default. An all-zero duration defaults to `nanosecond`.
pub(super) fn temporal_duration_default_largest_rank(d: TemporalDurationRecord) -> u8 {
    d.fields()
        .iter()
        .position(|&v| v != 0)
        .map(|i| i as u8)
        .unwrap_or(9)
}

/// `ValidateTemporalRoundingIncrement` for a duration unit: sub-day units carry
/// a maximum the increment must divide and stay strictly below (`hour` → 24,
/// `minute`/`second` → 60, sub-second → 1000); `day` and coarser units have no
/// maximum. `None` signals a `RangeError`.
pub(super) fn validate_duration_increment(rank: u8, increment: i64) -> Option<()> {
    let max: i64 = match rank {
        4 => 24,
        5 | 6 => 60,
        7 | 8 | 9 => 1000,
        _ => return Some(()),
    };
    if increment >= max || max % increment != 0 {
        None
    } else {
        Some(())
    }
}

/// Round a real `value` to the nearest multiple of `increment` under `mode`,
/// returning the integer multiplier. Sign-aware for the directed modes; the
/// duration `round` calendar path exercises non-negative values, so the
/// half-tie resolution follows the same table as [`round_temporal`].
pub(super) fn round_number_to_increment(value: f64, increment: i64, mode: &str) -> f64 {
    let inc = increment as f64;
    let quotient = value / inc;
    let floor = quotient.floor();
    let ceil = quotient.ceil();
    if floor == ceil {
        return floor * inc;
    }
    let frac = quotient - floor; // in (0, 1)
    let chosen = match mode {
        "ceil" => ceil,
        "floor" => floor,
        "trunc" => {
            if quotient >= 0.0 {
                floor
            } else {
                ceil
            }
        }
        "expand" => {
            if quotient >= 0.0 {
                ceil
            } else {
                floor
            }
        }
        _ => {
            if frac < 0.5 {
                floor
            } else if frac > 0.5 {
                ceil
            } else {
                match mode {
                    "halfFloor" => floor,
                    "halfCeil" => ceil,
                    "halfTrunc" => {
                        if quotient >= 0.0 {
                            floor
                        } else {
                            ceil
                        }
                    }
                    "halfEven" => {
                        if (floor as i64).rem_euclid(2) == 0 {
                            floor
                        } else {
                            ceil
                        }
                    }
                    _ => {
                        if quotient >= 0.0 {
                            ceil
                        } else {
                            floor
                        }
                    } // halfExpand
                }
            }
        }
    };
    chosen * inc
}

pub(super) fn round_half_expand(value: i128, quantum: i128) -> i128 {
    let q = value / quantum;
    let r = value % quantum;
    if r.unsigned_abs() * 2 >= quantum as u128 {
        (q + value.signum()) * quantum
    } else {
        q * quantum
    }
}

pub(super) fn duration_from_nanoseconds(value: i128) -> TemporalDurationRecord {
    let sign = value.signum();
    let mut n = value.unsigned_abs();
    let hours = (n / 3_600_000_000_000) as i64 * sign as i64;
    n %= 3_600_000_000_000;
    let minutes = (n / 60_000_000_000) as i64 * sign as i64;
    n %= 60_000_000_000;
    let seconds = (n / 1_000_000_000) as i64 * sign as i64;
    n %= 1_000_000_000;
    let milliseconds = (n / 1_000_000) as i64 * sign as i64;
    n %= 1_000_000;
    let microseconds = (n / 1_000) as i64 * sign as i64;
    let nanoseconds = (n % 1_000) as i64 * sign as i64;
    TemporalDurationRecord {
        hours,
        minutes,
        seconds,
        milliseconds,
        microseconds,
        nanoseconds,
        ..Default::default()
    }
}

pub(super) fn parse_temporal_duration(text: &str) -> Option<TemporalDurationRecord> {
    let (sign, text) = if let Some(s) = text.strip_prefix('-') {
        (-1i64, s)
    } else if let Some(s) = text.strip_prefix('+') {
        (1, s)
    } else {
        (1, text)
    };
    let mut rest = text.strip_prefix('P')?;
    if rest.is_empty() {
        return None;
    }
    let mut out = TemporalDurationRecord::default();
    let mut time = false;
    let mut saw = false;
    while !rest.is_empty() {
        if let Some(r) = rest.strip_prefix('T') {
            if time {
                return None;
            }
            time = true;
            rest = r;
            continue;
        }
        let end = rest.find(|c: char| !(c.is_ascii_digit() || c == '.'))?;
        if end == 0 {
            return None;
        }
        let number = &rest[..end];
        let designator = rest[end..].chars().next()?;
        rest = &rest[end + designator.len_utf8()..];
        saw = true;
        if number.contains('.') {
            if designator != 'S' || !time {
                return None;
            }
            let (whole, frac) = number.split_once('.')?;
            let seconds: i64 = whole.parse().ok()?;
            if frac.is_empty() || frac.len() > 9 || !frac.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            let fraction: i64 = format!("{frac:0<9}").parse().ok()?;
            out.seconds = sign.checked_mul(seconds)?;
            out.milliseconds = sign.checked_mul(fraction / 1_000_000)?;
            out.microseconds = sign.checked_mul((fraction / 1_000) % 1_000)?;
            out.nanoseconds = sign.checked_mul(fraction % 1_000)?;
            continue;
        }
        let v = sign.checked_mul(number.parse::<i64>().ok()?)?;
        match (time, designator) {
            (false, 'Y') => out.years = v,
            (false, 'M') => out.months = v,
            (false, 'W') => out.weeks = v,
            (false, 'D') => out.days = v,
            (true, 'H') => out.hours = v,
            (true, 'M') => out.minutes = v,
            (true, 'S') => out.seconds = v,
            _ => return None,
        }
    }
    saw.then_some(out)
}

pub(super) fn format_temporal_duration(d: TemporalDurationRecord) -> String {
    if d.sign() == 0 {
        return "PT0S".to_string();
    }
    let sign = if d.sign() < 0 { "-" } else { "" };
    let f = d.fields().map(i64::unsigned_abs);
    let mut s = format!("{sign}P");
    for (v, mark) in [(f[0], "Y"), (f[1], "M"), (f[2], "W"), (f[3], "D")] {
        if v != 0 {
            s.push_str(&format!("{v}{mark}"));
        }
    }
    if f[4..].iter().any(|&v| v != 0) {
        s.push('T');
        if f[4] != 0 {
            s.push_str(&format!("{}H", f[4]));
        }
        if f[5] != 0 {
            s.push_str(&format!("{}M", f[5]));
        }
        let fraction = f[7] * 1_000_000 + f[8] * 1_000 + f[9];
        if f[6] != 0 || fraction != 0 {
            if fraction == 0 {
                s.push_str(&format!("{}S", f[6]));
            } else {
                let digits = format!("{fraction:09}");
                s.push_str(&format!("{}.{}S", f[6], digits.trim_end_matches('0')));
            }
        }
    }
    s
}

pub(super) fn days_from_civil(year: i64, month: u32, day: u32) -> Option<i128> {
    let leap = year.rem_euclid(4) == 0 && (year.rem_euclid(100) != 0 || year.rem_euclid(400) == 0);
    let month_days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return None,
    };
    if day == 0 || day > month_days {
        return None;
    }
    // Use i128 throughout: Date accepts finite components up to the Number
    // range, and the i64 boundary values admitted above must become an invalid
    // TimeClip result rather than overflowing debug arithmetic here.
    let y = i128::from(year) - i128::from(month <= 2);
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = i128::from(month) + if month > 2 { -3 } else { 9 };
    let doy = (153 * mp + 2) / 5 + i128::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146097 + doe - 719468)
}

pub(super) fn civil_from_days(days: i128) -> (i64, u32, u32) {
    let z = days as i64 + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    y += i64::from(m <= 2);
    (y, m as u32, d as u32)
}

pub(super) fn parse_temporal_instant(text: &str) -> Option<i128> {
    if text.starts_with("-000000-") {
        return None;
    }
    let t = text.find(['T', 't'])?;
    let (date, mut time) = text.split_at(t);
    time = &time[1..];
    let mut dp = date.rsplitn(3, '-');
    let day: u32 = dp.next()?.parse().ok()?;
    let month: u32 = dp.next()?.parse().ok()?;
    let year_text = dp.next()?;
    let year: i64 = year_text.parse().ok()?;
    let zone_at = time.rfind(['Z', 'z', '+', '-'])?;
    let (clock, zone) = time.split_at(zone_at);
    let mut cp = clock.split(':');
    let hour: i128 = cp.next()?.parse().ok()?;
    let minute: i128 = cp.next()?.parse().ok()?;
    let second_text = cp.next()?;
    if cp.next().is_some() || hour > 23 || minute > 59 {
        return None;
    }
    let (second, fraction) = second_text.split_once('.').unwrap_or((second_text, ""));
    let second: i128 = second.parse().ok()?;
    if second > 59 {
        return None;
    }
    if fraction.len() > 9 || !fraction.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let frac: i128 = if fraction.is_empty() {
        0
    } else {
        format!("{fraction:0<9}").parse().ok()?
    };
    let offset_seconds: i128 = if zone.eq_ignore_ascii_case("z") {
        0
    } else {
        let sign = if zone.starts_with('-') {
            -1
        } else if zone.starts_with('+') {
            1
        } else {
            return None;
        };
        let mut zp = zone[1..].split(':');
        let zh: i128 = zp.next()?.parse().ok()?;
        let zm: i128 = zp.next().unwrap_or("0").parse().ok()?;
        if zh > 23 || zm > 59 || zp.next().is_some() {
            return None;
        }
        sign * (zh * 3600 + zm * 60)
    };
    let days = days_from_civil(year, month, day)?;
    Some(
        ((days * 86_400 + hour * 3600 + minute * 60 + second - offset_seconds) * 1_000_000_000)
            + frac,
    )
}

pub(super) fn format_temporal_instant(ns: i128) -> String {
    let seconds = ns.div_euclid(1_000_000_000);
    let fraction = ns.rem_euclid(1_000_000_000);
    let days = seconds.div_euclid(86_400);
    let sod = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = sod / 3600;
    let minute = (sod % 3600) / 60;
    let second = sod % 60;
    let y = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        format!("{year:+07}")
    };
    if fraction == 0 {
        format!("{y}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
    } else {
        format!(
            "{y}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{}Z",
            format!("{fraction:09}").trim_end_matches('0')
        )
    }
}

/// The wall-clock ISO PlainDateTime (`kind == 2`) an instant shows in a zone with
/// the given fixed `offset_ns`.
pub(super) fn zoned_local_datetime(epoch_ns: i128, offset_ns: i64) -> TemporalPlainRecord {
    let local = epoch_ns + offset_ns as i128;
    let seconds = local.div_euclid(1_000_000_000);
    let fraction = local.rem_euclid(1_000_000_000);
    let days = seconds.div_euclid(86_400);
    let sod = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    TemporalPlainRecord {
        kind: 2,
        year,
        month,
        day,
        hour: (sod / 3600) as u32,
        minute: ((sod % 3600) / 60) as u32,
        second: (sod % 60) as u32,
        millisecond: (fraction / 1_000_000) as u32,
        microsecond: ((fraction / 1_000) % 1_000) as u32,
        nanosecond: (fraction % 1_000) as u32,
    }
}

/// The epoch nanoseconds a wall-clock ISO datetime maps to under a fixed offset.
pub(super) fn local_datetime_to_epoch(p: &TemporalPlainRecord, offset_ns: i64) -> Option<i128> {
    let days = days_from_civil(p.year, p.month, p.day)?;
    let sod = (p.hour as i128 * 60 + p.minute as i128) * 60 + p.second as i128;
    let local = (days * 86_400 + sod).checked_mul(1_000_000_000)?
        + p.millisecond as i128 * 1_000_000
        + p.microsecond as i128 * 1_000
        + p.nanosecond as i128;
    Some(local - offset_ns as i128)
}

/// Render a fixed offset (ns east of UTC) as `±HH:MM`, `±HH:MM:SS`, or
/// `±HH:MM:SS.fffffffff` (trailing-zero-trimmed) — the `offset` string form.
pub(super) fn format_offset_string(offset_ns: i64) -> String {
    let sign = if offset_ns < 0 { '-' } else { '+' };
    let a = offset_ns.unsigned_abs();
    let total_seconds = a / 1_000_000_000;
    let frac = a % 1_000_000_000;
    let h = total_seconds / 3600;
    let m = (total_seconds % 3600) / 60;
    let s = total_seconds % 60;
    if s == 0 && frac == 0 {
        format!("{sign}{h:02}:{m:02}")
    } else if frac == 0 {
        format!("{sign}{h:02}:{m:02}:{s:02}")
    } else {
        format!(
            "{sign}{h:02}:{m:02}:{s:02}.{}",
            format!("{frac:09}").trim_end_matches('0')
        )
    }
}

/// Parse an offset token (`Z`, `±HH`, `±HHMM`, `±HH:MM`, `±HH:MM:SS`,
/// `±HH:MM:SS.fff…`) into nanoseconds east of UTC.
pub(super) fn parse_offset_ns(text: &str) -> Option<i64> {
    let t = text.trim();
    if t.eq_ignore_ascii_case("z") {
        return Some(0);
    }
    let (sign, rest) = match t.strip_prefix('+') {
        Some(r) => (1i64, r),
        None => (-1i64, t.strip_prefix('-')?),
    };
    let (clock, frac) = rest.split_once('.').unwrap_or((rest, ""));
    let has_colons = clock.contains(':');
    let (h, m, s) = if has_colons {
        let mut p = clock.split(':');
        let h: i64 = p.next()?.parse().ok()?;
        let m: i64 = p.next().unwrap_or("0").parse().ok()?;
        let s: i64 = p.next().unwrap_or("0").parse().ok()?;
        if p.next().is_some() {
            return None;
        }
        (h, m, s)
    } else {
        // Compact HH / HHMM / HHMMSS.
        if !clock.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        match clock.len() {
            2 => (clock.parse().ok()?, 0, 0),
            4 => (clock[0..2].parse().ok()?, clock[2..4].parse().ok()?, 0),
            6 => (
                clock[0..2].parse().ok()?,
                clock[2..4].parse().ok()?,
                clock[4..6].parse().ok()?,
            ),
            _ => return None,
        }
    };
    if h > 23 || m > 59 || s > 59 {
        return None;
    }
    let frac_ns: i64 = if frac.is_empty() {
        0
    } else {
        if frac.len() > 9 || !frac.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        format!("{frac:0<9}").parse().ok()?
    };
    Some(sign * ((h * 3600 + m * 60 + s) * 1_000_000_000 + frac_ns))
}

/// A signed numeric offset used *as a time-zone identifier* (`+05:30`), yielding
/// `(canonical id, offset ns)`. Requires a leading sign so a bare `UTC`/named
/// zone falls through to [`resolve_time_zone`].
fn parse_offset_time_zone(text: &str) -> Option<(String, i64)> {
    let t = text.trim();
    if !(t.starts_with('+') || t.starts_with('-')) {
        return None;
    }
    let ns = parse_offset_ns(t)?;
    Some((format_offset_string(ns), ns))
}

/// Resolve a `Temporal.ZonedDateTime` time-zone identifier to `(canonical id,
/// offset ns)`, reusing the shared fixed-offset [`resolve_time_zone`] table for
/// named/`Etc`/`UTC` zones and adding sub-minute numeric offsets.
pub(super) fn resolve_zoned_time_zone(raw: &str) -> Option<(String, i64)> {
    if let Some(pair) = parse_offset_time_zone(raw) {
        return Some(pair);
    }
    let (canonical, minutes) = resolve_time_zone(raw)?;
    Some((canonical, minutes as i64 * 60_000_000_000))
}

/// Parse an ISO `ZonedDateTime` string. A `[timeZone]` annotation is **required**
/// (e.g. `1970-01-01T00:00:00+00:00[UTC]`); a numeric offset in the string, when
/// present, must agree with the fixed zone offset (Temporal's `offset: "reject"`).
pub(super) fn parse_temporal_zoned(text: &str) -> Option<TemporalZonedRecord> {
    let bracket = text.find('[')?;
    let main = &text[..bracket];
    let annotations = &text[bracket..];
    // The first `[...]` that is not a `[u-ca=…]` calendar annotation is the zone;
    // a leading `!` marks a critical annotation and is stripped.
    let mut zone_id: Option<&str> = None;
    let mut rest = annotations;
    while let Some(open) = rest.find('[') {
        let close = rest[open..].find(']')? + open;
        let inner = rest[open + 1..close].trim_start_matches('!');
        if !inner.starts_with("u-ca=") && zone_id.is_none() {
            zone_id = Some(inner);
        }
        rest = &rest[close + 1..];
    }
    let (time_zone, zone_off) = resolve_zoned_time_zone(zone_id?)?;
    // Parse the datetime + optional trailing offset from `main`.
    let (date_part, time_part) = match main.find(['T', 't']) {
        Some(at) => (&main[..at], Some(&main[at + 1..])),
        None => (main, None),
    };
    let mut p = TemporalPlainRecord {
        kind: 2,
        ..Default::default()
    };
    let mut dp = date_part.rsplitn(3, '-');
    p.day = dp.next()?.parse().ok()?;
    p.month = dp.next()?.parse().ok()?;
    p.year = dp.next()?.parse().ok()?;
    let mut string_offset: Option<i64> = None;
    if let Some(time) = time_part {
        // Split the clock from a trailing offset (`Z` or a signed offset). A `-`
        // in a bare time can only be the offset sign (no negative time fields).
        let zone_at = time.rfind(['Z', 'z', '+', '-']);
        let (clock, off) = match zone_at {
            Some(i) => (&time[..i], Some(&time[i..])),
            None => (time, None),
        };
        let mut cp = clock.split(':');
        p.hour = cp.next()?.parse().ok()?;
        p.minute = cp.next().unwrap_or("0").parse().ok()?;
        let sec = cp.next().unwrap_or("0");
        if cp.next().is_some() {
            return None;
        }
        let (whole, frac) = sec.split_once('.').unwrap_or((sec, ""));
        p.second = whole.parse().ok()?;
        if !frac.is_empty() {
            if frac.len() > 9 || !frac.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            let n: u32 = format!("{frac:0<9}").parse().ok()?;
            p.millisecond = n / 1_000_000;
            p.microsecond = (n / 1_000) % 1_000;
            p.nanosecond = n % 1_000;
        }
        if let Some(o) = off {
            string_offset = Some(parse_offset_ns(o)?);
        }
    }
    if !temporal_plain_valid(p) {
        return None;
    }
    if let Some(so) = string_offset {
        if so != zone_off {
            return None;
        }
    }
    let epoch = local_datetime_to_epoch(&p, zone_off)?;
    Some(TemporalZonedRecord {
        epoch_nanoseconds: epoch,
        time_zone,
        offset_ns: zone_off,
    })
}

/// Render a `Temporal.ZonedDateTime`: the local datetime, then (optionally) the
/// offset, the `[timeZone]` annotation, and a `[u-ca=iso8601]` calendar tag.
pub(super) fn format_zoned(
    rec: &TemporalZonedRecord,
    calendar_name: &str,
    show_offset: bool,
    show_zone: bool,
) -> String {
    let p = zoned_local_datetime(rec.epoch_nanoseconds, rec.offset_ns);
    let mut s = format_temporal_plain(p);
    if show_offset {
        s.push_str(&format_offset_string(rec.offset_ns));
    }
    if show_zone {
        s.push_str(&format!("[{}]", rec.time_zone));
    }
    if calendar_name == "always" {
        s.push_str("[u-ca=iso8601]");
    }
    s
}

/// The ISO-8601 week-of-year and its week-numbering year.
pub(super) fn iso_week_of_year(year: i64, month: u32, day: u32) -> (u32, i64) {
    let weeks_in = |y: i64| -> u32 {
        let p =
            |y: i64| ((y + y.div_euclid(4) - y.div_euclid(100) + y.div_euclid(400)) % 7 + 7) % 7;
        if p(y) == 4 || p(y - 1) == 3 {
            53
        } else {
            52
        }
    };
    let ordinal = (days_from_civil(year, month, day).unwrap_or(0)
        - days_from_civil(year, 1, 1).unwrap_or(0)) as i64
        + 1;
    // ISO weekday, Monday = 1 … Sunday = 7.
    let dow = ((days_from_civil(year, month, day).unwrap_or(0) + 3).rem_euclid(7)) as i64 + 1;
    let mut week = (ordinal - dow + 10).div_euclid(7);
    let mut week_year = year;
    if week < 1 {
        week_year = year - 1;
        week = weeks_in(week_year) as i64;
    } else if week > weeks_in(year) as i64 {
        week = 1;
        week_year = year + 1;
    }
    (week as u32, week_year)
}

/// Round `value` to a multiple of `quantum` (> 0) under a Temporal rounding mode.
/// Returns `None` for an unrecognized mode.
pub(super) fn round_temporal(value: i128, quantum: i128, mode: &str) -> Option<i128> {
    if quantum <= 0 {
        return None;
    }
    let lo = value.div_euclid(quantum) * quantum;
    let r = value - lo;
    if r == 0 {
        return Some(value);
    }
    let hi = lo + quantum;
    let idx = value.div_euclid(quantum);
    let res = match mode {
        "trunc" => {
            if value >= 0 {
                lo
            } else {
                hi
            }
        }
        "floor" => lo,
        "ceil" => hi,
        "expand" => {
            if value >= 0 {
                hi
            } else {
                lo
            }
        }
        "halfExpand" | "halfCeil" | "halfFloor" | "halfEven" | "halfTrunc" => {
            if 2 * r < quantum {
                lo
            } else if 2 * r > quantum {
                hi
            } else {
                match mode {
                    "halfExpand" => {
                        if value >= 0 {
                            hi
                        } else {
                            lo
                        }
                    }
                    "halfTrunc" => {
                        if value >= 0 {
                            lo
                        } else {
                            hi
                        }
                    }
                    "halfCeil" => hi,
                    "halfFloor" => lo,
                    "halfEven" => {
                        if idx.rem_euclid(2) == 0 {
                            lo
                        } else {
                            hi
                        }
                    }
                    _ => hi,
                }
            }
        }
        _ => return None,
    };
    Some(res)
}

/// Balance an exact nanosecond difference into a `Temporal.Duration` down from
/// `largest` (a fixed-size unit, `day`…`nanosecond`). Calendar units
/// (`week`/`month`/`year`) return `None` — the fixed-offset model cannot express
/// them without calendar-relative arithmetic.
pub(super) fn balance_zoned_diff(ns: i128, largest: &str) -> Option<TemporalDurationRecord> {
    let sizes: [(&str, i128); 7] = [
        ("day", 86_400_000_000_000),
        ("hour", 3_600_000_000_000),
        ("minute", 60_000_000_000),
        ("second", 1_000_000_000),
        ("millisecond", 1_000_000),
        ("microsecond", 1_000),
        ("nanosecond", 1),
    ];
    let start = sizes.iter().position(|(name, _)| *name == largest)?;
    let sign = ns.signum();
    let mut n = ns.unsigned_abs() as i128;
    let mut vals = [0i128; 7];
    for (i, (_, size)) in sizes.iter().enumerate().skip(start) {
        vals[i] = n / size;
        n %= size;
    }
    let f = |v: i128| -> Option<i64> { i64::try_from(v * sign).ok() };
    Some(TemporalDurationRecord {
        days: f(vals[0])?,
        hours: f(vals[1])?,
        minutes: f(vals[2])?,
        seconds: f(vals[3])?,
        milliseconds: f(vals[4])?,
        microseconds: f(vals[5])?,
        nanoseconds: f(vals[6])?,
        ..Default::default()
    })
}

/// Resolve a requested time-zone identifier to `(canonical name, fixed offset
/// minutes east of UTC)` over the frozen profile: UTC and its aliases, numeric
/// `±HH[:MM]` offsets, the `Etc/GMT±N` fixed zones, and a small table of common
/// IANA names carried at their **standard** (non-DST) offset. An unrecognized
/// identifier yields `None` (a RangeError at the call site).
pub(super) fn resolve_time_zone(raw: &str) -> Option<(String, i32)> {
    let trimmed = raw.trim();
    let lower = trimmed.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "utc" | "etc/utc" | "gmt" | "etc/gmt" | "zulu" | "etc/zulu"
    ) {
        return Some(("UTC".to_string(), 0));
    }
    // Numeric offset: +HH, +HHMM, +HH:MM (and the minus forms).
    if let Some((sign, rest)) = trimmed
        .strip_prefix('+')
        .map(|r| (1, r))
        .or_else(|| trimmed.strip_prefix('-').map(|r| (-1, r)))
    {
        let digits: String = rest.chars().filter(|c| c.is_ascii_digit()).collect();
        let colon_ok = rest.chars().all(|c| c.is_ascii_digit() || c == ':');
        if colon_ok && (digits.len() == 2 || digits.len() == 4) {
            let hh: i32 = digits[0..2].parse().ok()?;
            let mm: i32 = if digits.len() == 4 {
                digits[2..4].parse().ok()?
            } else {
                0
            };
            if hh <= 23 && mm <= 59 {
                let total = sign * (hh * 60 + mm);
                let canonical = format!("{}{:02}:{:02}", if sign < 0 { "-" } else { "+" }, hh, mm);
                return Some((canonical, total));
            }
        }
        return None;
    }
    // Etc/GMT±N (sign inverted: Etc/GMT+1 is UTC-1).
    if let Some(rest) = lower.strip_prefix("etc/gmt") {
        if let Some((sign, num)) = rest
            .strip_prefix('+')
            .map(|n| (1, n))
            .or_else(|| rest.strip_prefix('-').map(|n| (-1, n)))
        {
            if let Ok(n) = num.parse::<i32>() {
                if n <= 14 {
                    let canonical = format!("Etc/GMT{}{}", if sign < 0 { "-" } else { "+" }, n);
                    return Some((canonical, -sign * n * 60));
                }
            }
        }
    }
    // Common IANA zones at their standard offset (DST not modeled).
    let table: &[(&str, &str, i32)] = &[
        ("america/new_york", "America/New_York", -300),
        ("america/chicago", "America/Chicago", -360),
        ("america/denver", "America/Denver", -420),
        ("america/los_angeles", "America/Los_Angeles", -480),
        ("america/sao_paulo", "America/Sao_Paulo", -180),
        ("america/anchorage", "America/Anchorage", -540),
        ("america/halifax", "America/Halifax", -240),
        ("america/mexico_city", "America/Mexico_City", -360),
        ("europe/london", "Europe/London", 0),
        ("europe/paris", "Europe/Paris", 60),
        ("europe/berlin", "Europe/Berlin", 60),
        ("europe/moscow", "Europe/Moscow", 180),
        ("africa/cairo", "Africa/Cairo", 120),
        ("asia/jerusalem", "Asia/Jerusalem", 120),
        ("asia/kolkata", "Asia/Kolkata", 330),
        ("asia/calcutta", "Asia/Kolkata", 330),
        ("asia/shanghai", "Asia/Shanghai", 480),
        ("asia/tokyo", "Asia/Tokyo", 540),
        ("asia/hong_kong", "Asia/Hong_Kong", 480),
        ("asia/seoul", "Asia/Seoul", 540),
        ("australia/sydney", "Australia/Sydney", 600),
        ("pacific/auckland", "Pacific/Auckland", 720),
        ("pacific/honolulu", "Pacific/Honolulu", -600),
    ];
    for (key, canonical, offset) in table {
        if lower == *key {
            return Some((canonical.to_string(), *offset));
        }
    }
    None
}
