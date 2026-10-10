use ironhorse_regexp::{
    compile_checked, compile_units_checked, validate_units_checked, CompileError,
};

#[test]
fn scalar_patterns_keep_programs_and_work_receipts() {
    for pattern in ["", "abc", "é", "😀", "[😀é]", "(?<x>é)", "\0", "a\0b"] {
        for flags in ["", "u"] {
            let scalar = compile_checked(pattern, flags, u64::MAX, None);
            let units: Vec<_> = pattern.encode_utf16().collect();
            let utf16 = compile_units_checked(&units, flags, u64::MAX, None);
            assert_eq!(
                scalar.work_meter_raw, utf16.work_meter_raw,
                "{pattern:?}/{flags}"
            );
            assert_eq!(scalar.result.unwrap().code, utf16.result.unwrap().code);
        }
    }
}

#[test]
fn raw_surrogates_and_identity_escapes_follow_unicode_mode() {
    for unit in [0xd800, 0xdc00] {
        for flags in ["", "u"] {
            assert!(compile_units_checked(&[unit], flags, u64::MAX, None)
                .result
                .is_ok());
        }
        assert!(compile_units_checked(&[0x5c, unit], "", u64::MAX, None)
            .result
            .is_ok());
        assert!(matches!(
            validate_units_checked(&[0x5c, unit], "u", u64::MAX, None).result,
            Err(CompileError::Syntax(_))
        ));
    }
}

#[test]
fn units_encoding_observes_refusal_before_scanning_and_allocation() {
    let units = vec![0xd800; 100_000];
    assert!(matches!(
        compile_units_checked(&units, "", 1, None).result,
        Err(CompileError::BudgetExceeded)
    ));
    let mut calls = 0;
    let result = compile_units_checked(
        &units,
        "",
        u64::MAX,
        Some(&mut |_| {
            calls += 1;
            false
        }),
    );
    assert!(matches!(result.result, Err(CompileError::BudgetExceeded)));
    assert_eq!(calls, 1);
}
