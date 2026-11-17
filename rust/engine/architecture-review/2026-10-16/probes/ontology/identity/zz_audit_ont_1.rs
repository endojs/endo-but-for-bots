//! Audit probe (ontology/identity): is `pending_surfaces` (classified a
//! never-persisted SATELLITE) behaviorally inert across resume?
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

fn case(label: &str, c1: &str, later: &[&str]) {
    let mut live = first(c1);
    let bytes = first(c1).write_snapshot(&sig()).expect("snapshot");
    let mut resumed = from_snapshot_bytes(&bytes, &sig()).expect("restore");
    println!("=== {label}");
    for src in later {
        let a = crank(&mut live, src);
        let b = crank(&mut resumed, src);
        println!("  crank {src:?}\n    live    = {a:?}\n    resumed = {b:?}");
    }
    let lb = live.write_snapshot(&sig()).expect("live snap");
    let rb = resumed.write_snapshot(&sig()).expect("resumed snap");
    println!("  final container bytes equal: {} (live {} B, resumed {} B)", lb == rb, lb.len(), rb.len());
}

#[test]
fn zz_audit_ont_1() {
    case(
        "control: nothing touches a completed surface",
        "Reflect.ownKeys(Map.prototype); 0",
        &["var q = 1; q"],
    );
    case(
        "new key on a surface the live twin completed, with a runtime-interned member name pending",
        "Reflect.ownKeys(Map.prototype); 0",
        &[
            "var o = JSON.parse('{\"hypot\":1}'); var k = Object.keys(o)[0]; Map.prototype.zz = 1; 0",
            "var k; typeof Math[k]",
        ],
    );
    case(
        "same, and the guest deletes the pending member before the next relink",
        "Reflect.ownKeys(Map.prototype); 0",
        &[
            "var o = JSON.parse('{\"hypot\":1}'); var k = Object.keys(o)[0]; Map.prototype.zz = 1; delete Math[k]; 0",
            "var k; typeof Math[k]",
        ],
    );
    case(
        "live-only semantics: delete of a pending member, then a relink",
        "0",
        &[
            "var o = JSON.parse('{\"hypot\":1}'); var k = Object.keys(o)[0]; delete Math[k]; typeof Math[k]",
            "var k; typeof Math[k]",
        ],
    );
}
