//! Oracle-backed regressions for the deterministic ECMA-402 core profile.

use ironhorse_262::{dual_run, Agreement};

fn ironhorse_result(source: &str, expected: &str) {
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
    assert_eq!(run.ironhorse_result, expected);
}

#[test]
fn canonicalization_and_locale_fields_are_oracle_exact() {
    for (source, expected) in [
        ("Intl.getCanonicalLocales('EN-latn-us-u-kn-true-kf-upper')[0]", "en-Latn-US-u-kf-upper-kn"),
        ("new Intl.Locale('de-latn-de-u-ca-gregory-kn').toString()", "de-Latn-DE-u-ca-gregory-kn"),
        ("new Intl.Locale('zh-hans-cn').baseName", "zh-Hans-CN"),
        ("new Intl.Locale('en-u-kn').numeric", "true"),
        ("new Intl.Locale('sr').maximize().toString()", "sr-Cyrl-RS"),
        ("new Intl.Locale('en-Latn-US').minimize().toString()", "en"),
    ] {
        ironhorse_result(source, expected);
    }
}

#[test]
fn collator_options_and_compare_are_oracle_exact() {
    for (source, expected) in [
        ("new Intl.Collator('en').compare('a', 'b') < 0", "true"),
        ("new Intl.Collator('en', {numeric:true}).compare('2', '10') < 0", "true"),
        ("new Intl.Collator('en', {sensitivity:'base'}).compare('A', 'a')", "0"),
        ("new Intl.Collator('de').resolvedOptions().locale", "de"),
        ("new Intl.Collator('en', {numeric:true}).resolvedOptions().numeric", "true"),
    ] {
        ironhorse_result(source, expected);
    }
}
