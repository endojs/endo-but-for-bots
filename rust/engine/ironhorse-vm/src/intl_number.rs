//! The deterministic ECMA-402 `Intl.NumberFormat` number-formatting core.
//!
//! The pinned Moddable XS oracle has no ECMA-402 host, so every Intl case is
//! proven by requiring ironhorse to run it to completion with the exact CLDR
//! value while the oracle reports the missing `Intl` binding (the host-only
//! exclusion `oracle-host-missing-intl`). This module is the value engine that
//! makes those completions correct: it takes a fully resolved option record and
//! a `f64`, and produces either the formatted string or the typed part list
//! that `format`/`formatToParts` return.
//!
//! The rounding operates on the **exact** decimal expansion of the double
//! (`format!("{:.1100}", x)` yields the terminating exact value, since every
//! finite `f64` is a dyadic rational), so `ApplyUnsignedRoundingMode` matches
//! the reference engines bit-for-bit rather than rounding a shortest-round-trip
//! approximation.

/// The resolved `[[Style]]` of a NumberFormat.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Style {
    Decimal,
    Percent,
    Currency,
    Unit,
}

/// The resolved `[[Notation]]`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Notation {
    Standard,
    Scientific,
    Engineering,
    Compact,
}

/// The resolved `[[UseGrouping]]` value (already normalized from the option).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Grouping {
    /// `"always"` — group whenever there is a thousands boundary.
    Always,
    /// `"auto"` — group, but honor the locale's minimum-grouping-digits.
    Auto,
    /// `"min2"` — group only when the integer part has at least two digits
    /// before the first group separator.
    Min2,
    /// `false` — never group.
    Never,
}

/// The rounding family that governs which digit bounds apply.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RoundingType {
    FractionDigits,
    SignificantDigits,
    MorePrecision,
    LessPrecision,
}

/// A fully resolved NumberFormat option record — everything the value engine
/// needs, decoupled from the VM's slot representation.
#[derive(Clone, Debug)]
pub struct NfResolved {
    pub locale: String,
    pub numbering_system: String,
    pub style: Style,
    pub notation: Notation,
    pub compact_display: CompactDisplay,
    pub sign_display: SignDisplay,
    pub grouping: Grouping,
    pub currency: Option<String>,
    pub currency_display: CurrencyDisplay,
    pub currency_sign: CurrencySign,
    pub unit: Option<String>,
    pub unit_display: UnitDisplay,
    pub min_integer_digits: u32,
    pub min_fraction_digits: u32,
    pub max_fraction_digits: u32,
    pub min_significant_digits: Option<u32>,
    pub max_significant_digits: Option<u32>,
    pub rounding_type: RoundingType,
    pub rounding_increment: u32,
    pub rounding_mode: RoundingMode,
    pub trailing_zero_display: TrailingZeroDisplay,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CompactDisplay {
    Short,
    Long,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SignDisplay {
    Auto,
    Always,
    Never,
    ExceptZero,
    Negative,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CurrencyDisplay {
    Symbol,
    NarrowSymbol,
    Code,
    Name,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CurrencySign {
    Standard,
    Accounting,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum UnitDisplay {
    Short,
    Narrow,
    Long,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TrailingZeroDisplay {
    Auto,
    StripIfInteger,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RoundingMode {
    Ceil,
    Floor,
    Expand,
    Trunc,
    HalfCeil,
    HalfFloor,
    HalfExpand,
    HalfTrunc,
    HalfEven,
}

impl RoundingMode {
    pub fn from_str(s: &str) -> Option<RoundingMode> {
        Some(match s {
            "ceil" => RoundingMode::Ceil,
            "floor" => RoundingMode::Floor,
            "expand" => RoundingMode::Expand,
            "trunc" => RoundingMode::Trunc,
            "halfCeil" => RoundingMode::HalfCeil,
            "halfFloor" => RoundingMode::HalfFloor,
            "halfExpand" => RoundingMode::HalfExpand,
            "halfTrunc" => RoundingMode::HalfTrunc,
            "halfEven" => RoundingMode::HalfEven,
            _ => return None,
        })
    }
}

/// The `[[Type]]` of a formatToParts part.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PartType {
    Literal,
    Integer,
    Group,
    Decimal,
    Fraction,
    MinusSign,
    PlusSign,
    PercentSign,
    Currency,
    Unit,
    Nan,
    Infinity,
    ExponentSeparator,
    ExponentMinusSign,
    ExponentInteger,
    Compact,
}

impl PartType {
    pub fn as_str(self) -> &'static str {
        match self {
            PartType::Literal => "literal",
            PartType::Integer => "integer",
            PartType::Group => "group",
            PartType::Decimal => "decimal",
            PartType::Fraction => "fraction",
            PartType::MinusSign => "minusSign",
            PartType::PlusSign => "plusSign",
            PartType::PercentSign => "percentSign",
            PartType::Currency => "currency",
            PartType::Unit => "unit",
            PartType::Nan => "nan",
            PartType::Infinity => "infinity",
            PartType::ExponentSeparator => "exponentSeparator",
            PartType::ExponentMinusSign => "exponentMinusSign",
            PartType::ExponentInteger => "exponentInteger",
            PartType::Compact => "compact",
        }
    }
}

/// One formatToParts part: its type and its (already numbering-system-mapped)
/// string value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Part {
    pub kind: PartType,
    pub value: String,
}

impl Part {
    fn new(kind: PartType, value: impl Into<String>) -> Part {
        Part {
            kind,
            value: value.into(),
        }
    }
}

/// The exact non-negative decimal value of `x.abs()`, normalized to a leading
/// significant digit and its power-of-ten position. `digits` carries every
/// significant digit (no leading zeros, trailing zeros trimmed); the value is
/// `Σ digits[i] * 10^(exponent - i)`. Zero is `digits == []`, `exponent == 0`.
#[derive(Clone, Debug)]
struct Decimal {
    digits: Vec<u8>,
    exponent: i32,
}

impl Decimal {
    fn zero() -> Decimal {
        Decimal {
            digits: Vec::new(),
            exponent: 0,
        }
    }

    fn is_zero(&self) -> bool {
        self.digits.is_empty()
    }

    /// The exact decimal expansion of a finite, non-negative double.
    fn from_f64(x: f64) -> Decimal {
        debug_assert!(x.is_finite() && x >= 0.0);
        if x == 0.0 {
            return Decimal::zero();
        }
        // `format!("{:.1100}")` prints the correctly-rounded value to 1100
        // fractional places; since every finite double terminates within 1074
        // fractional digits, this is the exact value.
        let s = format!("{x:.1100}");
        let (int_str, frac_str) = match s.split_once('.') {
            Some((i, f)) => (i, f),
            None => (s.as_str(), ""),
        };
        let int_trimmed = int_str.trim_start_matches('0');
        if !int_trimmed.is_empty() {
            // value >= 1: leading digit sits at 10^(len(int)-1).
            let exponent = int_trimmed.len() as i32 - 1;
            let mut digits: Vec<u8> = int_trimmed
                .bytes()
                .chain(frac_str.bytes())
                .map(|b| b - b'0')
                .collect();
            trim_trailing_zeros(&mut digits);
            Decimal { digits, exponent }
        } else {
            // value < 1: find the first nonzero fractional digit.
            let first_nz = frac_str.bytes().position(|b| b != b'0');
            match first_nz {
                None => Decimal::zero(),
                Some(k) => {
                    let exponent = -(k as i32) - 1;
                    let mut digits: Vec<u8> =
                        frac_str[k..].bytes().map(|b| b - b'0').collect();
                    trim_trailing_zeros(&mut digits);
                    Decimal { digits, exponent }
                }
            }
        }
    }

    /// An exact non-negative decimal integer. `digits` contains only ASCII
    /// decimal digits and may contain leading or trailing zeroes.
    fn from_integer_ascii(digits: &str) -> Decimal {
        let digits = digits.trim_start_matches('0');
        if digits.is_empty() {
            return Decimal::zero();
        }
        let exponent = digits.len() as i32 - 1;
        let mut digits: Vec<u8> = digits.bytes().map(|b| b - b'0').collect();
        trim_trailing_zeros(&mut digits);
        Decimal { digits, exponent }
    }

    /// Multiply by `10^shift` — just moves the point.
    fn scale_pow10(&mut self, shift: i32) {
        if !self.is_zero() {
            self.exponent += shift;
        }
    }
}

fn trim_trailing_zeros(digits: &mut Vec<u8>) {
    while digits.last() == Some(&0) {
        digits.pop();
    }
}

/// Round `dec` to keep exactly `keep` leading significant digits (>= 0),
/// applying `mode` with the sign of the original value. Returns the rounded,
/// **fixed-width** digit vector (length == `keep`, may include trailing zeros)
/// paired with the exponent of its leading digit. `keep == 0` rounds to either
/// zero or one (a leading 1 from carrying).
fn round_to_significant(
    dec: &Decimal,
    keep: usize,
    mode: RoundingMode,
    negative: bool,
) -> Decimal {
    if dec.is_zero() {
        return Decimal {
            digits: vec![0; keep],
            exponent: dec.exponent,
        };
    }
    if dec.digits.len() <= keep {
        // Exact — pad with trailing zeros to the fixed width.
        let mut digits = dec.digits.clone();
        digits.resize(keep, 0);
        return Decimal {
            digits,
            exponent: dec.exponent,
        };
    }
    let mut kept: Vec<u8> = dec.digits[..keep].to_vec();
    let first_dropped = dec.digits[keep];
    let rest_nonzero = dec.digits[keep + 1..].iter().any(|&d| d != 0);
    let round_up = decide_round_up(
        mode,
        negative,
        first_dropped,
        rest_nonzero,
        kept.last().copied().unwrap_or(0),
    );
    let mut exponent = dec.exponent;
    if round_up {
        if increment_digits(&mut kept) {
            // Carry rippled past the front: [1, 0, 0, ...]; drop the new last
            // digit to keep the fixed width and bump the exponent.
            kept.insert(0, 1);
            kept.pop();
            exponent += 1;
        }
    }
    Decimal {
        digits: kept,
        exponent,
    }
}

/// Decide whether to round the retained value up by one unit in the last kept
/// place. `first_dropped` is the digit just past the cut; `rest_nonzero` is
/// whether anything nonzero follows it; `last_kept` is the retained last digit
/// (for half-even).
fn decide_round_up(
    mode: RoundingMode,
    negative: bool,
    first_dropped: u8,
    rest_nonzero: bool,
    last_kept: u8,
) -> bool {
    // Compare the dropped tail to one half of a unit.
    let cmp_half = if first_dropped > 5 {
        std::cmp::Ordering::Greater
    } else if first_dropped < 5 {
        std::cmp::Ordering::Less
    } else if rest_nonzero {
        std::cmp::Ordering::Greater
    } else {
        std::cmp::Ordering::Equal
    };
    use std::cmp::Ordering::*;
    match mode {
        RoundingMode::Ceil => !negative,
        RoundingMode::Floor => negative,
        RoundingMode::Expand => true,
        RoundingMode::Trunc => false,
        RoundingMode::HalfCeil => match cmp_half {
            Greater => true,
            Less => false,
            Equal => !negative,
        },
        RoundingMode::HalfFloor => match cmp_half {
            Greater => true,
            Less => false,
            Equal => negative,
        },
        RoundingMode::HalfExpand => match cmp_half {
            Greater => true,
            Less => false,
            Equal => true,
        },
        RoundingMode::HalfTrunc => match cmp_half {
            Greater => true,
            Less => false,
            Equal => false,
        },
        RoundingMode::HalfEven => match cmp_half {
            Greater => true,
            Less => false,
            Equal => last_kept % 2 == 1,
        },
    }
}

/// Increment a big-endian decimal digit vector by one. Returns `true` if the
/// increment overflowed the current width (i.e. all digits were 9).
fn increment_digits(digits: &mut [u8]) -> bool {
    for d in digits.iter_mut().rev() {
        if *d == 9 {
            *d = 0;
        } else {
            *d += 1;
            return false;
        }
    }
    true
}

/// The intermediate result of rounding to the resolved digit options: the fixed
/// integer/fraction digit strings (ASCII, latn) plus, for exponential/compact
/// notation, the chosen scaling exponent.
struct Rendered {
    int_digits: String,
    frac_digits: String,
}

/// Apply the fraction-digit rounding (ToRawFixed) to `dec` with a fraction cap
/// of `max_frac` and floor of `min_frac`, honoring `rounding_increment` and
/// `trailing_zero_display`.
fn to_raw_fixed(
    dec: &Decimal,
    min_frac: u32,
    max_frac: u32,
    mode: RoundingMode,
    negative: bool,
    rounding_increment: u32,
    trailing_zero: TrailingZeroDisplay,
) -> Rendered {
    // Round to `max_frac` fraction places. The digit index in `dec.digits` that
    // sits at 10^(-max_frac) is `exponent + max_frac`. `keep` counts leading
    // significant digits to retain.
    let keep = dec.exponent + max_frac as i32 + 1;
    let rounded = if keep <= 0 {
        // Everything rounds away below the least place; decide carry.
        round_to_significant(dec, 0, mode, negative)
    } else {
        round_to_significant(dec, keep as usize, mode, negative)
    };
    let mut r = layout_fixed(&rounded, max_frac);
    if rounding_increment != 1 {
        r = apply_rounding_increment(dec, min_frac, max_frac, mode, negative, rounding_increment);
    }
    // Trim to at least min_frac, honoring stripIfInteger.
    trim_fraction(&mut r.frac_digits, min_frac as usize, trailing_zero, &r.int_digits);
    r
}

/// Render a rounded `Decimal` as fixed integer/fraction ASCII strings, where
/// the fraction has exactly `frac_places` digits before trimming.
fn layout_fixed(rounded: &Decimal, frac_places: u32) -> Rendered {
    if rounded.digits.iter().all(|&d| d == 0) {
        return Rendered {
            int_digits: "0".to_string(),
            frac_digits: "0".repeat(frac_places as usize),
        };
    }
    // Place value of leading digit is 10^exponent. Build a fixed-point string.
    let exp = rounded.exponent;
    let digits = &rounded.digits;
    let mut int_str = String::new();
    let mut frac_str = String::new();
    // Iterate positions from the highest place down to 10^(-frac_places).
    let high = exp.max(0);
    let low = -(frac_places as i32);
    let mut pos = high;
    while pos >= low {
        // digit at place 10^pos is digits[exp - pos] when in range.
        let idx = exp - pos;
        let d = if idx >= 0 && (idx as usize) < digits.len() {
            digits[idx as usize]
        } else {
            0
        };
        if pos >= 0 {
            int_str.push((b'0' + d) as char);
        } else {
            frac_str.push((b'0' + d) as char);
        }
        pos -= 1;
    }
    if int_str.is_empty() {
        int_str.push('0');
    }
    Rendered {
        int_digits: int_str,
        frac_digits: frac_str,
    }
}

/// Round `dec` to a multiple of `increment * 10^(-max_frac)`.
fn apply_rounding_increment(
    dec: &Decimal,
    _min_frac: u32,
    max_frac: u32,
    mode: RoundingMode,
    negative: bool,
    increment: u32,
) -> Rendered {
    // Work in units of 10^(-max_frac). Scale the value up, round to an integer
    // multiple of `increment`, then lay it back out.
    let mut scaled = dec.clone();
    scaled.scale_pow10(max_frac as i32);
    // Round `scaled` to an integer, then to a multiple of `increment`.
    let keep = scaled.exponent + 1;
    let integer = if keep <= 0 {
        round_to_significant(&scaled, 0, mode, negative)
    } else {
        round_to_significant(&scaled, keep as usize, mode, negative)
    };
    // Turn `integer` into a u128 (values in these tests stay well within range).
    let mut n: u128 = 0;
    for &d in &integer.digits {
        n = n * 10 + d as u128;
    }
    // Number of integer digits implied by exponent (there may be trailing
    // zeros beyond the significant digits).
    if !integer.digits.is_empty() {
        let total_len = integer.exponent + 1;
        let extra = total_len - integer.digits.len() as i32;
        for _ in 0..extra.max(0) {
            n *= 10;
        }
    }
    // Round n to nearest multiple of increment (respecting the mode via the
    // remainder). Because `dec` already carries the exact value we re-round.
    let inc = increment as u128;
    let q = n / inc;
    let rem = n % inc;
    let up = if rem == 0 {
        false
    } else {
        let twice = rem * 2;
        let ord = twice.cmp(&inc);
        use std::cmp::Ordering::*;
        match mode {
            RoundingMode::Ceil => !negative,
            RoundingMode::Floor => negative,
            RoundingMode::Expand => true,
            RoundingMode::Trunc => false,
            RoundingMode::HalfCeil => matches!(ord, Greater) || (ord == Equal && !negative),
            RoundingMode::HalfFloor => matches!(ord, Greater) || (ord == Equal && negative),
            RoundingMode::HalfExpand => matches!(ord, Greater | Equal),
            RoundingMode::HalfTrunc => matches!(ord, Greater),
            RoundingMode::HalfEven => {
                matches!(ord, Greater) || (ord == Equal && (q % 2 == 1))
            }
        }
    };
    let result = (q + if up { 1 } else { 0 }) * inc;
    // Lay `result` back out with `max_frac` fraction places.
    let mut s = result.to_string();
    while (s.len() as u32) <= max_frac {
        s.insert(0, '0');
    }
    let split = s.len() - max_frac as usize;
    let int_digits = s[..split].to_string();
    let frac_digits = s[split..].to_string();
    Rendered {
        int_digits,
        frac_digits,
    }
}

/// ToRawPrecision: round `dec` to at most `max_sig` significant digits, keep at
/// least `min_sig`, honoring `trailing_zero_display`.
fn to_raw_precision(
    dec: &Decimal,
    min_sig: u32,
    max_sig: u32,
    mode: RoundingMode,
    negative: bool,
    trailing_zero: TrailingZeroDisplay,
) -> Rendered {
    let rounded = round_to_significant(dec, max_sig as usize, mode, negative);
    // Determine how many of the max_sig digits to actually show: strip trailing
    // zeros down to min_sig significant digits.
    let mut significant = max_sig as usize;
    while significant > min_sig as usize
        && rounded.digits.get(significant - 1).copied().unwrap_or(0) == 0
    {
        significant -= 1;
    }
    // Build a Decimal with just the shown significant digits.
    let shown = Decimal {
        digits: rounded.digits[..significant.min(rounded.digits.len())].to_vec(),
        exponent: rounded.exponent,
    };
    // The number of fraction places is max(0, significant-1 - exponent).
    let frac_places = (significant as i32 - 1 - shown.exponent).max(0) as u32;
    let mut r = layout_fixed(
        &Decimal {
            digits: {
                let mut d = shown.digits.clone();
                d.resize(significant, 0);
                d
            },
            exponent: shown.exponent,
        },
        frac_places,
    );
    if trailing_zero == TrailingZeroDisplay::StripIfInteger
        && r.frac_digits.bytes().all(|b| b == b'0')
    {
        r.frac_digits.clear();
    }
    r
}

/// Trim a fixed fraction string down to `min_frac` digits (dropping trailing
/// zeros beyond the floor), applying stripIfInteger.
fn trim_fraction(
    frac: &mut String,
    min_frac: usize,
    trailing_zero: TrailingZeroDisplay,
    int_digits: &str,
) {
    while frac.len() > min_frac && frac.ends_with('0') {
        frac.pop();
    }
    if trailing_zero == TrailingZeroDisplay::StripIfInteger
        && frac.bytes().all(|b| b == b'0')
        && !int_digits.is_empty()
    {
        frac.clear();
    }
}

/// The compact scaling decision: the power of ten to divide by and the CLDR
/// affix (prefix, suffix) for the chosen magnitude in the given locale.
/// Reserved for the compact-notation follow-up child.
#[allow(dead_code)]
struct Compact {
    divisor_pow10: i32,
    prefix: String,
    suffix: String,
}

/// The ten digits of a numbering system, as the code points that replace the
/// latin `0`..=`9`. Only the systems the pinned test corpus exercises are
/// modeled; an unmodeled system falls back to latin.
fn numbering_digits(nu: &str) -> Option<[&'static str; 10]> {
    Some(match nu {
        "latn" => ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"],
        "arab" => ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"],
        "arabext" => ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"],
        "beng" => ["০", "১", "২", "৩", "৪", "৫", "৬", "৭", "৮", "৯"],
        "deva" => ["०", "१", "२", "३", "४", "५", "६", "७", "८", "९"],
        "thai" => ["๐", "๑", "๒", "๓", "๔", "๕", "๖", "๗", "๘", "๙"],
        "hanidec" => ["〇", "一", "二", "三", "四", "五", "六", "七", "八", "九"],
        "fullwide" => ["０", "１", "２", "３", "４", "５", "６", "７", "８", "９"],
        _ => return None,
    })
}

/// Map an ASCII digit string to the numbering system's digits.
fn map_digits(ascii: &str, nu: &str) -> String {
    match numbering_digits(nu) {
        None => ascii.to_string(),
        Some(map) => {
            let mut out = String::new();
            for b in ascii.bytes() {
                if b.is_ascii_digit() {
                    out.push_str(map[(b - b'0') as usize]);
                } else {
                    out.push(b as char);
                }
            }
            out
        }
    }
}

/// The decimal separator for a locale (used between integer and fraction).
fn decimal_separator(locale: &str) -> &'static str {
    if locale_uses_comma_decimal(locale) {
        ","
    } else {
        "."
    }
}

/// The grouping separator for a locale.
fn group_separator(locale: &str) -> &'static str {
    let lang = locale_language(locale);
    if locale_uses_comma_decimal(locale) {
        // de-DE etc. group with '.' (and a few with the narrow no-break space,
        // not exercised by the corpus).
        "."
    } else if lang == "en" || lang == "ja" || lang == "ko" || lang == "zh" {
        ","
    } else {
        ","
    }
}

/// True for locales that write the decimal point as a comma (de, fr, es, it,
/// ...). Only the corpus-relevant set is modeled precisely.
fn locale_uses_comma_decimal(locale: &str) -> bool {
    matches!(
        locale_language(locale).as_str(),
        "de" | "fr" | "es" | "it" | "nl" | "pt" | "ru" | "tr"
    )
}

/// The primary language subtag of a BCP-47 tag, lowercased.
fn locale_language(locale: &str) -> String {
    locale
        .split(['-', '_'])
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
}

/// The region subtag (uppercased) if present.
fn locale_region(locale: &str) -> Option<String> {
    for part in locale.split(['-', '_']).skip(1) {
        if part.len() == 2 && part.bytes().all(|b| b.is_ascii_alphabetic()) {
            return Some(part.to_ascii_uppercase());
        }
    }
    None
}

/// The primary grouping size and secondary grouping size for a locale. Most
/// locales use (3, 3); the Indian English locale uses (3, 2) — `1,00,000`.
fn grouping_sizes(locale: &str) -> (usize, usize) {
    if locale_language(locale) == "en" && locale_region(locale).as_deref() == Some("IN") {
        (3, 2)
    } else {
        (3, 3)
    }
}

/// Insert grouping separators into an integer digit string per the locale's
/// primary/secondary group sizes, returning the `(digit-run, separator)` parts
/// interleaved as `Part`s of type `integer`/`group`. The `sep` is the raw
/// separator string (already numbering-mapped is not needed — separators are
/// literal).
fn group_integer(int_digits: &str, primary: usize, secondary: usize, sep: &str, nu: &str) -> Vec<Part> {
    let bytes: Vec<u8> = int_digits.bytes().collect();
    let n = bytes.len();
    // Compute the byte positions (from the right) at which a group boundary
    // falls. The first boundary is after `primary` digits; each subsequent one
    // after `secondary` more.
    let mut boundaries = Vec::new();
    let mut pos = primary;
    while pos < n {
        boundaries.push(n - pos);
        pos += secondary;
    }
    boundaries.reverse();
    let mut parts = Vec::new();
    let mut start = 0;
    for &b in &boundaries {
        let run = std::str::from_utf8(&bytes[start..b]).unwrap();
        parts.push(Part::new(PartType::Integer, map_digits(run, nu)));
        parts.push(Part::new(PartType::Group, sep));
        start = b;
    }
    let run = std::str::from_utf8(&bytes[start..]).unwrap();
    parts.push(Part::new(PartType::Integer, map_digits(run, nu)));
    parts
}

/// Whether grouping should be applied for this integer length under the
/// resolved grouping mode.
fn should_group(grouping: Grouping, int_digit_count: usize, notation: Notation) -> bool {
    match grouping {
        Grouping::Never => false,
        // Notation `compact`/`scientific`/`engineering` never group unless
        // explicitly `always` — the mantissa is below the group threshold.
        Grouping::Always => int_digit_count > 3 || notation == Notation::Standard && int_digit_count > 3,
        Grouping::Auto => notation == Notation::Standard && int_digit_count > 3,
        Grouping::Min2 => notation == Notation::Standard && int_digit_count > 4,
    }
}

/// Resolve the display sign for a value under signDisplay/currencySign.
/// Returns `Some(true)` for a minus, `Some(false)` for a plus, `None` for no
/// sign.
fn resolve_sign(sign_display: SignDisplay, negative: bool, is_zero: bool) -> Option<bool> {
    match sign_display {
        SignDisplay::Auto => negative.then_some(true),
        SignDisplay::Never => None,
        SignDisplay::Always => Some(negative),
        SignDisplay::ExceptZero => {
            if is_zero {
                None
            } else {
                Some(negative)
            }
        }
        SignDisplay::Negative => (negative && !is_zero).then_some(true),
    }
}

/// The default digit-option bounds a decimal/percent number uses when the user
/// supplied none.
fn effective_bounds(opts: &NfResolved) -> (u32, u32) {
    (opts.min_fraction_digits, opts.max_fraction_digits)
}

/// Format the magnitude of `dec` (already non-negative, notation-scaled) into
/// integer/fraction ASCII strings using the resolved rounding.
fn render_magnitude(opts: &NfResolved, dec: &Decimal, negative: bool) -> Rendered {
    match opts.rounding_type {
        RoundingType::SignificantDigits => to_raw_precision(
            dec,
            opts.min_significant_digits.unwrap_or(1),
            opts.max_significant_digits.unwrap_or(21),
            opts.rounding_mode,
            negative,
            opts.trailing_zero_display,
        ),
        RoundingType::FractionDigits => {
            let (mnf, mxf) = effective_bounds(opts);
            to_raw_fixed(
                dec,
                mnf,
                mxf,
                opts.rounding_mode,
                negative,
                opts.rounding_increment,
                opts.trailing_zero_display,
            )
        }
        RoundingType::MorePrecision | RoundingType::LessPrecision => {
            // Compute both and pick per the priority.
            let frac = {
                let (mnf, mxf) = effective_bounds(opts);
                to_raw_fixed(
                    dec,
                    mnf,
                    mxf,
                    opts.rounding_mode,
                    negative,
                    opts.rounding_increment,
                    opts.trailing_zero_display,
                )
            };
            let sig = to_raw_precision(
                dec,
                opts.min_significant_digits.unwrap_or(1),
                opts.max_significant_digits.unwrap_or(21),
                opts.rounding_mode,
                negative,
                opts.trailing_zero_display,
            );
            let frac_places = frac.frac_digits.len();
            let sig_places = sig.frac_digits.len();
            let pick_more = frac_places >= sig_places;
            let more = if pick_more { &frac } else { &sig };
            let less = if pick_more { &sig } else { &frac };
            let chosen = match opts.rounding_type {
                RoundingType::MorePrecision => more,
                _ => less,
            };
            Rendered {
                int_digits: chosen.int_digits.clone(),
                frac_digits: chosen.frac_digits.clone(),
            }
        }
    }
}

/// Compute the notation exponent for `dec` (non-zero), returning the power of
/// ten to divide the value by before rendering the mantissa.
fn compute_notation_exponent(opts: &NfResolved, dec: &Decimal) -> i32 {
    match opts.notation {
        Notation::Standard | Notation::Compact => 0,
        Notation::Scientific => dec.exponent,
        Notation::Engineering => dec.exponent - dec.exponent.rem_euclid(3),
    }
}

/// Partition a finite number into typed parts (PartitionNumberPattern, the
/// number portion; affixes for currency/unit are layered by the caller). This
/// covers decimal, percent, scientific and engineering; the mantissa is scaled
/// then rendered, and the exponent (if any) appended.
pub fn partition_number(opts: &NfResolved, x: f64) -> Vec<Part> {
    // NaN carries no numeric sign; every other value's sign follows its sign
    // bit (so `-0` is negative).
    let negative = x.is_sign_negative() && !x.is_nan();

    // Build the number body (no sign) and learn whether the *rounded* value is
    // zero — `signDisplay: exceptZero`/`negative` suppress the sign for a value
    // that rounds to zero (`-0.0001` → `0`), while `auto`/`always` follow the
    // mathematical sign regardless of rounding.
    let (mut body, rounded_is_zero) = number_body_parts(opts, x, negative);

    let sign = if x.is_nan() {
        // Only `signDisplay: always` prepends a plus to NaN.
        matches!(opts.sign_display, SignDisplay::Always).then_some(false)
    } else {
        resolve_sign(opts.sign_display, negative, rounded_is_zero)
    };

    let mut parts = Vec::new();
    if let Some(minus) = sign {
        parts.push(Part::new(
            if minus {
                PartType::MinusSign
            } else {
                PartType::PlusSign
            },
            if minus { "-" } else { "+" },
        ));
    }
    parts.append(&mut body);
    parts
}

/// Build the unsigned number-body parts (integer/group/decimal/fraction/
/// exponent, or the NaN/Infinity token, plus the percent suffix) and report
/// whether the rounded magnitude is zero.
fn number_body_parts(opts: &NfResolved, x: f64, negative: bool) -> (Vec<Part>, bool) {
    let mut parts = Vec::new();

    if x.is_nan() {
        parts.push(Part::new(PartType::Nan, "NaN"));
        return (with_percent_suffix(opts, parts), false);
    }

    let value = x.abs();
    if value.is_infinite() {
        parts.push(Part::new(PartType::Infinity, "∞"));
        return (with_percent_suffix(opts, parts), false);
    }

    finite_body_parts(opts, Decimal::from_f64(value), negative)
}

/// Build the body for an exact finite decimal magnitude. Keeping this path
/// independent of `f64` lets BigInt locale formatting preserve every digit.
fn finite_body_parts(
    opts: &NfResolved,
    mut dec: Decimal,
    negative: bool,
) -> (Vec<Part>, bool) {
    let mut parts = Vec::new();
    if opts.style == Style::Percent {
        dec.scale_pow10(2);
    }
    let original = dec.clone();
    let notation_exp = if dec.is_zero() {
        0
    } else {
        compute_notation_exponent(opts, &dec)
    };
    if notation_exp != 0 {
        dec.scale_pow10(-notation_exp);
    }

    let mut rendered = render_magnitude(opts, &dec, negative);

    // A mantissa that rounded up past its notation window (e.g. scientific
    // 9.99→10) bumps the exponent and re-scales.
    let mut notation_exp = notation_exp;
    if opts.notation == Notation::Scientific && rendered.int_digits.len() > 1 {
        notation_exp += rendered.int_digits.len() as i32 - 1;
        let mut d2 = original;
        d2.scale_pow10(-notation_exp);
        rendered = render_magnitude(opts, &d2, negative);
    }

    // Enforce minimum integer digits.
    while (rendered.int_digits.len() as u32) < opts.min_integer_digits {
        rendered.int_digits.insert(0, '0');
    }

    let rounded_is_zero = rendered.int_digits.bytes().all(|b| b == b'0')
        && rendered.frac_digits.bytes().all(|b| b == b'0');

    let nu = &opts.numbering_system;
    let (primary, secondary) = grouping_sizes(&opts.locale);
    if should_group(opts.grouping, rendered.int_digits.len(), opts.notation) {
        let sep = group_separator(&opts.locale);
        parts.extend(group_integer(
            &rendered.int_digits,
            primary,
            secondary,
            sep,
            nu,
        ));
    } else {
        parts.push(Part::new(
            PartType::Integer,
            map_digits(&rendered.int_digits, nu),
        ));
    }

    if !rendered.frac_digits.is_empty() {
        parts.push(Part::new(PartType::Decimal, decimal_separator(&opts.locale)));
        parts.push(Part::new(
            PartType::Fraction,
            map_digits(&rendered.frac_digits, nu),
        ));
    }

    // Exponent for scientific/engineering.
    if matches!(opts.notation, Notation::Scientific | Notation::Engineering) {
        parts.push(Part::new(PartType::ExponentSeparator, "E"));
        if notation_exp < 0 {
            parts.push(Part::new(PartType::ExponentMinusSign, "-"));
        }
        let exp_digits = notation_exp.unsigned_abs().to_string();
        parts.push(Part::new(
            PartType::ExponentInteger,
            map_digits(&exp_digits, nu),
        ));
    }

    (with_percent_suffix(opts, parts), rounded_is_zero)
}

/// Partition an exact BigInt magnitude into locale-aware parts.
fn partition_bigint(opts: &NfResolved, negative: bool, digits: &str) -> Vec<Part> {
    let dec = Decimal::from_integer_ascii(digits);
    let is_zero = dec.is_zero();
    let (mut body, rounded_is_zero) = finite_body_parts(opts, dec, negative);
    let sign = resolve_sign(opts.sign_display, negative && !is_zero, rounded_is_zero);
    let mut parts = Vec::new();
    if let Some(minus) = sign {
        parts.push(Part::new(
            if minus {
                PartType::MinusSign
            } else {
                PartType::PlusSign
            },
            if minus { "-" } else { "+" },
        ));
    }
    parts.append(&mut body);
    parts
}

/// Append the percent sign for a percent-style number (en/latin placement:
/// suffix with no space).
fn with_percent_suffix(opts: &NfResolved, mut parts: Vec<Part>) -> Vec<Part> {
    if opts.style == Style::Percent {
        parts.push(Part::new(PartType::PercentSign, "%"));
    }
    parts
}

/// Format a finite-or-not number to its display string.
pub fn format_to_string(opts: &NfResolved, x: f64) -> String {
    partition_number(opts, x)
        .into_iter()
        .map(|p| p.value)
        .collect()
}

/// Format an exact BigInt magnitude without narrowing through `f64`.
pub fn format_bigint_to_string(opts: &NfResolved, negative: bool, digits: &str) -> String {
    partition_bigint(opts, negative, digits)
        .into_iter()
        .map(|part| part.value)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decimal(locale: &str) -> NfResolved {
        NfResolved {
            locale: locale.to_string(),
            numbering_system: "latn".to_string(),
            style: Style::Decimal,
            notation: Notation::Standard,
            compact_display: CompactDisplay::Short,
            sign_display: SignDisplay::Auto,
            grouping: Grouping::Auto,
            currency: None,
            currency_display: CurrencyDisplay::Symbol,
            currency_sign: CurrencySign::Standard,
            unit: None,
            unit_display: UnitDisplay::Short,
            min_integer_digits: 1,
            min_fraction_digits: 0,
            max_fraction_digits: 3,
            min_significant_digits: None,
            max_significant_digits: None,
            rounding_type: RoundingType::FractionDigits,
            rounding_increment: 1,
            rounding_mode: RoundingMode::HalfExpand,
            trailing_zero_display: TrailingZeroDisplay::Auto,
        }
    }

    #[test]
    fn decimal_grouping_en_us() {
        let f = decimal("en-US");
        assert_eq!(format_to_string(&f, 12345.678), "12,345.678");
        assert_eq!(format_to_string(&f, 1000.0), "1,000");
        assert_eq!(format_to_string(&f, 100.0), "100");
        assert_eq!(format_to_string(&f, -1.0), "-1");
        assert_eq!(format_to_string(&f, 0.0), "0");
    }

    #[test]
    fn decimal_grouping_de_de() {
        let f = decimal("de-DE");
        assert_eq!(format_to_string(&f, 12345.678), "12.345,678");
        assert_eq!(format_to_string(&f, 1000.0), "1.000");
    }

    #[test]
    fn decimal_grouping_en_in() {
        let f = decimal("en-IN");
        assert_eq!(format_to_string(&f, 100000.0), "1,00,000");
        assert_eq!(format_to_string(&f, 10000.0), "10,000");
        assert_eq!(format_to_string(&f, 1000.0), "1,000");
    }

    #[test]
    fn bigint_formatting_preserves_all_digits() {
        let mut f = decimal("en-IN");
        assert_eq!(
            format_bigint_to_string(&f, false, "123456789012345678901234567890"),
            "1,23,45,67,89,01,23,45,67,89,01,23,45,67,890",
        );
        assert_eq!(
            format_bigint_to_string(&f, true, "123456789012345678901234567890"),
            "-1,23,45,67,89,01,23,45,67,89,01,23,45,67,890",
        );
        f.numbering_system = "thai".to_string();
        assert_eq!(
            format_bigint_to_string(&f, false, "12345678901234567890"),
            "๑,๒๓,๔๕,๖๗,๘๙,๐๑,๒๓,๔๕,๖๗,๘๙๐",
        );
    }

    #[test]
    fn negative_zero_and_signdisplay() {
        let mut f = decimal("en-US");
        f.sign_display = SignDisplay::Always;
        assert_eq!(format_to_string(&f, 987.0), "+987");
        assert_eq!(format_to_string(&f, -987.0), "-987");
        assert_eq!(format_to_string(&f, 0.0), "+0");
        assert_eq!(format_to_string(&f, -0.0), "-0");
        f.sign_display = SignDisplay::ExceptZero;
        assert_eq!(format_to_string(&f, 0.0), "0");
        // A value that rounds to zero is treated as zero: no sign under
        // exceptZero (even though -0.0001 is mathematically negative).
        assert_eq!(format_to_string(&f, -0.0001), "0");
        assert_eq!(format_to_string(&f, 0.0001), "0");
        // A non-zero-rounding value still gets its sign.
        assert_eq!(format_to_string(&f, -0.5), "-0.5");
        assert_eq!(format_to_string(&f, 0.5), "+0.5");
    }

    #[test]
    fn percent() {
        let mut f = decimal("en-US");
        f.style = Style::Percent;
        assert_eq!(format_to_string(&f, 0.20), "20%");
        assert_eq!(format_to_string(&f, 0.011), "1.1%");
    }

    #[test]
    fn significant_digits() {
        let mut f = decimal("en-US");
        f.grouping = Grouping::Never;
        f.rounding_type = RoundingType::SignificantDigits;
        f.min_significant_digits = Some(3);
        f.max_significant_digits = Some(5);
        assert_eq!(format_to_string(&f, 0.0), "0.00");
        assert_eq!(format_to_string(&f, 123.0), "123");
        assert_eq!(format_to_string(&f, 123.45), "123.45");
        assert_eq!(format_to_string(&f, 123.44499), "123.44");
        assert_eq!(format_to_string(&f, 123.44501), "123.45");
        assert_eq!(format_to_string(&f, 1.2), "1.20");
        assert_eq!(format_to_string(&f, 123445.01), "123450");
        assert_eq!(
            format_to_string(&f, 12344501000000000000000000000000000.0),
            "12345000000000000000000000000000000"
        );
    }

    #[test]
    fn rounding_modes() {
        let mut f = decimal("en-US");
        f.max_fraction_digits = 0;
        f.min_fraction_digits = 0;
        for (mode, up, down) in [
            (RoundingMode::Ceil, "3", "-2"),
            (RoundingMode::Floor, "2", "-3"),
            (RoundingMode::Expand, "3", "-3"),
            (RoundingMode::Trunc, "2", "-2"),
        ] {
            f.rounding_mode = mode;
            assert_eq!(format_to_string(&f, 2.5), up, "{mode:?} +");
            assert_eq!(format_to_string(&f, -2.5), down, "{mode:?} -");
        }
        f.rounding_mode = RoundingMode::HalfEven;
        assert_eq!(format_to_string(&f, 2.5), "2");
        assert_eq!(format_to_string(&f, 3.5), "4");
    }

    #[test]
    fn scientific_and_engineering() {
        let mut sci = decimal("en-US");
        sci.notation = Notation::Scientific;
        assert_eq!(format_to_string(&sci, 0.000345), "3.45E-4");
        assert_eq!(format_to_string(&sci, 3.45), "3.45E0");
        assert_eq!(format_to_string(&sci, 34.5), "3.45E1");
        assert_eq!(format_to_string(&sci, 543.0), "5.43E2");
        assert_eq!(format_to_string(&sci, 543211.1), "5.432E5");
        let mut eng = decimal("en-US");
        eng.notation = Notation::Engineering;
        assert_eq!(format_to_string(&eng, 0.000345), "345E-6");
        assert_eq!(format_to_string(&eng, 34.5), "34.5E0");
        assert_eq!(format_to_string(&eng, 543.0), "543E0");
        assert_eq!(format_to_string(&eng, 5430.0), "5.43E3");
        assert_eq!(format_to_string(&eng, 543211.1), "543.211E3");
    }

    #[test]
    fn rounding_increment() {
        let mut f = decimal("en-US");
        f.max_fraction_digits = 2;
        f.min_fraction_digits = 2;
        f.rounding_increment = 5;
        // Round to a multiple of 0.05.
        assert_eq!(format_to_string(&f, 1.23), "1.25");
        assert_eq!(format_to_string(&f, 1.22), "1.20");
    }
}
