//! Audit probe (ontology/identity): a later crank's JSON.stringify of a Date.
#[path = "common/twin.rs"]
mod carry;
mod common;
use carry::{compile, crank, sig};
use ironhorse_snapshot::machine::{from_snapshot_bytes, MachineSnapshot};
use ironhorse_vm::Interp;

fn first(c1: &str) -> Interp {
    let (bc, names) = compile(c1);
    let mut m = Interp::new();
    m.link_intrinsics(&names);
    let o = m.run(&bc);
    assert!(o.completed, "{:?}", o.halt);
    m
}

fn case(c1: &str, c2: &str) {
    let mut m = first(c1);
    let floor = m.installed_names_floor();
    let live = crank(&mut m, c2);
    let mut r = from_snapshot_bytes(&first(c1).write_snapshot(&sig()).unwrap(), &sig()).unwrap();
    let resumed = crank(&mut r, c2);
    println!("c1={c1:?} (floor {floor}) c2={c2:?}\n   live    -> {:?} {}\n   resumed -> {:?} {}", live.2, live.3, resumed.2, resumed.3);
}

#[test]
fn zz_audit_ont_5() {
    // Single crank (the first link supplies `Date`).
    let (bc, names) = compile("JSON.stringify(new Date(0))");
    let mut m = Interp::new();
    m.link_intrinsics(&names);
    let o = m.run(&bc);
    println!("single crank -> {:?} {}", o.result, o.computrons);
    case("0", "JSON.stringify(new Date(0))");
    case("var d = new Date(0); 0", "JSON.stringify(d)");
    case("0", "JSON.stringify({ when: new Date(0) })");
    case("0", "typeof new Date(0).toISOString");
    case("0", "[typeof Date.prototype.toJSON, JSON.stringify(new Date(0))].join(' ')");
    case("0", "var x = new Date(0); x.toJSON === undefined");
    case("JSON.stringify(1)", "JSON.stringify(new Date(0))");
}
