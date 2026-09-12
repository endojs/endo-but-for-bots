//! F144 across the persistent engine.
//!
//! The intrinsic-global permit is host configuration and does not ride the
//! snapshot, so the engine cannot recover it from a restored heap. The policy
//! is therefore DECLARED in [`HeapStoreOptions`] at every `open` — a required
//! field, not a machine default — and `PersistentMachine` retains it to
//! re-apply to the resumed heap after every rewind. Without that, the engine's
//! own relink could bind an intrinsic the owner had denied once the restored
//! install floor fell below a name interned before suspend: a silent widening
//! performed by the engine, not the guest.

#![cfg(feature = "ironhorse-engine")]

use endo::ironhorse_engine::engine::{
    CadencePolicy, HeapStoreOptions, MeterBounds, PersistentMachine,
};

fn options(dir: &std::path::Path, permit: Option<&[&str]>) -> HeapStoreOptions {
    HeapStoreOptions {
        path: dir.join("worker-heap.sqlite"),
        signature: "endor-ironhorse-worker-v1".to_string(),
        cadence: CadencePolicy::default(),
        meter: MeterBounds::per_crank(1_000_000),
        intrinsic_permit: permit
            .map(|names| names.iter().map(|name| (*name).to_string()).collect()),
    }
}

/// `JSON.parse` brings the property key `eval` into the realm symbol table
/// DURING the crank, after the crank's install pass, so the persisted floor
/// stays below it and a later relink considers it.
const INTERN_DENIED_NAME: &str = "JSON.parse('{\"eval\":1}')";

#[test]
fn permit_declared_at_open_is_reapplied_after_resume() {
    let dir = tempfile::tempdir().expect("temp dir");
    let options = options(dir.path(), Some(&["JSON"]));

    let mut machine = PersistentMachine::open(&options).unwrap();
    assert_eq!(
        machine.intrinsic_permit(),
        Some(["JSON".to_string()].as_slice())
    );
    machine.eval(INTERN_DENIED_NAME).unwrap();
    machine.close().unwrap();

    let mut machine = PersistentMachine::open(&options).unwrap();
    assert_eq!(
        machine.eval("typeof eval").unwrap().result,
        "undefined",
        "a resumed realm must not bind a denied intrinsic during relink"
    );
    assert_eq!(machine.eval("typeof JSON").unwrap().result, "object");
    machine.close().unwrap();
}

#[test]
fn permit_declared_at_open_is_reapplied_after_rewind() {
    let dir = tempfile::tempdir().expect("temp dir");
    let options = options(dir.path(), Some(&["JSON"]));

    let mut machine = PersistentMachine::open(&options).unwrap();
    machine.eval(INTERN_DENIED_NAME).unwrap();
    // A preparation failure rewinds to the last checkpoint, a fresh
    // interpreter with no host configuration attached.
    assert!(machine.eval("var = ;").is_err());
    assert_eq!(
        machine.eval("typeof eval").unwrap().result,
        "undefined",
        "a rewound realm must not bind a denied intrinsic during relink"
    );
    machine.close().unwrap();
}

#[test]
fn full_realm_is_an_explicit_declaration() {
    let dir = tempfile::tempdir().expect("temp dir");
    let options = options(dir.path(), None);

    let mut machine = PersistentMachine::open(&options).unwrap();
    assert_eq!(machine.intrinsic_permit(), None);
    assert_eq!(machine.eval("typeof eval").unwrap().result, "function");

    // Changing the live policy is an explicit owner act and applies to names
    // not yet bound (an already-bound global is not un-bound; see
    // `Interp::set_intrinsic_permit`). The policy is retained for a later
    // rewind.
    machine.set_intrinsic_permit(Some(&["JSON"]));
    assert_eq!(
        machine.intrinsic_permit(),
        Some(["JSON".to_string()].as_slice())
    );
    assert_eq!(machine.eval("typeof Function").unwrap().result, "undefined");
    machine.set_intrinsic_permit(None);
    assert_eq!(machine.eval("typeof Array").unwrap().result, "function");
    machine.close().unwrap();
}
