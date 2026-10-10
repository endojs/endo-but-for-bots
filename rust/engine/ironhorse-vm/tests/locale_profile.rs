//! Positive evidence for the retained Intl/Temporal consensus profile, independent of XS.
use ironhorse_vm::{parse_symbols, Interp};

fn evaluate(source: &str) -> String {
    let (code, names) = ironhorse_compile::compile_atoms(source).unwrap();
    let mut vm = Interp::new();
    vm.link_intrinsics(&parse_symbols(&names));
    let result = vm.run(&code);
    assert!(result.completed, "{:?}", result.halt);
    result.result
}

#[test]
fn retained_profile_has_pinned_data_and_unicode_behavior() {
    assert_eq!(
        evaluate("Intl.__ironhorseDataVersion"),
        "ironhorse-intl-2026a"
    );
    assert_eq!(evaluate("'e\\u0301'.normalize('NFC')"), "é");
    assert_eq!(
        evaluate("Array.from(new Intl.Segmenter('en', {granularity:'grapheme'}).segment('e\\u0301x'), x => x.segment).join('|')"),
        "e\u{0301}|x"
    );
}

#[test]
fn temporal_now_uses_fixed_epoch_and_utc_in_every_fresh_machine() {
    let source = "[Temporal.Now.instant().epochNanoseconds.toString(), Temporal.Now.timeZoneId(), Temporal.Now.plainDateISO().toString(), Temporal.Now.zonedDateTimeISO('+09:00').toString()].join('|')";
    for _ in 0..3 {
        assert_eq!(
            evaluate(source),
            "0|UTC|1970-01-01|1970-01-01T09:00:00+09:00[+09:00]"
        );
    }
}
