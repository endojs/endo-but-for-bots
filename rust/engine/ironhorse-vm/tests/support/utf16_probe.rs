//! Shared oracle-free probe for the unit tests and UTF-16 fuzz target.
use std::fmt::Write;

pub fn probe(data: &[u8]) {
    let units: Vec<u16> = data
        .chunks_exact(2)
        .take(128)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    let name = ironhorse_vm::SymbolName::from_units(&units);
    assert_eq!(
        ironhorse_vm::SymbolName::from_cesu8(name.as_bytes())
            .unwrap()
            .to_units(),
        units
    );

    // Compile raw UTF-16 and an independently escaped scalar spelling of
    // exactly the same literal. Syntax delimiters and line terminators must
    // be escaped in both spellings; all other units are raw in the first.
    let mut raw: Vec<u16> = "var text = '".encode_utf16().collect();
    let mut escaped = String::from("var text = '");
    for &unit in &units {
        write!(&mut escaped, "\\u{unit:04x}").unwrap();
        if matches!(unit, 0x27 | 0x5c | 10 | 13 | 0x2028 | 0x2029) {
            raw.extend(format!("\\u{unit:04x}").encode_utf16());
        } else {
            raw.push(unit);
        }
    }
    let suffix = "'; String({toString(){return text}}) === text && new String(text).valueOf() === text && [text,text].join(text) === text + text + text && Object.prototype.toString.call({[Symbol.toStringTag]:text}) === '[object ' + text + ']'";
    raw.extend(suffix.encode_utf16());
    escaped.push_str(suffix);
    let raw = ironhorse_compile::compile_atoms_units_budgeted_with_limit(
        &raw,
        ironhorse_compile::Goal::Eval,
        false,
        u64::MAX,
        &mut |_| true,
    )
    .unwrap();
    let scalar = ironhorse_compile::compile_atoms_budgeted_with_limit(
        &escaped,
        ironhorse_compile::Goal::Eval,
        false,
        u64::MAX,
        &mut |_| true,
    )
    .unwrap();
    assert_eq!(raw.bytecode, scalar.bytecode);
    assert_eq!(raw.symbols, scalar.symbols);
    let mut vm = ironhorse_vm::Interp::new();
    vm.link_intrinsics(&ironhorse_vm::parse_symbols(&raw.symbols));
    let result = vm.run_bounded(&raw.bytecode, 100_000);
    assert!(result.completed, "{:?}", result.halt);
    assert_eq!(result.result, "true");
}
