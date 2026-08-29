//! Atomic retained guest-callability persistence (`FUNC`, schema v15).
//! Defining-crank bytecode, function metadata, bound-function slots,
//! constructor prototype links, and deleted metadata travel together.

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

fn crank(machine: &mut Interp, source: &str) -> (bool, String, String) {
    let (bytecode, names) = compile(source);
    let bytecode = machine.relink_crank(&bytecode, &names).expect("relink");
    let outcome = machine.run(&bytecode);
    (outcome.completed, format!("{:?}", outcome.halt), outcome.result)
}

fn twin(
    first: &str,
    observations: &[&str],
    store: &mut dyn HeapStore,
) -> Vec<(bool, String, String)> {
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
    assert_eq!(actual, expected, "resumed callability matches continuous");
    expected
}

fn assert_memory_and_file(
    name: &str,
    first: &str,
    observations: &[&str],
    expected: &[&str],
) {
    let mut memory = MemoryStore::new();
    let seen = twin(first, observations, &mut memory);
    assert_eq!(
        seen.iter().map(|(_, _, value)| value.as_str()).collect::<Vec<_>>(),
        expected,
    );

    let dir = TempDir::new(name);
    let mut file = FileStore::open(dir.join("heap.ihstore")).expect("open");
    twin(first, observations, &mut file);
}

#[test]
fn closure_capture_survives_resume() {
    assert_memory_and_file(
        "ih-functions-closure",
        "var f = 0; var t = 0; \
         (function () { var x = 40; f = function (y) { return x + y; }; })(); t = 7; t",
        &["var f; var t; t = f(2); t"],
        &["42"],
    );
}

#[test]
fn bound_function_state_survives_resume() {
    assert_memory_and_file(
        "ih-functions-bound",
        "var base = 0; var bound = 0; var t = 0; \
         base = function (a, b) { return a + b; }; \
         bound = base.bind(null, 20); t = 7; t",
        &["var bound; var t; t = bound(22); t"],
        &["42"],
    );
}

#[test]
fn constructor_links_survive_resume() {
    assert_memory_and_file(
        "ih-functions-constructor",
        "var F = 0; var held = 0; var t = 0; \
         F = function (x) { this.x = x; }; held = F.prototype; t = 7; t",
        &[
            "var F; var held; var t; var o = 0; \
             o = new F(42); t = o.x + ':' + (o instanceof F) + ':' + (F.prototype === held); t",
        ],
        &["42:true:true"],
    );
}

#[test]
fn deleted_function_metadata_stays_deleted() {
    assert_memory_and_file(
        "ih-functions-deleted-meta",
        "var f = 0; var t = 0; f = function named(a, b) { return a + b; }; \
         delete f.name; delete f.length; t = 7; t",
        &[
            "var f; var t; t = (Object.getOwnPropertyDescriptor(f, 'name') === undefined) + \
             ':' + (Object.getOwnPropertyDescriptor(f, 'length') === undefined); t",
        ],
        &["true:true"],
    );
}

#[test]
fn lazy_resume_keeps_cross_crank_callability() {
    use std::cell::RefCell;
    use std::rc::Rc;

    let (bytecode, names) =
        compile("var f = 0; var t = 0; f = function (x) { return x + 1; }; t = 7; t");
    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    assert!(machine.run(&bytecode).completed);
    let store = Rc::new(RefCell::new(MemoryStore::new()));
    drop(
        begin_store_session(machine, &sig(), &mut *store.borrow_mut())
            .map_err(|(_, error)| error)
            .expect("begin"),
    );
    let mut resumed = resume_from_store_lazy(store, &sig()).expect("lazy resume");
    assert_eq!(crank(resumed.machine_mut(), "var f; var t; t = f(41); t").2, "42");
}

#[test]
fn blob_resume_keeps_cross_crank_callability() {
    let (bytecode, names) =
        compile("var f = 0; var t = 0; f = function (x) { return x * 2; }; t = 7; t");
    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    assert!(machine.run(&bytecode).completed);
    let bytes = machine.write_snapshot(&sig()).expect("snapshot");
    let mut resumed = from_snapshot_bytes(&bytes, &sig()).expect("restore");
    assert_eq!(crank(&mut resumed, "var f; var t; t = f(21); t").2, "42");
}

#[test]
fn malformed_function_rows_are_refused() {
    let (bytecode, names) =
        compile("var f = 0; var t = 0; f = function (x) { return x + 1; }; t = 7; t");
    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    assert!(machine.run(&bytecode).completed);
    let bytes = machine.write_snapshot(&sig()).expect("snapshot");
    let image = read_machine(&bytes, &sig()).expect("read FUNC");
    assert_eq!(image.function_state.functions.len(), 1);

    let mut duplicate = image.clone();
    duplicate
        .function_state
        .functions
        .push(duplicate.function_state.functions[0].clone());
    match from_snapshot_bytes(&write_machine(&duplicate), &sig()) {
        Err(SnapshotError::Corrupt("function state: owners not strictly ascending")) => {}
        Err(other) => panic!("wrong duplicate-owner refusal: {other:?}"),
        Ok(_) => panic!("duplicate function owners must not restore"),
    }

    let mut out_of_range = image;
    out_of_range.function_state.functions[0].body_start = Some(u64::MAX);
    match from_snapshot_bytes(&write_machine(&out_of_range), &sig()) {
        Err(SnapshotError::Corrupt("function state: body range overflow")) => {}
        Err(other) => panic!("wrong body-range refusal: {other:?}"),
        Ok(_) => panic!("an overflowing function body must not restore"),
    }
}

#[test]
fn collection_compacts_unreferenced_code_segments() {
    let (bytecode, names) = compile("var f = 0; var t = 0; t = 7; t");
    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    assert!(machine.run(&bytecode).completed);
    for increment in 0..12 {
        let source = format!(
            "var f; var t; f = function (x) {{ return x + {increment}; }}; t = {increment}; t"
        );
        assert!(crank(&mut machine, &source).0);
    }
    assert!(machine.retained_code_segment_count() >= 12);
    machine.collect_garbage();
    assert_eq!(machine.retained_code_segment_count(), 1);
    assert_eq!(crank(&mut machine, "var f; var t; t = f(31); t").2, "42");
}
