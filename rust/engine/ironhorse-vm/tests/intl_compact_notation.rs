//! `Intl.NumberFormat`'s compact notation: formatted where the data exists,
//! refused by name where it does not (architecture finding F062).
//!
//! For five revisions this option was ACCEPTED, reported back from
//! `resolvedOptions`, and then folded into standard notation at format time:
//! `notation: 'compact'` on 12,345 rendered `12,345` where the spec wants
//! `12K`. That is a guest-observable wrong value at a surface no differential
//! test can catch, because XS ships no `Intl` and so there is no oracle to
//! disagree with. The engine's rule is an honest named skip, never a wrong
//! value, and this file holds both halves of that rule.
//!
//! The expectations below are the values V8 produces for the same inputs.
//! They are not a spec quotation: where this engine and the spec could drift,
//! the check that matters is the refusal, not the rendering.

use ironhorse_vm::{parse_symbols, Interp};

fn evaluate(source: &str) -> String {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    let mut vm = Interp::new();
    vm.link_intrinsics(&parse_symbols(&symbols));
    let outcome = vm.run(&code);
    assert!(outcome.completed, "{source}: {:?}", outcome.halt);
    outcome.result
}

fn compact(value: &str, extra: &str) -> String {
    evaluate(&format!(
        "new Intl.NumberFormat('en', {{notation:'compact'{extra}}}).format({value})"
    ))
}

/// The headline case from the finding's own probe.
#[test]
fn compact_scales_and_carries_its_affix() {
    assert_eq!(compact("12345", ""), "12K");
}

/// The default rounding for compact is `morePrecision` over (0,0) fraction
/// digits and (1,2) significant digits, which is what distinguishes `1.2K`
/// from `1K`. Getting the scaling right and the rounding wrong would be a
/// subtler version of the same wrong value.
#[test]
fn compact_uses_the_more_precise_of_two_digit_families() {
    assert_eq!(compact("1234", ""), "1.2K");
    assert_eq!(compact("1500000", ""), "1.5M");
    assert_eq!(compact("12345", ""), "12K");
}

/// `ComputeExponent`'s re-check: a mantissa that rounds up out of its
/// pattern window belongs to the NEXT pattern. Without it, 999,999 renders
/// as `1000K`.
#[test]
fn a_mantissa_that_rounds_past_its_window_moves_up_a_pattern() {
    assert_eq!(compact("999999", ""), "1M");
    assert_eq!(compact("999999999", ""), "1B");
}

/// Below a thousand there is no pattern, so compact is standard.
#[test]
fn values_below_the_first_pattern_are_unscaled() {
    assert_eq!(compact("999", ""), "999");
    assert_eq!(compact("0", ""), "0");
    assert_eq!(compact("1", ""), "1");
}

/// `en` stops at trillion, so a quadrillion is `1000T` rather than a
/// fabricated affix.
#[test]
fn the_largest_pattern_does_not_grow_a_new_affix() {
    assert_eq!(compact("1e9", ""), "1B");
    assert_eq!(compact("1e12", ""), "1T");
    assert_eq!(compact("1e15", ""), "1000T");
}

/// The long display is separate data, not a transformation of the short one.
#[test]
fn the_long_display_is_its_own_data() {
    assert_eq!(compact("12345", ",compactDisplay:'long'"), "12 thousand");
    assert_eq!(compact("1500000", ",compactDisplay:'long'"), "1.5 million");
    assert_eq!(compact("1e9", ",compactDisplay:'long'"), "1 billion");
}

/// The sign rides in front of the scaled mantissa, not the original.
#[test]
fn a_negative_value_keeps_its_sign() {
    assert_eq!(compact("-1234", ""), "-1.2K");
    assert_eq!(compact("-12345", ""), "-12K");
}

/// `formatToParts` must NAME the affix rather than fold it into a literal,
/// or a caller reassembling the parts loses it.
#[test]
fn format_to_parts_names_the_compact_affix() {
    let parts = evaluate(
        "new Intl.NumberFormat('en', {notation:'compact'}).formatToParts(12345) \
         .map(function (p) { return p.type + ':' + p.value; }).join('|')",
    );
    assert_eq!(parts, "integer:12|compact:K", "{parts}");
}

/// An explicit digit option still wins: the compact defaults apply only
/// when the guest named neither digit family.
#[test]
fn explicit_digit_options_override_the_compact_defaults() {
    assert_eq!(compact("1234", ",maximumFractionDigits:2"), "1.23K");
    assert_eq!(compact("1234", ",maximumSignificantDigits:3"), "1.23K");
}

/// The other half of the rule. A locale whose compact-decimal data this
/// engine does not model takes the engine's NAMED SKIP — an uncatchable,
/// self-naming `Halt::NotImplemented`, the same mechanism
/// `formatRange` takes — rather than being formatted with English patterns.
///
/// Not a `RangeError`: a catchable spec-shaped error is indistinguishable
/// by a guest from "you passed an invalid option", which is a fabricated
/// claim about the spec rather than an honest statement about this engine.
#[test]
fn an_unmodeled_locale_takes_the_named_skip() {
    for locale in ["de", "fr", "ja", "zh-Hans", "ru"] {
        let source =
            format!("new Intl.NumberFormat('{locale}', {{notation:'compact'}}).format(12345)");
        let (code, symbols) = ironhorse_compile::compile_atoms(&source).unwrap();
        let mut vm = Interp::new();
        vm.link_intrinsics(&parse_symbols(&symbols));
        let outcome = vm.run(&code);
        assert!(
            !outcome.completed,
            "compact in {locale} must not produce a value at all: {:?}",
            outcome.result
        );
        assert!(
            matches!(
                &outcome.halt,
                ironhorse_vm::Halt::NotImplemented(label)
                    if *label == "Intl.NumberFormat:compact-locale"
            ),
            "compact in {locale} must take the named skip, got {:?}",
            outcome.halt
        );
    }
}

/// The skip must not fire before the option reads the spec requires, or a
/// bad `signDisplay` reports the wrong error.
#[test]
fn the_named_skip_comes_after_the_option_reads() {
    assert_eq!(
        evaluate(
            "(function () { try { \
               new Intl.NumberFormat('de', {notation:'compact', signDisplay:'bogus'}); \
               return 'NO THROW'; \
             } catch (e) { return e.constructor.name; } })()"
        ),
        "RangeError",
        "an invalid signDisplay must report itself, not the compact skip"
    );
}

/// The undetermined locale resolves to the default, which is the locale
/// whose data this engine has.
#[test]
fn the_undetermined_locale_carries_the_data_it_falls_back_to() {
    assert_eq!(
        evaluate("new Intl.NumberFormat('und', {notation:'compact'}).format(12345)"),
        "12K"
    );
}

/// `resolvedOptions` must keep reporting what was accepted. A refusal that
/// also silently changed the resolved notation would be a second wrong
/// value.
#[test]
fn resolved_options_still_report_compact() {
    assert_eq!(
        evaluate(
            "var o = new Intl.NumberFormat('en', {notation:'compact'}).resolvedOptions(); \
             o.notation + ':' + o.compactDisplay"
        ),
        "compact:short"
    );
}

/// The exponent re-check must cover the transition that STARTS at zero.
/// 999.9 rounds to 1000 and belongs under the thousand pattern.
#[test]
fn a_value_just_below_the_first_pattern_still_reaches_it() {
    assert_eq!(compact("999.9", ""), "1K");
    assert_eq!(compact("999.5", ""), "1K");
    assert_eq!(compact("950", ",maximumSignificantDigits:1"), "1K");
    assert_eq!(
        evaluate("new Intl.NumberFormat('en',{notation:'compact',style:'percent'}).format(9.999)"),
        "1K%"
    );
}

/// Compact's mantissa is NOT bounded below the grouping threshold: `en` has
/// no pattern above a trillion, so a quintillion is `1,000,000T`.
#[test]
fn a_large_compact_mantissa_is_grouped() {
    assert_eq!(compact("1e16", ""), "10,000T");
    assert_eq!(compact("1e18", ""), "1,000,000T");
    // Below the min2 threshold it stays ungrouped, as min2 says.
    assert_eq!(compact("1e15", ""), "1000T");
}

/// CLDR `en` has no long compact CURRENCY patterns; ICU falls back to the
/// short ones, and `$1.2 thousand` is an affix nobody ships.
#[test]
fn long_compact_currency_falls_back_to_the_short_affix() {
    assert_eq!(
        evaluate(
            "new Intl.NumberFormat('en',{notation:'compact',compactDisplay:'long',\
             style:'currency',currency:'USD'}).format(1234)"
        ),
        "$1.2K"
    );
}

/// The long form's separator is a `literal` part. The concatenated string is
/// the same either way, which is why only `formatToParts` can see it.
#[test]
fn the_long_affix_separator_is_its_own_literal_part() {
    assert_eq!(
        evaluate(
            "new Intl.NumberFormat('en',{notation:'compact',compactDisplay:'long'}) \
             .formatToParts(12345).map(function (p) { return p.type + ':' + p.value; }) \
             .join('|')"
        ),
        "integer:12|literal: |compact:thousand"
    );
}

/// A rounding increment with compact is a TypeError at construction, not a
/// constructor that succeeds and then formats 1,234 as `0K`.
#[test]
fn a_rounding_increment_with_compact_is_refused_at_construction() {
    for increment in ["2", "5", "25"] {
        assert_eq!(
            evaluate(&format!(
                "(function () {{ try {{ \
                   new Intl.NumberFormat('en', {{notation:'compact', \
                     roundingIncrement:{increment}}}); \
                   return 'NO THROW'; \
                 }} catch (e) {{ return e.constructor.name; }} }})()"
            )),
            "TypeError",
            "roundingIncrement {increment} with compact must be refused"
        );
    }
}

/// Step 17 sets the COMPUTED rounding priority, which `resolvedOptions`
/// reports.
#[test]
fn compact_resolves_the_computed_rounding_priority() {
    assert_eq!(
        evaluate(
            "new Intl.NumberFormat('en',{notation:'compact'}) \
             .resolvedOptions().roundingPriority"
        ),
        "morePrecision"
    );
}

/// A carry out of a cut BELOW the leading digit must land at the least place
/// being kept, not one decade above the leading digit where the layout drops
/// it. `$0.0001` expanded is a cent, not nothing.
#[test]
fn a_carry_from_below_the_leading_digit_lands_at_the_kept_place() {
    for (options, value, expected) in [
        (
            "style:'currency',currency:'USD',roundingMode:'expand'",
            "0.0001",
            "$0.01",
        ),
        (
            "style:'currency',currency:'JPY',roundingMode:'ceil'",
            "0.04",
            "¥1",
        ),
        ("style:'percent',roundingMode:'ceil'", "0.0001", "1%"),
        ("maximumFractionDigits:0,roundingMode:'ceil'", "0.09", "1"),
        // A directed mode pointing the other way must NOT carry.
        ("maximumFractionDigits:0,roundingMode:'floor'", "0.09", "0"),
        ("maximumFractionDigits:0,roundingMode:'trunc'", "0.09", "0"),
        (
            "maximumFractionDigits:2,roundingMode:'expand'",
            "-0.0009",
            "-0.01",
        ),
    ] {
        assert_eq!(
            evaluate(&format!(
                "new Intl.NumberFormat('en', {{{options}}}).format({value})"
            )),
            expected,
            "{options} on {value}"
        );
    }
}

/// The same cut, under the HALF modes, which must not carry at all.
///
/// A carry from below the leading digit is a directed-mode event. When the
/// cut sits below the leading digit every kept digit is zero AND so is the
/// first discarded one, so the tail is far under half a unit and every
/// half-rounding mode rounds down. Deciding this at the leading SIGNIFICANT
/// digit instead reads 9 for 0.09 and rounds up, which reported
/// `maximumFractionDigits: 0` on 0.09 as `1` where the spec says `0`.
///
/// The default mode is `halfExpand`, so the first two rows are what an
/// ordinary caller with no `roundingMode` at all gets. Expected values
/// cross-checked against V8.
#[test]
fn a_cut_below_the_leading_digit_does_not_carry_under_a_half_mode() {
    for (options, value, expected) in [
        ("maximumFractionDigits:0", "0.09", "0"),
        ("maximumFractionDigits:2", "0.0009", "0"),
        (
            "maximumFractionDigits:0,roundingMode:'halfExpand'",
            "0.09",
            "0",
        ),
        (
            "maximumFractionDigits:0,roundingMode:'halfEven'",
            "0.09",
            "0",
        ),
        (
            "maximumFractionDigits:0,roundingMode:'halfCeil'",
            "0.09",
            "0",
        ),
        (
            "maximumFractionDigits:0,roundingMode:'halfFloor'",
            "0.09",
            "0",
        ),
        (
            "maximumFractionDigits:0,roundingMode:'halfTrunc'",
            "0.09",
            "0",
        ),
        ("maximumFractionDigits:0", "-0.09", "-0"),
        // The boundary itself still behaves: at the leading digit's OWN
        // place (`keep == 0`) a half mode does compare against five.
        ("maximumFractionDigits:0", "0.5", "1"),
        ("maximumFractionDigits:0", "0.4", "0"),
        ("maximumFractionDigits:2", "0.005", "0.01"),
        ("maximumFractionDigits:2", "0.004", "0"),
    ] {
        assert_eq!(
            evaluate(&format!(
                "new Intl.NumberFormat('en', {{{options}}}).format({value})"
            )),
            expected,
            "{options} on {value}"
        );
    }
}
