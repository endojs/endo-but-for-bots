//! F077: guest Unicode at ASCII parser boundaries must never unwind Rust.
use ironhorse_vm::{parse_symbols, Interp};

#[test]
fn unicode_date_and_duration_inputs_are_rejected_without_panicking() {
    let source = r#"
        var count = 0;
        for (var scalar of ['é', '€', '😀', '\u0301', '\ud800', '\udfff']) {
            for (var text of ['a' + scalar + scalar, '+0000' + scalar,
                              '2020-01-01T00:00:00+a' + scalar + 'b',
                              '2020-01-01T00:00:00.' + scalar]) {
                if (!Number.isNaN(Date.parse(text))) throw new Error('accepted date');
                count++;
            }
            for (var text of ['P1' + scalar, 'PT1' + scalar, 'PT1.2' + scalar]) {
                try {
                    Temporal.Duration.from(text);
                    throw new Error('accepted duration');
                } catch (error) {
                    if (!(error instanceof RangeError)) throw error;
                    count++;
                }
            }
        }
        if (Date.parse('2020-01-01T00:00:00+0130') !== 1577831400000)
            throw new Error('valid zone');
        if (Temporal.Duration.from('PT1.25S').milliseconds !== 250)
            throw new Error('valid duration');
        count
    "#;
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    let mut vm = Interp::new();
    vm.link_intrinsics(&parse_symbols(&symbols));
    let out = vm.run(&bytecode);
    assert!(out.completed, "{:?}", out.halt);
    assert_eq!(out.result, "42");
}
