//! Verifier probe (ONT-4): which names does a later crank intern, and when?
#[path = "common/twin.rs"]
mod carry;
mod common;
use carry::compile;
use ironhorse_vm::Interp;

fn tail(m: &Interp, from: usize) -> Vec<String> {
    m.program_symbol_names()[from..].iter().map(|n| format!("{:?}", n.as_str())).collect()
}

fn run(c1: &str, c2: &str) {
    let (bc, names) = compile(c1);
    let mut m = Interp::new();
    m.link_intrinsics(&names);
    assert!(m.run(&bc).completed);
    let base = m.program_symbol_names().len();
    let (bc2, names2) = compile(c2);
    let code = m.relink_crank(&bc2, &names2).unwrap();
    let relinked = (m.program_symbol_names().len(), m.installed_names_floor());
    let o = m.run(&code);
    println!("c1={c1:?} c2={c2:?}\n   -> {:?} {:?}\n   base={base} relinked={relinked:?} after=({}, {}) tail={:?}",
        o.result, o.halt, m.program_symbol_names().len(), m.installed_names_floor(), tail(&m, base.min(80)));
}

#[test]
fn zz_audit_ont_42() {
    let c1 = "var t = 0; t";
    run(c1, "new Date(0); 0");
    run(c1, "JSON.stringify(1)");
    run(c1, "JSON.stringify({})");
    run(c1, "JSON.stringify([])");
    run(c1, "JSON.stringify(new Date(0))");
    run(c1, "JSON.stringify(new Map())");
    run(c1, "JSON.stringify(Object(1))");
}
