//! Guest accessor getter/setter mappings persist in `ACCS`
//! (store schema v17). Exact boot seeds remain restore-derived.

mod common;

use common::TempDir;

use ironhorse_snapshot::image::{read_machine, write_machine};
use ironhorse_snapshot::machine::{
    begin_store_session, from_snapshot_bytes, resume_from_store, resume_from_store_lazy,
    MachineSnapshot,
};
use ironhorse_snapshot::store::{HeapStore, MemoryStore};
use ironhorse_snapshot::store_file::FileStore;
use ironhorse_snapshot::{Signature, SnapshotError};
use ironhorse_vm::{parse_symbols, Interp};

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

fn compile(source: &str) -> (Vec<u8>, Vec<String>) {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("compiles");
    (bytecode, parse_symbols(&symbols))
}

/// Relink and run one crank, returning `(completed, halt debug, result,
/// computrons)`. The COMPUTRON count is part of the observation: a
/// resumed machine that answers correctly while charging differently
/// has still diverged, and consensus is on the count as much as the
/// value. Every twin below therefore compares metering too.
fn crank(machine: &mut Interp, source: &str) -> (bool, String, String, u64) {
    let (bytecode, names) = compile(source);
    let bytecode = machine.relink_crank(&bytecode, &names).expect("relink");
    let outcome = machine.run(&bytecode);
    (outcome.completed, format!("{:?}", outcome.halt), outcome.result, outcome.computrons)
}

fn twin(
    first: &str,
    observations: &[&str],
    store: &mut dyn HeapStore,
) -> Vec<(bool, String, String, u64)> {
    let (bytecode, names) = compile(first);
    let mut continuous = Interp::new();
    continuous.link_intrinsics(&names);
    assert!(continuous.run(&bytecode).completed);
    let expected: Vec<_> = observations
        .iter()
        .map(|source| crank(&mut continuous, source))
        .collect();

    let mut suspended = Interp::new();
    suspended.link_intrinsics(&names);
    assert!(suspended.run(&bytecode).completed);
    drop(
        begin_store_session(suspended, &sig(), store)
            .map_err(|(_, error)| error)
            .expect("begin"),
    );
    let mut resumed = resume_from_store(store, &sig()).expect("resume");
    let actual: Vec<_> = observations
        .iter()
        .map(|source| crank(resumed.machine_mut(), source))
        .collect();
    assert_eq!(actual, expected, "resumed accessors match continuous");
    expected
}

const FIRST: &str = "var o = 0; var hidden = 40; var t = 0; o = {}; \
     Object.defineProperty(o, 'x', { \
       get: function () { return hidden + 2; }, \
       set: function (value) { hidden = value; }, configurable: true }); t = 7; t";

#[test]
fn guest_getters_and_setters_survive_memory_and_file_resume() {
    let observations = [
        "var o; var t; t = o.x; t",
        "var o; var t; o.x = 9; t = o.x; t",
    ];
    let mut memory = MemoryStore::new();
    let seen = twin(FIRST, &observations, &mut memory);
    assert_eq!(seen.iter().map(|row| row.2.as_str()).collect::<Vec<_>>(), ["42", "11"]);

    let dir = TempDir::new("ih-accessor-carry");
    let mut file = FileStore::open(dir.join("heap.ihstore")).expect("open");
    twin(FIRST, &observations, &mut file);
}

#[test]
fn guest_redefinition_of_a_boot_seed_survives_resume() {
    let mut store = MemoryStore::new();
    let seen = twin(
        "var t = 0; \
         Object.defineProperty(Intl.NumberFormat.prototype, 'format', \
           { get: function () { return 42; }, configurable: true }); t = 7; t",
        &["var t; t = Intl.NumberFormat.prototype.format; t"],
        &mut store,
    );
    assert_eq!(seen[0].2, "42");
}

#[test]
fn lazy_and_blob_resume_preserve_accessors() {
    use std::cell::RefCell;
    use std::rc::Rc;

    let (bytecode, names) = compile(FIRST);
    let observation = "var o; var t; t = o.x; t";
    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    assert!(machine.run(&bytecode).completed);
    let bytes = machine.write_snapshot(&sig()).expect("snapshot");
    let mut blob = from_snapshot_bytes(&bytes, &sig()).expect("blob restore");
    assert_eq!(crank(&mut blob, observation).2, "42");

    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    assert!(machine.run(&bytecode).completed);
    let store = Rc::new(RefCell::new(MemoryStore::new()));
    drop(
        begin_store_session(machine, &sig(), &mut *store.borrow_mut())
            .map_err(|(_, error)| error)
            .expect("begin"),
    );
    let mut lazy = resume_from_store_lazy(store, &sig()).expect("lazy restore");
    assert_eq!(crank(lazy.machine_mut(), observation).2, "42");
}

#[test]
fn malformed_accessor_rows_are_refused() {
    let (bytecode, names) = compile(FIRST);
    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    assert!(machine.run(&bytecode).completed);
    let bytes = machine.write_snapshot(&sig()).expect("snapshot");
    let image = read_machine(&bytes, &sig()).expect("read ACCS");
    assert!(
        image.accessors.len() >= 2,
        "guest accessor and boot TypedArray tag accessor must be present"
    );

    let mut duplicate = image.clone();
    duplicate.accessors.push(duplicate.accessors[0].clone());
    match from_snapshot_bytes(&write_machine(&duplicate), &sig()) {
        Err(SnapshotError::Corrupt("accessor state: rows not strictly ascending")) => {}
        Err(other) => panic!("wrong duplicate-row refusal: {other:?}"),
        Ok(_) => panic!("duplicate accessors must not restore"),
    }

    let mut bad_id = image;
    bad_id.accessors[0].id = 0;
    match from_snapshot_bytes(&write_machine(&bad_id), &sig()) {
        Err(SnapshotError::Corrupt(
            "accessor state: id outside the property-key tables",
        )) => {}
        Err(other) => panic!("wrong accessor-id refusal: {other:?}"),
        Ok(_) => panic!("an unregistered accessor id must not restore"),
    }
}
