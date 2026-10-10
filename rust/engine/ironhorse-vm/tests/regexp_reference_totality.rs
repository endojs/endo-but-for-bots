//! F078: untrusted constructor patterns must raise a catchable SyntaxError.
use ironhorse_vm::{parse_symbols, Interp};

#[test]
fn oversized_references_are_guest_syntax_errors() {
    let source = r#"
        var count = 0;
        for (var flags of ['', 'u', 'v']) {
            for (var number of ['2147483648', '4294967295', '4294967296',
                                '4294967297', '18446744073709551616']) {
                for (var pattern of ['(a)\\' + number, '(?<=\\' + number + '(a))b']) {
                    try {
                        new RegExp(pattern, flags).test('aab');
                        throw new Error('accepted oversized reference');
                    } catch (error) {
                        if (!(error instanceof SyntaxError)) throw error;
                        count++;
                    }
                }
            }
        }
        count
    "#;
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    let mut vm = Interp::new();
    vm.link_intrinsics(&parse_symbols(&symbols));
    let out = vm.run(&bytecode);
    assert!(out.completed, "{:?}", out.halt);
    assert_eq!(out.result, "30");
}
