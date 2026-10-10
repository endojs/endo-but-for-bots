//! The runtime source boundary accepts the same code units as JS string values.
use ironhorse_compile::{
    compile_atoms_budgeted_with_limit, compile_atoms_units_budgeted_with_limit, Goal,
};

#[test]
fn scalar_source_keeps_bytecode_atoms_and_meter_receipts() {
    for source in [
        "var a = 'é😀'; a + 1",
        "var 𐐀 = 1; 𐐀 + 2",
        "function tag(s) { return s.raw[0]; } tag`é\\n${1}😀`",
        "/[é😀]/u.test('😀')",
        "'\\uD800' + '\\u{1F600}'",
        "/*😀*/ function f(){return 3} f()",
    ] {
        let mut utf8_bill = 0;
        let utf8 =
            compile_atoms_budgeted_with_limit(source, Goal::Eval, false, u64::MAX, &mut |n| {
                utf8_bill += n;
                true
            })
            .unwrap();
        let mut utf16_bill = 0;
        let units: Vec<_> = source.encode_utf16().collect();
        let utf16 = compile_atoms_units_budgeted_with_limit(
            &units,
            Goal::Eval,
            false,
            u64::MAX,
            &mut |n| {
                utf16_bill += n;
                true
            },
        )
        .unwrap();
        assert_eq!(utf8.bytecode, utf16.bytecode, "{source}");
        assert_eq!(utf8.symbols, utf16.symbols, "{source}");
        assert_eq!(utf8_bill, utf16_bill, "{source}");
        assert_eq!(utf8.parse_meter_raw, utf16.parse_meter_raw);
    }
}

#[test]
fn surrogate_identifier_is_a_parse_error_not_a_panic() {
    for source in [
        vec![0xd800],
        vec![b'v' as u16, b'a' as u16, b'r' as u16, b' ' as u16, 0xd800],
    ] {
        let result = compile_atoms_units_budgeted_with_limit(
            &source,
            Goal::Eval,
            false,
            u64::MAX,
            &mut |_| true,
        );
        assert!(matches!(
            result,
            Err(ironhorse_compile::CompileError::Parse(_))
        ));
    }
}

#[test]
fn utf16_admission_observes_host_refusal() {
    let source = [b'\'' as u16, 0xd800, b'\'' as u16];
    let mut calls = 0;
    let result =
        compile_atoms_units_budgeted_with_limit(&source, Goal::Eval, false, u64::MAX, &mut |_| {
            calls += 1;
            false
        });
    assert!(matches!(
        result,
        Err(ironhorse_compile::CompileError::MeterAbort)
    ));
    assert_eq!(calls, 1);
}
