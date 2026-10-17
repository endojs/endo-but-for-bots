//! Audit probe (ontology/identity): the side-table ledger says nothing is
//! pending, yet a live guest Compartment (an Interp table classified as a
//! SATELLITE) refuses every snapshot.
#[path = "common/twin.rs"]
mod carry;
mod common;
use carry::{compile, sig};
use ironhorse_snapshot::machine::MachineSnapshot;
use ironhorse_snapshot::{Coverage, SideTable};
use ironhorse_vm::Interp;

fn machine(src: &str) -> Interp {
    let (bc, names) = compile(src);
    let mut m = Interp::new();
    m.link_intrinsics(&names);
    let o = m.run(&bc);
    assert!(o.completed, "{:?}", o.halt);
    m
}

#[test]
fn zz_audit_ont_2() {
    println!("SideTable::pending() = {:?}", SideTable::pending());
    let mut by_cov = std::collections::BTreeMap::<String, usize>::new();
    for t in SideTable::ALL {
        *by_cov.entry(format!("{:?}", t.descriptor().coverage)).or_default() += 1;
    }
    println!("coverage histogram = {by_cov:?}");
    println!(
        "any descriptor naming guest_compartments: {}",
        SideTable::ALL
            .iter()
            .any(|t| t.descriptor().field.contains("guest_compartments"))
    );
    let _ = Coverage::Pending;
    for src in ["var c = 0; 0", "var c = new Compartment(); 0", "var c = new Compartment(); c = null; 0"] {
        let m = machine(src);
        match m.write_snapshot(&sig()) {
            Ok(bytes) => println!("{src:?}: snapshot ok ({} bytes)", bytes.len()),
            Err(e) => println!("{src:?}: snapshot REFUSED: {e}"),
        }
    }
}
