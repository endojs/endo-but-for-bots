//! Oracle-backed regressions for the deterministic ECMA-402 formatter families
//! `Intl.ListFormat` and `Intl.PluralRules` (child 20). The pinned XS oracle
//! has no ECMA-402 host, so each formatter case is proven by requiring
//! Ironhorse to run it to completion (`IronhorseOnlyComplete`) with the exact
//! result while the oracle reports the missing `Intl` binding — the same
//! host-only-exclusion shape `intl_core.rs` established.

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

#[test]
fn list_format_english_types_and_styles_are_exact() {
    for (source, expected) in [
        // Default (conjunction, long).
        (
            "new Intl.ListFormat('en-US').format(['foo','bar','baz'])",
            "foo, bar, and baz",
        ),
        (
            "new Intl.ListFormat('en-US').format(['foo','bar'])",
            "foo and bar",
        ),
        // A primitive string iterates by code point.
        ("new Intl.ListFormat('en-US').format('foo')", "f, o, and o"),
        // Disjunction.
        (
            "new Intl.ListFormat('en-US',{type:'disjunction'}).format(['foo','bar','baz'])",
            "foo, bar, or baz",
        ),
        // Short conjunction uses the ampersand.
        (
            "new Intl.ListFormat('en-US',{style:'short'}).format(['foo','bar','baz'])",
            "foo, bar, & baz",
        ),
        // Unit is comma-joined; narrow unit is space-joined.
        (
            "new Intl.ListFormat('en-US',{type:'unit'}).format(['foo','bar','baz'])",
            "foo, bar, baz",
        ),
        (
            "new Intl.ListFormat('en-US',{type:'unit',style:'narrow'}).format(['foo','bar','baz'])",
            "foo bar baz",
        ),
        // Zero and one element.
        ("new Intl.ListFormat('en-US').format([])", ""),
        ("new Intl.ListFormat('en-US').format(['foo'])", "foo"),
    ] {
        intl_result(source, expected);
    }
}

#[test]
fn list_format_spanish_unit_is_exact() {
    for (source, expected) in [
        (
            "new Intl.ListFormat('es-ES',{type:'unit'}).format(['foo','bar','baz'])",
            "foo, bar y baz",
        ),
        (
            "new Intl.ListFormat('es-ES',{type:'unit',style:'short'}).format(['foo','bar','baz'])",
            "foo, bar, baz",
        ),
        (
            "new Intl.ListFormat('es-ES',{type:'unit'}).format(['foo','bar'])",
            "foo y bar",
        ),
    ] {
        intl_result(source, expected);
    }
}

#[test]
fn list_format_parts_and_resolved_options_are_exact() {
    for (source, expected) in [
        (
            "new Intl.ListFormat('en-US').formatToParts(['a','b']).map(p=>p.type+':'+p.value).join('|')",
            "element:a|literal: and |element:b",
        ),
        (
            "new Intl.ListFormat('en-US').formatToParts(['a','b','c']).map(p=>p.type+':'+p.value).join('|')",
            "element:a|literal:, |element:b|literal:, and |element:c",
        ),
        (
            "Object.keys(new Intl.ListFormat('en-us',{style:'short',type:'unit'}).resolvedOptions()).join(',')",
            "locale,type,style",
        ),
        (
            "new Intl.ListFormat('en-us').resolvedOptions().locale",
            "en-US",
        ),
        (
            "new Intl.ListFormat('en-US',{type:'unit'}).resolvedOptions().type",
            "unit",
        ),
    ] {
        intl_result(source, expected);
    }
}

/// Assert only that Ironhorse completes `source` with `expected` — used where a
/// `try`/`catch` catches the oracle's own missing-`Intl` ReferenceError, so both
/// engines complete (with different caught values) rather than diverging.
fn ironhorse_only_result(source: &str, expected: &str) {
    let run = dual_run(source).expect("the XS oracle machine must start");
    // A completed run yields the caught constructor name; a thrown run would
    // leave an empty result, so an exact non-empty match implies completion.
    assert_eq!(
        run.ironhorse_result, expected,
        "Ironhorse must complete `{source}` (halt: {:?})",
        run.ironhorse_halt,
    );
}

#[test]
fn list_format_rejects_non_string_elements_and_invalid_options() {
    // A non-string element, and calling without `new`, are both TypeErrors.
    ironhorse_only_result(
        "try{new Intl.ListFormat('en').format([1]);'no'}catch(e){e.constructor.name}",
        "TypeError",
    );
    ironhorse_only_result(
        "try{Intl.ListFormat('en');'no'}catch(e){e.constructor.name}",
        "TypeError",
    );
    // An invalid `type` option is a RangeError.
    ironhorse_only_result(
        "try{new Intl.ListFormat('en',{type:'bogus'});'no'}catch(e){e.constructor.name}",
        "RangeError",
    );
}

#[test]
fn plural_rules_select_english_cardinal_and_ordinal_are_exact() {
    for (source, expected) in [
        ("new Intl.PluralRules('en').select(1)", "one"),
        ("new Intl.PluralRules('en').select(2)", "other"),
        ("new Intl.PluralRules('en').select(0)", "other"),
        ("new Intl.PluralRules('en').select(1.5)", "other"),
        ("new Intl.PluralRules('en').select(-1)", "one"),
        ("new Intl.PluralRules('en',{type:'ordinal'}).select(1)", "one"),
        ("new Intl.PluralRules('en',{type:'ordinal'}).select(2)", "two"),
        ("new Intl.PluralRules('en',{type:'ordinal'}).select(3)", "few"),
        ("new Intl.PluralRules('en',{type:'ordinal'}).select(4)", "other"),
        ("new Intl.PluralRules('en',{type:'ordinal'}).select(11)", "other"),
        ("new Intl.PluralRules('en',{type:'ordinal'}).select(21)", "one"),
        ("new Intl.PluralRules('en',{type:'ordinal'}).select(22)", "two"),
    ] {
        intl_result(source, expected);
    }
}

#[test]
fn plural_rules_categories_and_resolved_options_are_exact() {
    for (source, expected) in [
        (
            "new Intl.PluralRules('en').resolvedOptions().pluralCategories.join(',')",
            "one,other",
        ),
        (
            "new Intl.PluralRules('ar').resolvedOptions().pluralCategories.join(',')",
            "zero,one,two,few,many,other",
        ),
        (
            "new Intl.PluralRules('fr').resolvedOptions().pluralCategories.join(',')",
            "one,many,other",
        ),
        (
            "Object.keys(new Intl.PluralRules().resolvedOptions()).join(',')",
            "locale,type,notation,minimumIntegerDigits,minimumFractionDigits,maximumFractionDigits,pluralCategories,roundingIncrement,roundingMode,roundingPriority,trailingZeroDisplay",
        ),
        (
            "Object.keys(new Intl.PluralRules(undefined,{minimumSignificantDigits:3}).resolvedOptions()).join(',')",
            "locale,type,notation,minimumIntegerDigits,minimumSignificantDigits,maximumSignificantDigits,pluralCategories,roundingIncrement,roundingMode,roundingPriority,trailingZeroDisplay",
        ),
        (
            "new Intl.PluralRules().resolvedOptions().maximumFractionDigits+''",
            "3",
        ),
    ] {
        intl_result(source, expected);
    }
}

/// The `arguments` object carries every passed argument, so `arguments.length`
/// equals the actual argument count even when the function declares formal
/// parameters. This is the causal fix that lets the test262 `propertyHelper.js`
/// `verifyProperty` harness (which rejects fewer than three arguments) run. The
/// oracle has no missing global here, so both engines complete and agree.
#[test]
fn arguments_length_counts_all_passed_arguments() {
    for (source, expected) in [
        ("(function(a,b,c){return arguments.length})(1,2,3)", "3"),
        ("(function(a,b,c){return arguments.length})(1,2,3,4)", "4"),
        ("(function(a,b){return arguments.length})(1)", "1"),
        ("(function(){return arguments.length})(9,9)", "2"),
        ("'use strict';(function(a,b){return arguments.length})(7,8,9)", "3"),
        ("(function(a,b,c){return arguments[3]})(1,2,3,4)", "4"),
    ] {
        let run = dual_run(source).expect("the XS oracle machine must start");
        assert_eq!(
            run.agreement,
            Agreement::BothComplete,
            "both engines must complete `{source}` (ihalt {:?})",
            run.ironhorse_halt,
        );
        assert_eq!(run.ironhorse_result, expected, "ironhorse `{source}`");
        assert_eq!(run.oracle_result, expected, "oracle `{source}`");
    }
}
