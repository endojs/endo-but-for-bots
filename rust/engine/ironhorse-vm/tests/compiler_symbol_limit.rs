//! F064: the compiler must honor the SYMB count including reserved ID zero.
use ironhorse_compile::{compile_atoms, ParseErrorKind};
use ironhorse_vm::parse_symbols_checked;
use std::collections::HashSet;
use std::fmt::Write;

fn source(count: usize) -> String {
    let mut source = String::new();
    for i in 0..count {
        write!(source, "var v{i};").unwrap();
    }
    source
}

#[test]
fn largest_symbol_atom_decodes_every_distinct_name() {
    // 65535 is the largest wire count, not the largest number of names.
    let (_, atom) = compile_atoms(&source(65_534)).unwrap();
    assert_eq!(&atom[..2], &u16::MAX.to_le_bytes());
    let names = parse_symbols_checked(&atom).unwrap();
    assert_eq!(names.len(), 65_534);
    let actual: HashSet<_> = names.iter().map(|name| name.as_bytes()).collect();
    assert_eq!(actual.len(), names.len());
    for i in 0..65_534 {
        assert!(actual.contains(format!("v{i}").as_bytes()));
    }
}

#[test]
fn symbol_count_overflow_is_refused() {
    for count in [65_535, 65_536, 70_000] {
        let error = compile_atoms(&source(count)).unwrap_err();
        assert_eq!(error.kind, ParseErrorKind::Syntax);
        assert_eq!(error.message, "too many symbols (maximum 65534)");
    }
}

#[test]
fn symbol_refusal_retains_the_admitted_compilation_bill() {
    let mut charged = 0;
    let source = source(65_535);
    let result = ironhorse_compile::compile_atoms_budgeted(
        &source,
        ironhorse_compile::Goal::Eval,
        false,
        &mut |delta| {
            charged += delta;
            true
        },
    );
    match result {
        Err(ironhorse_compile::CompileError::Parse(error)) => {
            assert_eq!(error.kind, ParseErrorKind::Syntax);
            assert_eq!(error.message, "too many symbols (maximum 65534)");
        }
        _ => panic!("expected a structured symbol refusal"),
    }
    assert!(charged > 0);
}
