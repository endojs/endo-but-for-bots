//! Audit probe (ontology/identity): does any persisted identity move when a
//! guest-visible native behavior changes? Built twice: in a copy of
//! 61cd656c with aaec6a06's VM change reverted ("old"), and in the repo at
//! 61cd656c ("new"). The old build writes a crank-1 snapshot; the new build
//! adopts it and runs crank 2.
#[path = "common/twin.rs"]
mod carry;
mod common;
use carry::{compile, crank, sig};
use ironhorse_snapshot::machine::{from_snapshot_bytes, MachineSnapshot};
use ironhorse_vm::Interp;

const SNAP: &str = "../../../probes/ontology/identity/old_crank1.snap";
const CRANK1: &str = "var d = 0; 0";
const CRANK2: &str = "JSON.stringify(new Date(0))";

fn identity(label: &str) {
    let boot = Interp::boot_fingerprint();
    let hex: String = boot.iter().map(|b| format!("{b:02x}")).collect();
    println!(
        "[{label}] boot_fingerprint={} meter={} digest={} format={} store={} row={}",
        &hex[..16],
        ironhorse_vm::COST_TABLE_VERSION,
        &ironhorse_snapshot::sha256::hex(&ironhorse_vm::cost_table::digest())[..16],
        ironhorse_snapshot::format::IRONHORSE_FORMAT_VERSION,
        ironhorse_snapshot::store::STORE_SCHEMA_VERSION,
        ironhorse_vm::snapshot_api::ROW_SCHEMA_VERSION,
    );
}

#[test]
fn zz_audit_ont_4() {
    let role = std::env::var("ZZ_ROLE").unwrap_or_default();
    identity(&role);
    if role == "old" {
        let (bc, names) = compile(CRANK1);
        let mut m = Interp::new();
        m.link_intrinsics(&names);
        assert!(m.run(&bc).completed);
        let bytes = m.write_snapshot(&sig()).expect("snapshot");
        std::fs::write(SNAP, &bytes).unwrap();
        println!("[old] wrote {} bytes", bytes.len());
        println!("[old] continuous crank 2 -> {:?}", crank(&mut m, CRANK2));
    } else {
        let bytes = std::fs::read(SNAP).expect("old snapshot");
        match from_snapshot_bytes(&bytes, &sig()) {
            Ok(mut m) => {
                println!("[new] ADOPTED the old build's snapshot");
                println!("[new] resumed crank 2 -> {:?}", crank(&mut m, CRANK2));
            }
            Err(e) => println!("[new] refused the old build's snapshot: {e}"),
        }
        let (bc, names) = compile(CRANK1);
        let mut m = Interp::new();
        m.link_intrinsics(&names);
        assert!(m.run(&bc).completed);
        println!("[new] continuous crank 2 -> {:?}", crank(&mut m, CRANK2));
    }
}
