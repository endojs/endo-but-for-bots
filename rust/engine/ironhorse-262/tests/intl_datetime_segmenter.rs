//! Oracle-backed regressions for `Intl.DateTimeFormat` and `Intl.Segmenter`
//! (child 21). The pinned Moddable XS oracle carries no ECMA-402 host, so each
//! case is proven by requiring Ironhorse to run it to completion
//! (`IronhorseOnlyComplete`) with the exact result while the oracle reports the
//! missing `Intl` binding — the host-only-exclusion shape `intl_core.rs` and
//! `intl_formatters.rs` established. Time-zone/calendar formatting is
//! deterministic over the frozen proleptic-Gregorian + fixed-offset profile;
//! grapheme/word/sentence segmentation is deterministic over the pinned
//! `icu_segmenter` Unicode data.

use ironhorse_262::{dual_run, Agreement};

/// Assert Ironhorse completes `source` with `expected`, the oracle lacking Intl.
fn intl_result(source: &str, expected: &str) {
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(
        run.agreement,
        Agreement::IronhorseOnlyComplete,
        "the pinned XS oracle has no Intl host; Ironhorse must complete `{source}` (halt: {:?})",
        run.ironhorse_halt,
    );
    assert_eq!(
        run.oracle_error, "ReferenceError: get Intl: undefined variable",
        "the host-only exclusion must stay exact",
    );
    assert_eq!(run.ironhorse_result, expected, "for `{source}`");
}

/// Assert `source` aborts on Ironhorse with the named error constructor. The
/// pinned oracle throws its own `ReferenceError` for the missing `Intl`, so the
/// two abort with different values (`BothAbort`); the point is that Ironhorse
/// rejects the input at the ECMA-402 validation step rather than over-accepting.
fn intl_throws(source: &str, error_name: &str) {
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(
        run.ironhorse_error, error_name,
        "Ironhorse must reject `{source}` with a {error_name}",
    );
    assert!(
        run.oracle_error.contains("Intl"),
        "the oracle's abort must be the missing-Intl reference error, not `{}`",
        run.oracle_error,
    );
}

// --------------------------- DateTimeFormat ---------------------------

#[test]
fn date_time_format_default_and_styles_are_exact() {
    for (source, expected) in [
        // Default option set: numeric year/month/day, en-US slash order, UTC.
        (
            "new Intl.DateTimeFormat('en',{timeZone:'UTC'}).format(0)",
            "1/1/1970",
        ),
        // dateStyle expansions.
        (
            "new Intl.DateTimeFormat('en',{timeZone:'UTC',dateStyle:'medium'}).format(0)",
            "Jan 1, 1970",
        ),
        (
            "new Intl.DateTimeFormat('en',{timeZone:'UTC',dateStyle:'long'}).format(0)",
            "January 1, 1970",
        ),
        (
            "new Intl.DateTimeFormat('en',{timeZone:'UTC',dateStyle:'full'}).format(0)",
            "Thursday, January 1, 1970",
        ),
        // Explicit named-month components.
        (
            "new Intl.DateTimeFormat('en',{timeZone:'UTC',weekday:'long',year:'numeric',month:'long',day:'numeric'}).format(0)",
            "Thursday, January 1, 1970",
        ),
        // 2-digit fields.
        (
            "new Intl.DateTimeFormat('en',{timeZone:'UTC',year:'2-digit',month:'2-digit',day:'2-digit'}).format(0)",
            "01/01/70",
        ),
    ] {
        intl_result(source, expected);
    }
}

#[test]
fn date_time_format_time_and_hour_cycle_are_exact() {
    for (source, expected) in [
        // 12-hour with day period (the en default cycle).
        (
            "new Intl.DateTimeFormat('en',{timeZone:'UTC',hour:'numeric',minute:'2-digit',second:'2-digit'}).format(0)",
            "12:00:00 AM",
        ),
        // Forced 24-hour clock.
        (
            "new Intl.DateTimeFormat('en',{timeZone:'UTC',hour:'2-digit',minute:'2-digit',hour12:false}).format(0)",
            "00:00",
        ),
        // A non-zero instant, offset zone applied (2001-09-09T01:46:40Z).
        (
            "new Intl.DateTimeFormat('en',{timeZone:'UTC',hour:'numeric',minute:'2-digit',hour12:false}).format(1e12)",
            "1:46",
        ),
        // Fixed +05:30 offset shifts the wall clock forward.
        (
            "new Intl.DateTimeFormat('en',{timeZone:'+05:30',hour:'2-digit',minute:'2-digit',hour12:false}).format(0)",
            "05:30",
        ),
    ] {
        intl_result(source, expected);
    }
}

#[test]
fn date_time_format_hour_cycle_resolution_is_exact() {
    for (source, expected) in [
        (
            "new Intl.DateTimeFormat('en',{hour:'numeric',hour12:false}).resolvedOptions().hourCycle",
            "h23",
        ),
        (
            "new Intl.DateTimeFormat('en',{hour:'numeric',hour12:true}).resolvedOptions().hourCycle",
            "h12",
        ),
        (
            "new Intl.DateTimeFormat('ja',{hour:'numeric',hour12:true}).resolvedOptions().hourCycle",
            "h11",
        ),
        (
            "new Intl.DateTimeFormat('en',{hour:'numeric'}).resolvedOptions().hour12",
            "true",
        ),
    ] {
        intl_result(source, expected);
    }
}

#[test]
fn date_time_format_resolved_options_are_exact() {
    for (source, expected) in [
        (
            "new Intl.DateTimeFormat('en',{timeZone:'UTC'}).resolvedOptions().timeZone",
            "UTC",
        ),
        (
            "new Intl.DateTimeFormat('en').resolvedOptions().calendar",
            "gregory",
        ),
        (
            "new Intl.DateTimeFormat('en').resolvedOptions().numberingSystem",
            "latn",
        ),
        (
            "new Intl.DateTimeFormat('en',{calendar:'gregory'}).resolvedOptions().calendar",
            "gregory",
        ),
        // resolvedOptions property order: locale precedes timeZone precedes day.
        (
            "var o=new Intl.DateTimeFormat('en',{timeZone:'UTC'}).resolvedOptions(); var k=Object.keys(o); (k.indexOf('locale')<k.indexOf('timeZone'))+','+(k.indexOf('timeZone')<k.indexOf('day'))",
            "true,true",
        ),
    ] {
        intl_result(source, expected);
    }
}

#[test]
fn date_time_format_time_zone_canonicalization_is_exact() {
    for (source, expected) in [
        (
            "new Intl.DateTimeFormat('en',{timeZone:'america/new_york'}).resolvedOptions().timeZone",
            "America/New_York",
        ),
        (
            "new Intl.DateTimeFormat('en',{timeZone:'+05:30'}).resolvedOptions().timeZone",
            "+05:30",
        ),
        (
            "new Intl.DateTimeFormat('en',{timeZone:'Etc/GMT+5'}).resolvedOptions().timeZone",
            "Etc/GMT+5",
        ),
    ] {
        intl_result(source, expected);
    }
    // An unknown time zone is a RangeError.
    intl_throws(
        "new Intl.DateTimeFormat('en',{timeZone:'Not/AZone'})",
        "RangeError",
    );
}

#[test]
fn date_time_format_parts_and_range_are_exact() {
    for (source, expected) in [
        // formatToParts is consistent with format (same concatenation).
        (
            "var f=new Intl.DateTimeFormat('en',{timeZone:'UTC'}); f.formatToParts(0).map(p=>p.value).join('')===f.format(0)",
            "true",
        ),
        // The part types for the default date.
        (
            "JSON.stringify(new Intl.DateTimeFormat('en',{timeZone:'UTC'}).formatToParts(0).map(p=>p.type))",
            "[\"month\",\"literal\",\"day\",\"literal\",\"year\"]",
        ),
        // formatRange over two equal instants shares every part (source shared).
        (
            "new Intl.DateTimeFormat('en',{timeZone:'UTC'}).formatRangeToParts(0,0).every(p=>p.source==='shared')",
            "true",
        ),
        // formatRange over distinct instants yields start/end sources.
        (
            "new Intl.DateTimeFormat('en',{timeZone:'UTC'}).formatRangeToParts(0,1e12).some(p=>p.source==='startRange')",
            "true",
        ),
    ] {
        intl_result(source, expected);
    }
}

#[test]
fn date_time_format_non_finite_date_throws_range_error() {
    intl_throws("new Intl.DateTimeFormat('en').format(NaN)", "RangeError");
    intl_throws(
        "new Intl.DateTimeFormat('en').format(Infinity)",
        "RangeError",
    );
}

#[test]
fn date_time_format_invalid_options_throw_range_error() {
    for source in [
        "new Intl.DateTimeFormat('en',{hour:'bogus'})",
        "new Intl.DateTimeFormat('en',{weekday:'bogus'})",
        "new Intl.DateTimeFormat('en',{dateStyle:'bogus'})",
        "new Intl.DateTimeFormat('en',{calendar:'!'})",
    ] {
        intl_throws(source, "RangeError");
    }
}

#[test]
fn date_time_format_style_and_component_conflict_throws_type_error() {
    intl_throws(
        "new Intl.DateTimeFormat('en',{dateStyle:'full',hour:'numeric'})",
        "TypeError",
    );
}

#[test]
fn date_time_format_tostringtag_is_exact() {
    intl_result(
        "Object.prototype.toString.call(new Intl.DateTimeFormat('en'))",
        "[object Intl.DateTimeFormat]",
    );
}

// ------------------------------ Segmenter ------------------------------

#[test]
fn segmenter_resolved_options_are_exact() {
    for (source, expected) in [
        ("new Intl.Segmenter('en').resolvedOptions().granularity", "grapheme"),
        (
            "new Intl.Segmenter('en',{granularity:'word'}).resolvedOptions().granularity",
            "word",
        ),
        ("new Intl.Segmenter('fr').resolvedOptions().locale", "fr"),
        (
            "var o=new Intl.Segmenter('en',{granularity:'sentence'}).resolvedOptions(); Object.keys(o).join(',')",
            "locale,granularity",
        ),
    ] {
        intl_result(source, expected);
    }
    // An invalid granularity is a RangeError.
    intl_throws("new Intl.Segmenter('en',{granularity:'bogus'})", "RangeError");
}

#[test]
fn segmenter_grapheme_segmentation_is_exact() {
    for (source, expected) in [
        // A supplementary-plane emoji is one grapheme; surrogate pair preserved.
        (
            "new Intl.Segmenter().segment('a\u{1F600}b')[Symbol.iterator] ? [...new Intl.Segmenter().segment('a\u{1F600}b')].map(s=>s.segment).join('|') : 'no-iter'",
            "a|\u{1F600}|b",
        ),
        // A combining mark attaches to its base grapheme.
        (
            "[...new Intl.Segmenter().segment('e\u{0301}x')].map(s=>s.segment).join('|')",
            "e\u{0301}|x",
        ),
        // Segment count for a short ASCII string.
        (
            "[...new Intl.Segmenter().segment('abc')].length",
            "3",
        ),
        // The rejoined segments reproduce the input.
        (
            "[...new Intl.Segmenter().segment('Hello, world')].map(s=>s.segment).join('')",
            "Hello, world",
        ),
    ] {
        intl_result(source, expected);
    }
}

#[test]
fn segmenter_word_segmentation_and_is_word_like_are_exact() {
    for (source, expected) in [
        (
            "[...new Intl.Segmenter('en',{granularity:'word'}).segment('The quick')].map(s=>s.segment).join('|')",
            "The| |quick",
        ),
        (
            "var a=[]; for(const v of new Intl.Segmenter('en',{granularity:'word'}).segment('The quick')){a.push(v.isWordLike)} JSON.stringify(a)",
            "[true,false,true]",
        ),
        // A number run is word-like.
        (
            "var seg=new Intl.Segmenter('en',{granularity:'word'}).segment('12 a'); seg.containing(0).isWordLike",
            "true",
        ),
        // The own-property key set of a word segment data object.
        (
            "Object.getOwnPropertyNames(new Intl.Segmenter('en',{granularity:'word'}).segment('hi').containing(0)).join(',')",
            "segment,index,input,isWordLike",
        ),
    ] {
        intl_result(source, expected);
    }
}

#[test]
fn segmenter_sentence_segmentation_is_exact() {
    for (source, expected) in [
        (
            "[...new Intl.Segmenter('en',{granularity:'sentence'}).segment('Hi. Bye.')].length",
            "2",
        ),
        // Sentence data objects have no isWordLike property.
        (
            "new Intl.Segmenter('en',{granularity:'sentence'}).segment('Hi.').containing(0).hasOwnProperty('isWordLike')",
            "false",
        ),
    ] {
        intl_result(source, expected);
    }
}

#[test]
fn segments_containing_is_exact() {
    for (source, expected) in [
        (
            "new Intl.Segmenter().segment('abc').containing(1).segment",
            "b",
        ),
        (
            "new Intl.Segmenter().segment('abc').containing(1).index",
            "1",
        ),
        // An out-of-bounds index yields undefined.
        (
            "new Intl.Segmenter().segment('abc').containing(5)",
            "undefined",
        ),
        (
            "new Intl.Segmenter().segment('abc').containing(-1)",
            "undefined",
        ),
    ] {
        intl_result(source, expected);
    }
}

#[test]
fn segmenter_tostringtag_is_exact() {
    intl_result(
        "Object.prototype.toString.call(new Intl.Segmenter('en'))",
        "[object Intl.Segmenter]",
    );
}
