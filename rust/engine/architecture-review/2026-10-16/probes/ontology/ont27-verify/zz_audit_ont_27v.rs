//! Verifier probe for ONT-27: re-run the ledger/persist-gate comparison, and
//! check whether the refusal survives dropping the compartment and collecting.
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
fn zz_audit_ont_27v() {
    println!("SideTable::pending() = {:?}", SideTable::pending());
    let mut by_cov = std::collections::BTreeMap::<String, usize>::new();
    for t in SideTable::ALL {
        *by_cov.entry(format!("{:?}", t.descriptor().coverage)).or_default() += 1;
    }
    println!("coverage histogram = {by_cov:?} (total {})", SideTable::ALL.len());
    for c in [Coverage::Pending, Coverage::BootDerived] {
        println!(
            "tables with {c:?}: {}",
            SideTable::ALL.iter().filter(|t| t.descriptor().coverage == c).count()
        );
    }
    println!(
        "any descriptor naming guest_compartments: {}",
        SideTable::ALL
            .iter()
            .any(|t| t.descriptor().field.contains("guest_compartments"))
    );
    for src in [
        "var c = 0; 0",
        "var c = new Compartment(); 0",
        "var c = new Compartment(); c = null; 0",
    ] {
        let mut m = machine(src);
        match m.write_snapshot(&sig()) {
            Ok(bytes) => println!("{src:?}: snapshot ok ({} bytes)", bytes.len()),
            Err(e) => println!("{src:?}: snapshot REFUSED: {e}"),
        }
        let gc = m.collect_garbage();
        println!("  collect_garbage -> {:?}", gc.map(|_| "ok"));
        match m.write_snapshot(&sig()) {
            Ok(bytes) => println!("  after GC: snapshot ok ({} bytes)", bytes.len()),
            Err(e) => println!("  after GC: snapshot REFUSED: {e}"),
        }
    }
}
