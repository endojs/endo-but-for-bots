//! Intl instance records and retained locale tables.
#[cfg(doc)]
use super::Interp;

// Generated locked ICU profile, also included in the boot fingerprint.
// Intl never consults host locale or a dynamically updated database.
pub(super) use crate::intl_profile::INTL_DATA_VERSION;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocaleData {
    pub tag: String,
    pub language: String,
    pub script: Option<String>,
    pub region: Option<String>,
    pub variants: Vec<String>,
    pub unicode: std::collections::BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CollatorData {
    pub locale: String,
    pub usage: String,
    pub sensitivity: String,
    pub collation: String,
    pub numeric: bool,
    pub case_first: String,
    pub ignore_punctuation: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListFormatData {
    pub locale: String,
    /// `conjunction` | `disjunction` | `unit`
    pub kind: String,
    /// `long` | `short` | `narrow`
    pub style: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluralRulesData {
    pub locale: String,
    /// `cardinal` | `ordinal`
    pub kind: String,
    /// `standard` | `scientific` | `engineering` | `compact`
    pub notation: String,
    pub minimum_integer_digits: u32,
    pub minimum_fraction_digits: u32,
    pub maximum_fraction_digits: u32,
    pub minimum_significant_digits: Option<u32>,
    pub maximum_significant_digits: Option<u32>,
    /// `fractionDigits` | `significantDigits` | `morePrecision` | `lessPrecision`
    pub rounding_type: String,
    /// `auto` | `morePrecision` | `lessPrecision`
    pub rounding_priority: String,
    pub rounding_mode: String,
    pub rounding_increment: u32,
    /// `auto` | `stripIfInteger`
    pub trailing_zero_display: String,
}

/// The resolved internal slots of an `Intl.NumberFormat`. The digit-option
/// fields mirror `PluralRulesData` (both are populated by
/// `set_number_digit_options`); the remaining fields carry the
/// style/currency/unit/notation/sign/grouping resolution.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NumberFormatData {
    pub locale: String,
    pub numbering_system: String,
    /// `decimal` | `percent` | `currency` | `unit`
    pub style: String,
    /// `standard` | `scientific` | `engineering` | `compact`
    pub notation: String,
    /// `short` | `long`
    pub compact_display: String,
    /// `auto` | `always` | `never` | `exceptZero` | `negative`
    pub sign_display: String,
    /// `always` | `auto` | `min2` | `false`
    pub use_grouping: String,
    pub currency: Option<String>,
    /// `symbol` | `narrowSymbol` | `code` | `name`
    pub currency_display: String,
    /// `standard` | `accounting`
    pub currency_sign: String,
    pub unit: Option<String>,
    /// `short` | `narrow` | `long`
    pub unit_display: String,
    pub minimum_integer_digits: u32,
    pub minimum_fraction_digits: u32,
    pub maximum_fraction_digits: u32,
    pub minimum_significant_digits: Option<u32>,
    pub maximum_significant_digits: Option<u32>,
    pub rounding_type: String,
    pub rounding_priority: String,
    pub rounding_mode: String,
    pub rounding_increment: u32,
    pub trailing_zero_display: String,
    /// The lazily-created, cached `[[BoundFormat]]` function (the `format`
    /// getter returns the same function on every read). Reserved for the
    /// accessor-getter follow-up; the current `format` is a plain method.
    #[allow(dead_code)]
    pub bound_format: Option<crate::value::SlotIndex>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SegmenterData {
    pub locale: String,
    /// `grapheme` | `word` | `sentence`
    pub granularity: String,
}

/// One `%Segments%` object (the result of `segmenter.segment(string)`): the
/// input's UTF-16 code units, the precomputed boundary segments, and the
/// granularity carried for `isWordLike`. Segmentation is deterministic over the
/// pinned `icu_segmenter` Unicode data, so precomputing the whole list at
/// `segment()` time is equivalent to the spec's lazy FindBoundary and lets both
/// iteration and `containing` share one immutable result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SegmentsData {
    pub units: Vec<u16>,
    /// Each `(start, end, is_word_like)` in UTF-16 code-unit offsets.
    pub segments: Vec<(usize, usize, bool)>,
    /// `grapheme` | `word` | `sentence` — only `word` exposes `isWordLike`.
    pub granularity: String,
}

/// One `%SegmentIterator%` — a cursor into a `%Segments%` object's precomputed
/// list (the segment index to yield next).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SegmentIteratorData {
    pub segments_inst: crate::value::SlotIndex,
    pub pos: usize,
}

/// One `Intl.DateTimeFormat` object's resolved options. The frozen profile
/// carries the proleptic Gregorian calendar and a fixed offset time-zone
/// table; formatting is deterministic and host-independent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DateTimeFormatData {
    pub locale: String,
    pub calendar: String,
    pub numbering_system: String,
    /// The resolved IANA time-zone name (canonicalized).
    pub time_zone: String,
    /// Minutes east of UTC for the resolved zone (the frozen table is
    /// fixed-offset: UTC and the `Etc/GMT±N` / numeric-offset zones).
    pub offset_minutes: i32,
    pub hour_cycle: Option<String>,
    /// Each present component's resolved representation, in resolvedOptions
    /// enumeration order. `(key, value)` e.g. `("year","numeric")`.
    pub components: Vec<(&'static str, String)>,
    pub date_style: Option<String>,
    pub time_style: Option<String>,
}

/// The nine Intl DATA record tables of one machine, each ascending by
/// owning slot — the ledger `IntlRecords` row as
/// [`Interp::intl_snapshot`] emits it and [`crate::RestoreSession::restore_intl`]
/// reinstates it. Pure resolved-options data; the bound-function link
/// satellites (`collator_compare_functions`,
/// `number_format_bound_functions`) are deliberately absent — a minted
/// bound function is a `functions` (`FuncInfo`) row, the Pending
/// dependency — and both getters re-mint on a cache miss, so dropping
/// the caches at the boundary is first-access behavior, not loss.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct IntlTables {
    pub locales: Vec<(u32, LocaleData)>,
    pub collators: Vec<(u32, CollatorData)>,
    pub list_formats: Vec<(u32, ListFormatData)>,
    pub plural_rules: Vec<(u32, PluralRulesData)>,
    pub number_formats: Vec<(u32, NumberFormatData)>,
    pub segmenters: Vec<(u32, SegmenterData)>,
    pub segments: Vec<(u32, SegmentsData)>,
    pub segment_iterators: Vec<(u32, SegmentIteratorData)>,
    pub date_time_formats: Vec<(u32, DateTimeFormatData)>,
}

impl IntlTables {
    /// Whether every table is empty (the atom is emitted only when not).
    pub fn is_empty(&self) -> bool {
        self.locales.is_empty()
            && self.collators.is_empty()
            && self.list_formats.is_empty()
            && self.plural_rules.is_empty()
            && self.number_formats.is_empty()
            && self.segmenters.is_empty()
            && self.segments.is_empty()
            && self.segment_iterators.is_empty()
            && self.date_time_formats.is_empty()
    }
}
