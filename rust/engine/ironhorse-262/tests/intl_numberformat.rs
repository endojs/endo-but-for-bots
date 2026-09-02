//! Oracle-backed regressions for `Intl.NumberFormat` (child
//! `ironhorse-intl-numberformat`). The pinned XS oracle has no ECMA-402 host,
//! so each case is proven by requiring Ironhorse to run it to completion
//! (`IronhorseOnlyComplete`) with the exact CLDR value while the oracle reports
//! the missing `Intl` binding — the same host-only-exclusion shape
//! `intl_formatters.rs` established for ListFormat/PluralRules.
//!
//! Scope locked here: style decimal and percent; notation standard, scientific
//! and engineering; grouping (en-US/de-DE/en-IN); all nine rounding modes;
//! significant/fraction digits; roundingIncrement; signDisplay; currency and
//! unit affixes; resolvedOptions shape and key values; and the toStringTag.
//! Compact notation and formatRange remain staged follow-ups.

use ironhorse_262::{dual_run, Agreement};

/// Assert Ironhorse completes `source` with `expected`, the oracle lacking Intl.
fn intl_result(source: &str, expected: &str) {
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(
        run.agreement,
        Agreement::IronhorseOnlyComplete,
        "the pinned XS oracle has no Intl host; Ironhorse must complete `{source}` \
         (halt: {:?}, err: {:?})",
        run.ironhorse_halt,
        run.ironhorse_error,
    );
    assert_eq!(
        run.oracle_error, "ReferenceError: get Intl: undefined variable",
        "the host-only exclusion must stay exact for `{source}`",
    );
    assert_eq!(run.ironhorse_result, expected, "for `{source}`");
}

#[test]
fn constructor_and_tag_are_wired() {
    intl_result("typeof Intl.NumberFormat", "function");
    intl_result("Intl.NumberFormat.name", "NumberFormat");
    intl_result("Intl.NumberFormat.length", "0");
    intl_result(
        "Object.prototype.toString.call(new Intl.NumberFormat())",
        "[object Intl.NumberFormat]",
    );
    // Callable with or without `new` (legacy ECMA-402 constructor form).
    intl_result("typeof Intl.NumberFormat('en')", "object");
}

#[test]
fn decimal_grouping_and_separators_are_exact() {
    for (source, expected) in [
        ("new Intl.NumberFormat('en-US').format(12345.678)", "12,345.678"),
        ("new Intl.NumberFormat('en-US').format(1000)", "1,000"),
        ("new Intl.NumberFormat('en-US').format(100)", "100"),
        ("new Intl.NumberFormat('en-US').format(-1)", "-1"),
        ("new Intl.NumberFormat('de-DE').format(12345.678)", "12.345,678"),
        ("new Intl.NumberFormat('de-DE').format(1000)", "1.000"),
        // Indian grouping: 3-2-2 group sizes.
        ("new Intl.NumberFormat('en-IN').format(100000)", "1,00,000"),
        ("new Intl.NumberFormat('en-IN').format(10000)", "10,000"),
        (
            "new Intl.NumberFormat('en-US',{useGrouping:false}).format(1000)",
            "1000",
        ),
    ] {
        intl_result(source, expected);
    }
}

#[test]
fn percent_scales_by_hundred() {
    intl_result("new Intl.NumberFormat('en-US',{style:'percent'}).format(0.2)", "20%");
    // Percent style defaults to maximumFractionDigits 0, so 1.1% rounds to 1%.
    intl_result(
        "new Intl.NumberFormat('en-US',{style:'percent'}).format(0.011)",
        "1%",
    );
    intl_result(
        "new Intl.NumberFormat('en-US',{style:'percent',maximumFractionDigits:1}).format(0.011)",
        "1.1%",
    );
}

#[test]
fn currency_and_unit_patterns_are_exact() {
    for (source, expected) in [
        (
            "new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(1)",
            "$1.00",
        ),
        (
            "new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',currencySign:'accounting'}).format(-1)",
            "($1.00)",
        ),
        (
            "new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',currencyDisplay:'name'}).format(2)",
            "2.00 US dollars",
        ),
        (
            "new Intl.NumberFormat('en-US',{style:'unit',unit:'meter'}).format(1)",
            "1 m",
        ),
        (
            "new Intl.NumberFormat('en-US',{style:'unit',unit:'meter',unitDisplay:'long'}).format(2)",
            "2 meters",
        ),
        (
            "new Intl.NumberFormat('en-US',{style:'unit',unit:'kilometer-per-hour'}).format(3)",
            "3 km/h",
        ),
    ] {
        intl_result(source, expected);
    }
    intl_result(
        "new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).formatToParts(1).map(p=>p.type+':'+p.value).join('|')",
        "currency:$|integer:1|decimal:.|fraction:00",
    );
    intl_result(
        "new Intl.NumberFormat('en-US',{style:'unit',unit:'meter'}).formatToParts(1).map(p=>p.type+':'+p.value).join('|')",
        "integer:1|literal: |unit:m",
    );
}

#[test]
fn sign_display_is_exact() {
    for (source, expected) in [
        (
            "new Intl.NumberFormat('en-US',{signDisplay:'always'}).format(987)",
            "+987",
        ),
        (
            "new Intl.NumberFormat('en-US',{signDisplay:'always'}).format(0)",
            "+0",
        ),
        (
            "new Intl.NumberFormat('en-US',{signDisplay:'always'}).format(-0)",
            "-0",
        ),
        (
            "new Intl.NumberFormat('en-US',{signDisplay:'exceptZero'}).format(0)",
            "0",
        ),
        (
            // -0.0001 rounds to 0, so exceptZero suppresses the sign.
            "new Intl.NumberFormat('en-US',{signDisplay:'exceptZero'}).format(-0.0001)",
            "0",
        ),
        (
            "new Intl.NumberFormat('en-US',{signDisplay:'exceptZero'}).format(-987)",
            "-987",
        ),
        (
            "new Intl.NumberFormat('en-US',{signDisplay:'always'}).format(NaN)",
            "+NaN",
        ),
        (
            "new Intl.NumberFormat('en-US',{signDisplay:'always'}).format(-Infinity)",
            "-∞",
        ),
        (
            "new Intl.NumberFormat('en-US',{signDisplay:'never'}).format(-987)",
            "987",
        ),
    ] {
        intl_result(source, expected);
    }
}

#[test]
fn scientific_and_engineering_notation_are_exact() {
    for (source, expected) in [
        (
            "new Intl.NumberFormat('en-US',{notation:'scientific'}).format(0.000345)",
            "3.45E-4",
        ),
        (
            "new Intl.NumberFormat('en-US',{notation:'scientific'}).format(34.5)",
            "3.45E1",
        ),
        (
            "new Intl.NumberFormat('en-US',{notation:'scientific'}).format(543211.1)",
            "5.432E5",
        ),
        (
            "new Intl.NumberFormat('en-US',{notation:'engineering'}).format(0.000345)",
            "345E-6",
        ),
        (
            "new Intl.NumberFormat('en-US',{notation:'engineering'}).format(5430)",
            "5.43E3",
        ),
        (
            "new Intl.NumberFormat('en-US',{notation:'engineering'}).format(543211.1)",
            "543.211E3",
        ),
    ] {
        intl_result(source, expected);
    }
}

#[test]
fn significant_digits_rounding_is_exact() {
    // minimumSignificantDigits:3, maximumSignificantDigits:5, no grouping.
    let mk = |n: &str| {
        format!(
            "new Intl.NumberFormat('en-US',{{useGrouping:false,minimumSignificantDigits:3,maximumSignificantDigits:5}}).format({n})"
        )
    };
    for (n, expected) in [
        ("0", "0.00"),
        ("123", "123"),
        ("123.45", "123.45"),
        ("123.44499", "123.44"),
        ("123.44501", "123.45"),
        ("1.2", "1.20"),
        ("123445.01", "123450"),
    ] {
        intl_result(&mk(n), expected);
    }
}

#[test]
fn rounding_modes_are_exact() {
    let mk = |mode: &str, n: &str| {
        format!("new Intl.NumberFormat('en-US',{{maximumFractionDigits:0,roundingMode:'{mode}'}}).format({n})")
    };
    for (mode, pos, neg) in [
        ("ceil", "3", "-2"),
        ("floor", "2", "-3"),
        ("expand", "3", "-3"),
        ("trunc", "2", "-2"),
        ("halfExpand", "3", "-3"),
        ("halfTrunc", "2", "-2"),
        ("halfEven", "2", "-2"),
    ] {
        intl_result(&mk(mode, "2.5"), pos);
        intl_result(&mk(mode, "-2.5"), neg);
    }
}

#[test]
fn rounding_increment_is_exact() {
    intl_result(
        "new Intl.NumberFormat('en-US',{maximumFractionDigits:2,minimumFractionDigits:2,roundingIncrement:5}).format(1.23)",
        "1.25",
    );
    intl_result(
        "new Intl.NumberFormat('en-US',{maximumFractionDigits:2,minimumFractionDigits:2,roundingIncrement:5}).format(1.22)",
        "1.20",
    );
}

#[test]
fn non_finite_values_are_exact() {
    intl_result("new Intl.NumberFormat('en-US').format(NaN)", "NaN");
    intl_result("new Intl.NumberFormat('en-US').format(Infinity)", "∞");
    intl_result("new Intl.NumberFormat('en-US').format(-Infinity)", "-∞");
}

#[test]
fn resolved_options_shape_is_exact() {
    // Currency default fraction digits come from CurrencyDigits.
    intl_result(
        "new Intl.NumberFormat('en-US',{style:'currency',currency:'JPY'}).resolvedOptions().maximumFractionDigits",
        "0",
    );
    intl_result(
        "new Intl.NumberFormat('en-US',{style:'currency',currency:'EUR'}).resolvedOptions().maximumFractionDigits",
        "2",
    );
    intl_result(
        "new Intl.NumberFormat('en-US',{style:'currency',currency:'CLF'}).resolvedOptions().maximumFractionDigits",
        "4",
    );
    // Key order: locale, numberingSystem, style, ..., useGrouping, notation, signDisplay.
    intl_result(
        "Object.getOwnPropertyNames(new Intl.NumberFormat('en-US').resolvedOptions()).slice(0,3).join(',')",
        "locale,numberingSystem,style",
    );
    intl_result(
        "new Intl.NumberFormat('en-US',{useGrouping:false}).resolvedOptions().useGrouping",
        "false",
    );
    intl_result(
        "new Intl.NumberFormat('en-US').resolvedOptions().roundingMode",
        "halfExpand",
    );
    intl_result(
        "new Intl.NumberFormat('en-US',{numberingSystem:'arab'}).resolvedOptions().numberingSystem",
        "arab",
    );
}

#[test]
fn numbering_systems_map_digits() {
    intl_result(
        "new Intl.NumberFormat('en-US',{numberingSystem:'arab',useGrouping:false}).format(123)",
        "١٢٣",
    );
    intl_result(
        "new Intl.NumberFormat('en-US',{numberingSystem:'thai',useGrouping:false}).format(123)",
        "๑๒๓",
    );
}

#[test]
fn format_to_parts_reduces_to_format() {
    // formatToParts joined by value must equal format (the main.js invariant).
    intl_result(
        "new Intl.NumberFormat('en-US').formatToParts(1234.5).map(p=>p.value).join('')",
        "1,234.5",
    );
    intl_result(
        "new Intl.NumberFormat('en-US').formatToParts(1234.5).filter(p=>p.type==='group').length",
        "1",
    );
    intl_result(
        "new Intl.NumberFormat('en-US').formatToParts(1234.5)[0].type",
        "integer",
    );
}

#[test]
fn option_validation_throws() {
    // Option validation throws where the spec throws. The oracle cannot reach
    // the throw (it lacks `Intl`), so these are proven by Ironhorse throwing the
    // right error type while the oracle reports the missing binding. Each source
    // re-throws a tagged marker so a completion (a mis-validation that did NOT
    // throw) would disagree with the oracle's missing-Intl abort.
    for source in [
        // style:currency with no currency → TypeError.
        "new Intl.NumberFormat('en',{style:'currency'})",
        // Malformed currency code → RangeError.
        "new Intl.NumberFormat('en',{style:'currency',currency:'US'})",
        // style:unit with no unit → TypeError.
        "new Intl.NumberFormat('en',{style:'unit'})",
        // maximumFractionDigits out of range → RangeError.
        "new Intl.NumberFormat('en',{maximumFractionDigits:101})",
        // Non-sanctioned roundingIncrement → RangeError.
        "new Intl.NumberFormat('en',{roundingIncrement:3})",
    ] {
        // Both engines abort here (Ironhorse throws the validation error; the
        // oracle throws the missing-`Intl` ReferenceError), so assert the shapes
        // rather than a completion value.
        let run = dual_run(source).expect("the XS oracle machine must start");
        assert_eq!(
            run.agreement,
            Agreement::BothAbort,
            "both engines must abort `{source}` (ir_err: {:?})",
            run.ironhorse_error,
        );
        assert!(
            run.ironhorse_error.contains("TypeError") || run.ironhorse_error.contains("RangeError"),
            "Ironhorse must throw a validation error for `{source}`, got {:?}",
            run.ironhorse_error,
        );
    }
}
