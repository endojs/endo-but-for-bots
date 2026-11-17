//! Audit probe (ontology/identity): after the failing implicit read, is
//! `Date.prototype.toJSON` installed?
#[path = "common/twin.rs"]
mod carry;
mod common;
use carry::{compile, crank};
use ironhorse_vm::Interp;

fn run(c2: &str) {
    let (bc, names) = compile("var t = 0; t");
    let mut m = Interp::new();
    m.link_intrinsics(&names);
    assert!(m.run(&bc).completed);
    println!("{c2:?} -> {:?}", crank(&mut m, c2).2);
}

#[test]
fn zz_audit_ont_8() {
    run("var r = JSON.stringify(new Date(0)); var k = 'to' + 'JSON'; var p = Object.getOwnPropertyDescriptor(Date.prototype, k); r + ' ' + typeof (p && p.value) + ' ' + JSON.stringify(new Date(0))");
    run("var k = 'to' + 'JSON'; var d = new Date(0); var f = d[k]; typeof f + ' ' + JSON.stringify(d)");
    run("var o = JSON.parse('{\"a\":1}'); JSON.stringify(new Date(0))");
    run("JSON.stringify([new Date(0)])");
}
