//! Tagged-template registry carry across heap suspend/resume.
//!
//! The registry itself is an inaccessible boot object whose ordinary
//! properties travel in the slot arena. This twin test proves a function's
//! source-site template identity survives resume, while a later independently
//! compiled crank with the same spelling receives a distinct site key.

#[path = "common/twin.rs"]
mod carry;
mod common;
use carry::{compile, crank, sig, twin};

use common::TempDir;

use ironhorse_snapshot::machine::{checkpoint_to_store, resume_from_store};
use ironhorse_snapshot::store::{validate_store, HeapStore, MemoryStore};
use ironhorse_snapshot::store_file::FileStore;
use ironhorse_vm::Interp;

fn scenario(store: &mut dyn HeapStore) {
    let first = "var saved; function tag(strings){saved=saved||strings;return strings} function run(v){return tag`head${v}tail`} run(1)===saved";
    let same_site = "var s=run(2),d=Object.getOwnPropertyDescriptor(s,'0'),r=Object.getOwnPropertyDescriptor(s,'raw'); ''+(s===saved)+':'+d.writable+d.configurable+':'+r.writable+r.enumerable+r.configurable";
    let fresh_site = "var other=tag`head${3}tail`; other!==saved";

    let (bytecode, names) = compile(first);
    let mut continuous = Interp::new();
    continuous.link_intrinsics(&names);
    assert_eq!(continuous.run(&bytecode).result, "true");
    let expected = twin(first, &[same_site, fresh_site], store);
    assert!(expected.iter().all(|observation| observation.0));
    assert_eq!(expected[0].2, "true:falsefalse:falsefalsefalse");
    assert_eq!(expected[1].2, "true");
    for (source, expected) in [same_site, fresh_site].iter().zip(&expected) {
        assert_eq!(crank(&mut continuous, source), *expected);
    }
    // The shared twin checkpoints after creating the synthetic fresh-site key.
    // Resume that checkpoint again to cover the second persistence boundary.
    let mut resumed_again = resume_from_store(store, &sig()).expect("resume synthetic site key");
    let actual = crank(resumed_again.machine_mut(), "other!==saved");
    assert_eq!(
        actual,
        crank(&mut continuous, "other!==saved"),
        "fresh site identity and metering survive a second resume"
    );
    assert!(actual.0);
    assert_eq!(actual.2, "true");
    checkpoint_to_store(&mut resumed_again, &sig(), store).expect("checkpoint after second resume");
    validate_store(store, &sig()).expect("store remains valid");
}

#[test]
fn tagged_template_registry_survives_memory_and_file_snapshots() {
    scenario(&mut MemoryStore::new());

    let dir = TempDir::new("tagged-template-carry");
    let mut file = FileStore::open(dir.join("heap.ihstore")).expect("open file store");
    scenario(&mut file);
}
