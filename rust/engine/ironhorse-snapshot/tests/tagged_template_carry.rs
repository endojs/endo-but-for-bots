//! Tagged-template registry carry across heap suspend/resume.
//!
//! The registry itself is an inaccessible boot object whose ordinary
//! properties travel in the slot arena. This twin test proves a function's
//! source-site template identity survives resume, while a later independently
//! compiled crank with the same spelling receives a distinct site key.

mod common;

use common::TempDir;

use ironhorse_snapshot::machine::{begin_store_session, checkpoint_to_store, resume_from_store};
use ironhorse_snapshot::store::{validate_store, HeapStore, MemoryStore};
use ironhorse_snapshot::store_file::FileStore;
use ironhorse_snapshot::Signature;
use ironhorse_vm::{parse_symbols, Interp};

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

fn compile(source: &str) -> (Vec<u8>, Vec<String>) {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("compiles");
    (bytecode, parse_symbols(&symbols))
}

fn crank(machine: &mut Interp, source: &str) -> String {
    let (bytecode, names) = compile(source);
    let bytecode = machine.relink_crank(&bytecode, &names).expect("relink");
    let outcome = machine.run(&bytecode);
    assert!(outcome.completed, "crank halted: {:?}", outcome.halt);
    outcome.result
}

fn scenario(store: &mut dyn HeapStore) {
    let first = "var saved; function tag(strings){saved=saved||strings;return strings} function run(v){return tag`head${v}tail`} run(1)===saved";
    let same_site = "var s=run(2),d=Object.getOwnPropertyDescriptor(s,'0'),r=Object.getOwnPropertyDescriptor(s,'raw'); ''+(s===saved)+':'+d.writable+d.configurable+':'+r.writable+r.enumerable+r.configurable";
    let fresh_site = "var other=tag`head${3}tail`; other!==saved";

    let (bytecode, names) = compile(first);
    let mut continuous = Interp::new();
    continuous.link_intrinsics(&names);
    assert_eq!(continuous.run(&bytecode).result, "true");
    let expected_same = crank(&mut continuous, same_site);
    let expected_fresh = crank(&mut continuous, fresh_site);

    let mut persisted = Interp::new();
    persisted.link_intrinsics(&names);
    assert_eq!(persisted.run(&bytecode).result, "true");
    let session = begin_store_session(persisted, &sig(), store)
        .map_err(|(_, error)| error)
        .expect("persist template registry");
    drop(session);

    let mut resumed = resume_from_store(store, &sig()).expect("resume template registry");
    assert_eq!(
        crank(resumed.machine_mut(), same_site),
        expected_same,
        "same source site survives resume"
    );
    assert_eq!(expected_same, "true:falsefalse:falsefalsefalse");
    assert_eq!(
        crank(resumed.machine_mut(), fresh_site),
        expected_fresh,
        "later crank keeps a distinct template site"
    );
    assert_eq!(expected_fresh, "true");
    checkpoint_to_store(&mut resumed, &sig(), store).expect("checkpoint synthetic site key");
    drop(resumed);
    let mut resumed_again = resume_from_store(store, &sig()).expect("resume synthetic site key");
    assert_eq!(
        crank(resumed_again.machine_mut(), "other!==saved"),
        "true",
        "fresh site identity and its internal key survive a second resume"
    );
    checkpoint_to_store(&mut resumed_again, &sig(), store)
        .expect("checkpoint after second resume");
    validate_store(store, &sig()).expect("store remains valid");
}

#[test]
fn tagged_template_registry_survives_memory_and_file_snapshots() {
    scenario(&mut MemoryStore::new());

    let dir = TempDir::new("tagged-template-carry");
    let mut file = FileStore::open(dir.join("heap.ihstore")).expect("open file store");
    scenario(&mut file);
}
