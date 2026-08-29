//! Proxy internal slots and revoker links persist in `PROX`
//! (store schema v16), after their guest trap functions in `FUNC`.

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

fn twin(first: &str, observation: &str, store: &mut dyn HeapStore) -> (bool, String, String) {
    let (bytecode, names) = compile(first);

    let mut continuous = Interp::new();
    continuous.link_intrinsics(&names);
    assert!(continuous.run(&bytecode).completed);
    let expected = crank(&mut continuous, observation);

    let mut suspended = Interp::new();
    suspended.link_intrinsics(&names);
    assert!(suspended.run(&bytecode).completed);
    drop(
        begin_store_session(suspended, &sig(), store)
            .map_err(|(_, error)| error)
            .expect("begin"),
    );
    let mut resumed = resume_from_store(store, &sig()).expect("resume");
    let actual = crank(resumed.machine_mut(), observation);
    assert_eq!(actual, expected, "resumed Proxy state matches continuous");
    expected
}

const FIRST: &str = "var p = 0; var t = 0; var target = 0; var handler = 0; \
     target = { x: 1 }; \
     handler = { get: function (object, key) { if (key === 'x') return 42; return object[key]; } }; \
     p = new Proxy(target, handler); t = 7; t";
const OBSERVATION: &str = "var p; var t; t = p.x; t";

#[test]
fn proxy_traps_survive_memory_and_file_resume() {
    let mut memory = MemoryStore::new();
    assert_eq!(twin(FIRST, OBSERVATION, &mut memory).2, "42");

    let dir = TempDir::new("ih-proxy-carry");
    let mut file = FileStore::open(dir.join("heap.ihstore")).expect("open");
    assert_eq!(twin(FIRST, OBSERVATION, &mut file).2, "42");
}

#[test]
fn revoker_function_survives_resume() {
    let first = "var p = 0; var revoke = 0; var pair = 0; var t = 0; \
         pair = Proxy.revocable({ x: 42 }, {}); p = pair.proxy; revoke = pair.revoke; t = 7; t";
    let observation = "var p; var revoke; var t; \
         t = p.x; revoke(); \
         try { p.x; t = 'miss'; } catch (e) { t = t + ':' + (e instanceof TypeError); } t";
    let mut store = MemoryStore::new();
    assert_eq!(twin(first, observation, &mut store).2, "42:true");
}

#[test]
fn lazy_resume_preserves_proxy_traps() {
    use std::cell::RefCell;
    use std::rc::Rc;

    let (bytecode, names) = compile(FIRST);
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
    assert_eq!(crank(resumed.machine_mut(), OBSERVATION).2, "42");
}

#[test]
fn blob_resume_preserves_proxy_traps() {
    let (bytecode, names) = compile(FIRST);
    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    assert!(machine.run(&bytecode).completed);
    let bytes = machine.write_snapshot(&sig()).expect("snapshot");
    let mut resumed = from_snapshot_bytes(&bytes, &sig()).expect("restore");
    assert_eq!(crank(&mut resumed, OBSERVATION).2, "42");
}

#[test]
fn malformed_proxy_rows_are_refused() {
    let (bytecode, names) = compile(FIRST);
    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    assert!(machine.run(&bytecode).completed);
    let bytes = machine.write_snapshot(&sig()).expect("snapshot");
    let image = read_machine(&bytes, &sig()).expect("read PROX");

    let mut duplicate = image.clone();
    duplicate
        .proxy_state
        .proxies
        .push(duplicate.proxy_state.proxies[0].clone());
    match from_snapshot_bytes(&write_machine(&duplicate), &sig()) {
        Err(SnapshotError::Corrupt("proxy state: owners not strictly ascending")) => {}
        Err(other) => panic!("wrong duplicate-owner refusal: {other:?}"),
        Ok(_) => panic!("duplicate proxy owners must not restore"),
    }

    let mut revoked = image;
    revoked.proxy_state.proxies[0].revoked = true;
    match from_snapshot_bytes(&write_machine(&revoked), &sig()) {
        Err(SnapshotError::Corrupt(
            "proxy state: revoked proxy retains target or handler",
        )) => {}
        Err(other) => panic!("wrong revoked-row refusal: {other:?}"),
        Ok(_) => panic!("a revoked proxy cannot retain live internals"),
    }
}
