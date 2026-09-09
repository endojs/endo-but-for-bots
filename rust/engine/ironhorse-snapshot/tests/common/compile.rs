//! Compile a guest fixture without depending on a persistence driver.
use ironhorse_vm::{parse_symbols, SymbolName};

pub fn compile(source: &str) -> (Vec<u8>, Vec<SymbolName>) {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("compiles");
    (bytecode, parse_symbols(&symbols))
}
