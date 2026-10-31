//! Audit probe (ontology/identity): where is `toJSON` relative to the
//! installed-names floor when a later crank's JSON.stringify reads it?
#[path = "common/twin.rs"]
mod carry;
mod common;
use carry::compile;
use ironhorse_vm::Interp;

fn pos(m: &Interp, name: &str) -> Option<usize> {
    m.program_symbol_names().iter().position(|n| n.as_str() == Some(name)).map(|i| i + 1)
}

#[test]
fn zz_audit_ont_6() {
    let (bc, names) = compile("var t = 0; t");
    let mut m = Interp::new();
    m.link_intrinsics(&names);
    assert!(m.run(&bc).completed);
    println!("after crank 1: len={} floor={} toJSON@{:?} Date@{:?}", m.program_symbol_names().len(), m.installed_names_floor(), pos(&m, "toJSON"), pos(&m, "Date"));
    let (bc2, names2) = compile("JSON.stringify(new Date(0))");
    let code = m.relink_crank(&bc2, &names2).unwrap();
    println!("after relink 2: len={} floor={} toJSON@{:?} stringify@{:?}", m.program_symbol_names().len(), m.installed_names_floor(), pos(&m, "toJSON"), pos(&m, "stringify"));
    let o = m.run(&code);
    println!("crank 2 -> {:?}; len={} floor={} toJSON@{:?}", o.result, m.program_symbol_names().len(), m.installed_names_floor(), pos(&m, "toJSON"));
    let (bc3, names3) = compile("JSON.stringify(new Date(0))");
    let code = m.relink_crank(&bc3, &names3).unwrap();
    let o = m.run(&code);
    println!("crank 3 (same source) -> {:?}", o.result);
}
