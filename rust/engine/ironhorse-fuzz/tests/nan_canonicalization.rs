//! F081: compare observable integer byte words, never String(NaN).
use ironhorse_vm::{parse_symbols, Interp};

#[test]
fn nan_bytes_match_canonical_xs() {
    let source = include_str!("../../ironhorse-vm/tests/fixtures/nan-canonicalization.js");
    let oracle = xs_oracle::run(source).expect("oracle runs");
    assert!(oracle.completed, "oracle: {oracle:?}");
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    let mut vm = Interp::new();
    vm.link_intrinsics(&parse_symbols(&symbols));
    let actual = vm.run(&code);
    assert!(actual.completed, "{:?}", actual.halt);
    assert_eq!(actual.result, oracle.result);
}
