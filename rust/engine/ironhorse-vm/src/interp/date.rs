//! Date value clipping, calendar construction, parsing, and display forms.

use super::{days_from_civil, trim_ecma_whitespace};

/// Civil calendar fields of a time value `t` (ms since the epoch) after
/// applying a fixed zone offset (minutes east of UTC). Proleptic Gregorian,
/// Howard Hinnant's `civil_from_days`. Returns
/// `(year, month1_12, day, weekday0_sun, hour, minute, second, millis)`.
pub(super) fn civil_fields(
    t: f64,
    offset_minutes: i32,
) -> (i64, u32, u32, u32, u32, u32, u32, u32) {
    let local = t + offset_minutes as f64 * 60_000.0;
    let day_ms = 86_400_000.0;
    let days = (local / day_ms).floor() as i64;
    let ms_of_day = (local - days as f64 * day_ms) as i64; // [0, 86_400_000)
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146_096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = if m <= 2 { y + 1 } else { y };
    let weekday = (((days % 7 + 4) % 7 + 7) % 7) as u32; // 0 = Sunday
    let secs = ms_of_day / 1000;
    let hour = (secs / 3600) as u32;
    let minute = ((secs % 3600) / 60) as u32;
    let second = (secs % 60) as u32;
    let millis = (ms_of_day % 1000) as u32;
    (year, m, d, weekday, hour, minute, second, millis)
}

pub(super) fn time_clip(t: f64) -> f64 {
    if !t.is_finite() || t.abs() > 8_640_000_000_000_000.0 {
        f64::NAN
    } else {
        let clipped = t.trunc();
        if clipped == 0.0 {
            0.0
        } else {
            clipped
        }
    }
}

pub(super) fn date_from_components(v: [f64; 7]) -> f64 {
    let mut v = v;
    let mut year = v[0].trunc();
    if (0.0..=99.0).contains(&year) {
        year += 1900.0;
    }
    v[0] = year;
    date_from_components_exact(v)
}

/// `MakeDate(MakeDay(...), MakeTime(...))` followed by `TimeClip`, with an
/// exact year. Date construction/`Date.UTC` apply their legacy 0..99 →
/// 1900..1999 adjustment before entering here; Date setters do not.
pub(super) fn date_from_components_exact(v: [f64; 7]) -> f64 {
    if v.iter().any(|n| !n.is_finite()) {
        return f64::NAN;
    }
    let year = v[0].trunc();
    if year < i64::MIN as f64 || year > i64::MAX as f64 {
        return f64::NAN;
    }
    let month = v[1].trunc();
    if month < i64::MIN as f64 || month > i64::MAX as f64 {
        return f64::NAN;
    }
    let total_month = (year as i128) * 12 + month as i128;
    let norm_year = total_month.div_euclid(12);
    let norm_month = total_month.rem_euclid(12) as u32 + 1;
    let Ok(norm_year) = i64::try_from(norm_year) else {
        return f64::NAN;
    };
    let Some(first) = days_from_civil(norm_year, norm_month, 1) else {
        return f64::NAN;
    };
    let Some(days) = first
        .checked_add(v[2].trunc() as i128)
        .and_then(|days| days.checked_sub(1))
    else {
        return f64::NAN;
    };
    time_clip(
        days as f64 * 86_400_000.0
            + v[3].trunc() * 3_600_000.0
            + v[4].trunc() * 60_000.0
            + v[5].trunc() * 1_000.0
            + v[6].trunc(),
    )
}

pub(super) fn parse_date_string(text: &str) -> Option<f64> {
    let text = trim_ecma_whitespace(text);
    parse_iso_date_string(text)
        .or_else(|| parse_xs_legacy_iso_string(text))
        .or_else(|| parse_date_display_string(text))
}

/// Parse the Date Time String Format, including the specified defaults for an
/// omitted month, day, clock fields, and UTC offset. The profile's local zone
/// is UTC, so an absent offset on a date-time has the same numeric result as
/// the explicitly-UTC date-only forms.
fn parse_iso_date_string(text: &str) -> Option<f64> {
    let (date, clock) = match text.find(['T', 't']) {
        Some(i) => (&text[..i], Some(&text[i + 1..])),
        None => (text, None),
    };
    let year_width = if date.starts_with(['+', '-']) { 7 } else { 4 };
    if date.len() < year_width {
        return None;
    }
    let year_text = date.get(..year_width)?;
    let year_digits = year_text.trim_start_matches(['+', '-']);
    if year_digits.len() != year_width - usize::from(year_width == 7)
        || !year_digits.bytes().all(|byte| byte.is_ascii_digit())
        || year_text == "-000000"
    {
        return None;
    }
    let year: i64 = year_text.parse().ok()?;
    let tail = &date[year_width..];
    let (month, day) = match tail.len() {
        0 => (1, 1),
        3 if tail.starts_with('-') => (tail[1..].parse().ok()?, 1),
        6 if tail.as_bytes().get(0) == Some(&b'-') && tail.as_bytes().get(3) == Some(&b'-') => {
            (tail[1..3].parse().ok()?, tail[4..6].parse().ok()?)
        }
        _ => return None,
    };
    let days = days_from_civil(year, month, day)?;
    let Some(clock) = clock else {
        return Some(time_clip((days * 86_400_000) as f64));
    };

    let (clock, offset_minutes) =
        if let Some(clock) = clock.strip_suffix('Z').or_else(|| clock.strip_suffix('z')) {
            (clock, 0i128)
        } else if let Some(at) = clock.rfind(['+', '-']) {
            let (clock, zone) = clock.split_at(at);
            let sign = if zone.starts_with('-') { -1i128 } else { 1i128 };
            let zone = &zone[1..];
            let (hours, minutes) = if zone.len() == 5 && zone.as_bytes()[2] == b':' {
                (
                    zone.get(..2)?.parse::<i128>().ok()?,
                    zone[3..].parse::<i128>().ok()?,
                )
            } else if zone.len() == 4 {
                (
                    zone.get(..2)?.parse::<i128>().ok()?,
                    zone.get(2..)?.parse::<i128>().ok()?,
                )
            } else {
                return None;
            };
            if hours > 23 || minutes > 59 {
                return None;
            }
            (clock, sign * (hours * 60 + minutes))
        } else {
            (clock, 0)
        };
    let (hour, minute, second, millis) = parse_date_clock(clock)?;
    if hour > 24
        || minute > 59
        || second > 59
        || (hour == 24 && (minute != 0 || second != 0 || millis != 0))
    {
        return None;
    }
    let total = days * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1_000 + millis
        - offset_minutes * 60_000;
    Some(time_clip(total as f64))
}

fn parse_date_clock(clock: &str) -> Option<(i128, i128, i128, i128)> {
    let mut parts = clock.split(':');
    let hour = parts.next()?.parse().ok()?;
    let minute = parts.next()?.parse().ok()?;
    let seconds = parts.next();
    if parts.next().is_some() {
        return None;
    }
    let Some(seconds) = seconds else {
        return Some((hour, minute, 0, 0));
    };
    let (second, fraction) = seconds.split_once('.').unwrap_or((seconds, ""));
    if fraction.len() > 3 || !fraction.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let millis = if fraction.is_empty() {
        0
    } else {
        format!("{fraction:0<3}").parse().ok()?
    };
    Some((hour, minute, second.parse().ok()?, millis))
}

/// Preserve the pinned XS implementation-defined ISO-like fallback accepted
/// before the strict Date Time String Format parser was introduced. This path
/// is deliberately second: conforming strings use [`parse_iso_date_string`],
/// while the fallback normalizes out-of-range calendar/clock fields, truncates
/// excess fractional-second digits, and accepts an hours-only zone offset.
fn parse_xs_legacy_iso_string(text: &str) -> Option<f64> {
    let (date, clock) = match text.find(['T', 't']) {
        Some(i) => (&text[..i], Some(&text[i + 1..])),
        None => (text, None),
    };
    let year_width = if date.starts_with(['+', '-']) { 7 } else { 4 };
    if date.len() < year_width {
        return None;
    }
    let year_text = date.get(..year_width)?;
    let year_digits = year_text.trim_start_matches(['+', '-']);
    if year_digits.len() != year_width - usize::from(year_width == 7)
        || !year_digits.bytes().all(|byte| byte.is_ascii_digit())
        || year_text == "-000000"
    {
        return None;
    }
    let year: i64 = year_text.parse().ok()?;
    let tail = &date[year_width..];
    let (month, day) = match tail.len() {
        0 => (1i128, 1i128),
        3 if tail.starts_with('-') => (tail[1..].parse().ok()?, 1),
        6 if tail.as_bytes().first() == Some(&b'-') && tail.as_bytes().get(3) == Some(&b'-') => {
            (tail[1..3].parse().ok()?, tail[4..6].parse().ok()?)
        }
        _ => return None,
    };
    // Pinned XS treats a legacy `-00-` month as January rather than as the
    // month preceding January. Positive months retain the ordinary 1-based
    // to zero-based conversion, including normalization past December.
    let month_index = (month - 1).max(0);
    let Some(clock) = clock else {
        return Some(date_from_components_exact([
            year as f64,
            month_index as f64,
            day as f64,
            0.0,
            0.0,
            0.0,
            0.0,
        ]));
    };

    let (clock, offset_minutes) =
        if let Some(clock) = clock.strip_suffix('Z').or_else(|| clock.strip_suffix('z')) {
            (clock, 0i128)
        } else if let Some(at) = clock.rfind(['+', '-']) {
            let (clock, zone) = clock.split_at(at);
            let sign = if zone.starts_with('-') { -1i128 } else { 1i128 };
            let zone = &zone[1..];
            let (hours, minutes) = if zone.len() == 5 && zone.as_bytes()[2] == b':' {
                (
                    zone.get(..2)?.parse::<i128>().ok()?,
                    zone[3..].parse::<i128>().ok()?,
                )
            } else if zone.len() == 4 {
                (
                    zone.get(..2)?.parse::<i128>().ok()?,
                    zone.get(2..)?.parse::<i128>().ok()?,
                )
            } else if zone.len() == 2 {
                (zone.parse::<i128>().ok()?, 0)
            } else {
                return None;
            };
            if hours > 23 || minutes > 59 {
                return None;
            }
            (clock, sign * (hours * 60 + minutes))
        } else {
            (clock, 0)
        };
    let (hour, minute, second, millis) = parse_xs_legacy_date_clock(clock)?;
    let local = date_from_components_exact([
        year as f64,
        month_index as f64,
        day as f64,
        hour as f64,
        minute as f64,
        second as f64,
        millis as f64,
    ]);
    Some(time_clip(local - offset_minutes as f64 * 60_000.0))
}

fn parse_xs_legacy_date_clock(clock: &str) -> Option<(i128, i128, i128, i128)> {
    let mut parts = clock.split(':');
    let hour = parts.next()?.parse().ok()?;
    let minute = parts.next()?.parse().ok()?;
    let seconds = parts.next();
    if parts.next().is_some() {
        return None;
    }
    let Some(seconds) = seconds else {
        return Some((hour, minute, 0, 0));
    };
    let (second, fraction) = seconds.split_once('.').unwrap_or((seconds, ""));
    if !fraction.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let millis = if fraction.is_empty() {
        0
    } else {
        let prefix = &fraction[..fraction.len().min(3)];
        format!("{prefix:0<3}").parse().ok()?
    };
    Some((hour, minute, second.parse().ok()?, millis))
}

/// Parse the implementation-defined forms emitted by `toString` and
/// `toUTCString`. ECMAScript requires both forms to round-trip through
/// `Date.parse` for integral-millisecond Date values.
fn parse_date_display_string(text: &str) -> Option<f64> {
    let fields: Vec<&str> = text.split_ascii_whitespace().collect();
    let (month, day, year, clock, zone) = match fields.as_slice() {
        [weekday, month, day, year, clock, "GMT+0000"] if weekday.len() == 3 => {
            (*month, *day, *year, *clock, 0i128)
        }
        [weekday, day, month, year, clock, "GMT"]
            if weekday.len() == 4 && weekday.ends_with(',') =>
        {
            (*month, *day, *year, *clock, 0i128)
        }
        _ => return None,
    };
    let month = EN_MONTHS_SHORT.iter().position(|name| *name == month)? as u32 + 1;
    let day: u32 = day.parse().ok()?;
    let year: i64 = year.parse().ok()?;
    let days = days_from_civil(year, month, day)?;
    let (hour, minute, second, millis) = parse_date_clock(clock)?;
    if hour > 23 || minute > 59 || second > 59 || millis != 0 {
        return None;
    }
    let total =
        days * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1_000 - zone * 60_000;
    Some(time_clip(total as f64))
}

fn date_iso_year_string(year: i64) -> String {
    if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else if year < 0 {
        format!("-{:06}", year.unsigned_abs())
    } else {
        format!("+{year:06}")
    }
}

fn date_display_year_string(year: i64) -> String {
    if year < 0 {
        format!("-{:04}", year.unsigned_abs())
    } else {
        format!("{year:04}")
    }
}

pub(super) fn date_iso_string(t: f64) -> String {
    let (y, m, d, _, h, min, s, ms) = civil_fields(t, 0);
    format!(
        "{}-{m:02}-{d:02}T{h:02}:{min:02}:{s:02}.{ms:03}Z",
        date_iso_year_string(y)
    )
}

pub(super) fn date_utc_string(t: f64) -> String {
    let (y, m, d, w, h, min, s, _) = civil_fields(t, 0);
    format!(
        "{}, {d:02} {} {} {h:02}:{min:02}:{s:02} GMT",
        EN_WEEKDAYS_SHORT[w as usize],
        EN_MONTHS_SHORT[m as usize - 1],
        date_display_year_string(y)
    )
}

pub(super) fn date_only_string(t: f64) -> String {
    let (y, m, d, w, _, _, _, _) = civil_fields(t, 0);
    format!(
        "{} {} {d:02} {}",
        EN_WEEKDAYS_SHORT[w as usize],
        EN_MONTHS_SHORT[m as usize - 1],
        date_display_year_string(y)
    )
}

pub(super) fn date_time_string(t: f64) -> String {
    let (_, _, _, _, h, min, s, _) = civil_fields(t, 0);
    format!("{h:02}:{min:02}:{s:02} GMT+0000")
}

pub(super) fn date_local_string(t: f64) -> String {
    format!("{} {}", date_only_string(t), date_time_string(t))
}

pub(super) const EN_MONTHS_LONG: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

pub(super) const EN_MONTHS_SHORT: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

pub(super) const EN_MONTHS_NARROW: [&str; 12] =
    ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];

pub(super) const EN_WEEKDAYS_LONG: [&str; 7] = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];

pub(super) const EN_WEEKDAYS_SHORT: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

pub(super) const EN_WEEKDAYS_NARROW: [&str; 7] = ["S", "M", "T", "W", "T", "F", "S"];
