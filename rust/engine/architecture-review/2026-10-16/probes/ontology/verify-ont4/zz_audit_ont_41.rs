//! Verifier probe (ONT-4): where does the first later-crank toJSON read miss?
#[path = "common/twin.rs"]
mod carry;
mod common;
use carry::{compile, crank};
use ironhorse_vm::Interp;

fn pos(m: &Interp, name: &str) -> Option<usize> {
    m.program_symbol_names().iter().position(|n| n.as_str() == Some(name)).map(|i| i + 1)
}

fn first(c1: &str) -> Interp {
    let (bc, names) = compile(c1);
    let mut m = Interp::new();
    m.link_intrinsics(&names);
    assert!(m.run(&bc).completed);
    m
}

fn run(c1: &str, c2: &str) {
    let mut m = first(c1);
    let (bc2, names2) = compile(c2);
    let code = m.relink_crank(&bc2, &names2).unwrap();
    let before = (m.program_symbol_names().len(), m.installed_names_floor(), pos(&m, "toJSON"), pos(&m, "toISOString"));
    let o = m.run(&code);
    let after = (m.program_symbol_names().len(), m.installed_names_floor(), pos(&m, "toJSON"), pos(&m, "toISOString"));
    println!("c1={c1:?} c2={c2:?}\n   -> {:?} {:?}\n   relinked (len,floor,toJSON,toISOString)={before:?} after={after:?}", o.result, o.halt);
}

#[test]
fn zz_audit_ont_41() {
    let c1 = "var t = 0; t";
    run(c1, "JSON.stringify(new Date(0))");
    run(c1, "JSON.stringify(new Date(0)) + ' ' + JSON.stringify(new Date(0))");
    run(c1, "JSON.stringify([new Date(0)])");
    run(c1, "JSON.stringify({ a: new Date(0) })");
    run(c1, "JSON.stringify({ a: 1 }) + ' ' + JSON.stringify(new Date(0))");
    run(c1, "var d = new Date(0); typeof d.toJSON + ' ' + JSON.stringify(d)");
    run(c1, "var d = new Date(0); d.toISOString(); JSON.stringify(d)");
    run(c1, "var r = JSON.stringify(new Date(0)); var k = 'to' + 'JSON'; r + ' ' + Object.prototype.hasOwnProperty.call(Date.prototype, k) + ' ' + JSON.stringify(new Date(0))");
    run(c1, "var o = { toJSON() { return 5; } }; JSON.stringify(o)");
    run(c1, "var o = JSON.parse('{\"z\":1}'); JSON.stringify(new Date(0))");
    run(c1, "JSON.stringify(Temporal.Instant.fromEpochMilliseconds(0))");
    run("JSON.stringify(1)", "JSON.stringify(new Date(0))");
    run("var d = new Date(0); 0", "JSON.stringify(d)");
    run("0", "JSON.stringify(new Date(0))");
}
