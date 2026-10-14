//! `WeakRef` targets and `FinalizationRegistry` cells persist (`WKRF` and
//! `FNRG`, store schema 37 / format 25): a resumed machine's `deref`
//! answers what the uninterrupted machine's would, a registration still
//! unregisters by its token, a target a collection cleared BEFORE the
//! checkpoint stays cleared, and a registry flagged for cleanup runs its
//! callback at the resumed machine's next job boundary. Every arm is an
//! uninterrupted-vs-resumed twin in the carry-suite discipline
//! (`disposable_stack_carry.rs`), and the crafted rows exercise the decode
//! and bounds gates from the refusing side.

#[path = "common/twin.rs"]
mod carry;
mod common;
use carry::{compile, crank, sig, twin};

use common::TempDir;

use ironhorse_snapshot::image::{read_machine, write_machine_unchecked};
use ironhorse_snapshot::machine::{
    begin_store_session, from_snapshot_bytes, resume_from_store_lazy, MachineSnapshot,
};
use ironhorse_snapshot::store::MemoryStore;
use ironhorse_snapshot::store_file::FileStore;
use ironhorse_snapshot::SnapshotError;
use ironhorse_vm::Interp;

/// A live target, a registration keyed by a token, and a second
/// registration without one.
const FIRST: &str = "var log = []; var keep = 0; var w = 0; var r = 0; var t = 0; var seen = 0; \
     keep = {v: 1}; t = {}; \
     w = new WeakRef(keep); \
     r = new FinalizationRegistry(function (held) { log.push(held); }); \
     r.register(keep, 'kept', t); \
     r.register(keep, 'kept-too'); \
     seen = w.deref().v; seen";

const OBSERVATIONS: &[&str] = &[
    "var w; var keep; var seen; seen = (w.deref() === keep) + ':' + w.deref().v; seen",
    "var r; var t; var seen; seen = r.unregister(t) + ':' + r.unregister(t); seen",
    "var w; var r; var seen; seen = Object.prototype.toString.call(w) + Object.prototype.toString.call(r); seen",
    "var log; var seen; seen = log.length; seen",
];

#[test]
fn live_targets_and_registrations_survive_memory_and_file_resume() {
    let expected = [
        "true:1",
        "true:false",
        "[object WeakRef][object FinalizationRegistry]",
        "0",
    ];
    let mut memory = MemoryStore::new();
    let seen = twin(FIRST, OBSERVATIONS, &mut memory);
    assert_eq!(
        seen.iter().map(|o| o.2.as_str()).collect::<Vec<_>>(),
        expected
    );

    let dir = TempDir::new("ih-weak-ref-live");
    let mut file = FileStore::open(dir.join("heap.ihstore")).expect("open");
    let seen = twin(FIRST, OBSERVATIONS, &mut file);
    assert_eq!(
        seen.iter().map(|o| o.2.as_str()).collect::<Vec<_>>(),
        expected
    );
}

/// Build the machine, let the collector clear what nothing references, and
/// return it at the boundary: the WeakRef target is nulled and the registry
/// holds a dead cell behind its CHANGED flag, exactly the state the rows
/// must carry.
fn collected() -> (Interp, Vec<ironhorse_vm::SymbolName>) {
    let (bytecode, names) = compile(
        "var log = []; var w = 0; var r = 0; var keep = 0; var seen = 0; \
         keep = {}; \
         w = new WeakRef({}); \
         r = new FinalizationRegistry(function (held) { log.push(held); }); \
         r.register({}, 'dead'); \
         r.register(keep, 'alive', keep); \
         seen = typeof w.deref(); seen",
    );
    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    assert!(machine.run(&bytecode).completed);
    machine.collect_garbage().expect("collect at the boundary");
    (machine, names)
}

const CLEARED: &str = "var w; var seen; seen = typeof w.deref(); seen";
const LOG: &str = "var log; var seen; seen = log.join(); seen";

#[test]
fn cleared_targets_and_pending_cleanups_survive_blob_and_lazy_resume() {
    use std::cell::RefCell;
    use std::rc::Rc;

    let (machine, _) = collected();
    let bytes = machine.write_snapshot(&sig()).expect("snapshot");
    let image = read_machine(&bytes, &sig()).expect("read");
    assert_eq!(image.weak_refs.len(), 1);
    assert_eq!(
        image.weak_refs[0].target,
        u32::MAX,
        "the cleared target travels cleared"
    );
    assert_eq!(image.finalization_registries.len(), 1);
    let registry = &image.finalization_registries[0];
    assert!(registry.changed, "the pending cleanup travels flagged");
    assert_eq!(registry.cells.len(), 2);
    assert_eq!(registry.cells[0].target, u32::MAX);
    assert_ne!(registry.cells[1].target, u32::MAX);
    assert_ne!(registry.cells[1].token, u32::MAX);

    let mut blob = from_snapshot_bytes(&bytes, &sig()).expect("blob restore");
    assert_eq!(crank(&mut blob, CLEARED).2, "undefined");
    // The flagged registry runs its cleanup at the resumed machine's first
    // job boundary, once: the next crank reads the held value, the one
    // after reads nothing new, and the live cell stays registered.
    assert_eq!(crank(&mut blob, LOG).2, "dead");
    assert_eq!(crank(&mut blob, LOG).2, "dead");
    assert_eq!(
        crank(
            &mut blob,
            "var r; var keep; var seen; seen = r.unregister(keep); seen"
        )
        .2,
        "true"
    );

    let (machine, _) = collected();
    let store = Rc::new(RefCell::new(MemoryStore::new()));
    drop(
        begin_store_session(machine, &sig(), &mut *store.borrow_mut())
            .map_err(|(_, error)| error)
            .expect("begin"),
    );
    let mut lazy = resume_from_store_lazy(store, &sig()).expect("lazy restore");
    assert_eq!(crank(lazy.machine_mut(), CLEARED).2, "undefined");
    assert_eq!(crank(lazy.machine_mut(), LOG).2, "dead");
    assert_eq!(crank(lazy.machine_mut(), LOG).2, "dead");
}

#[test]
fn a_live_target_is_held_by_its_own_references_not_by_the_row() {
    // After resume the collector finds the same graph: the kept target
    // survives while the guest references it, and dies once it lets go.
    let (bytecode, names) = compile(
        "var w = 0; var keep = 0; var seen = 0; keep = {}; w = new WeakRef(keep); seen = 1; seen",
    );
    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    assert!(machine.run(&bytecode).completed);
    let bytes = machine.write_snapshot(&sig()).expect("snapshot");
    let mut resumed = from_snapshot_bytes(&bytes, &sig()).expect("blob restore");
    resumed.collect_garbage().expect("collect");
    assert_eq!(crank(&mut resumed, CLEARED).2, "object");
    assert_eq!(
        crank(
            &mut resumed,
            "var keep; var seen; keep = null; seen = 2; seen"
        )
        .2,
        "2"
    );
    resumed.collect_garbage().expect("collect");
    assert_eq!(crank(&mut resumed, CLEARED).2, "undefined");
}

#[test]
fn crafted_rows_are_refused_at_the_gates() {
    let (machine, _) = collected();
    let bytes = machine.write_snapshot(&sig()).expect("snapshot");

    // A target past the arena.
    let mut image = read_machine(&bytes, &sig()).expect("read");
    image.weak_refs[0].target = image.slots.len() as u32;
    assert!(
        matches!(
            from_snapshot_bytes(&write_machine_unchecked(&image), &sig()),
            Err(SnapshotError::Corrupt("slot index out of arena bounds"))
        ),
        "an out-of-arena WeakRef target must not restore"
    );

    // A target on the free list: the sweep nulls a dying target before it
    // frees the slot, so a row naming a free slot can only be crafted.
    let mut image = read_machine(&bytes, &sig()).expect("read");
    image.weak_refs[0].target = image.slot_free[0];
    assert!(
        matches!(
            from_snapshot_bytes(&write_machine_unchecked(&image), &sig()),
            Err(SnapshotError::Corrupt("side table names a free slot"))
        ),
        "a freed WeakRef target must not restore"
    );

    // A CHANGED flag with every cell alive: the cleanup clears the flag
    // once no dead cell remains.
    let mut image = read_machine(&bytes, &sig()).expect("read");
    let live = image.finalization_registries[0].cells[1].clone();
    image.finalization_registries[0].cells = vec![live];
    assert!(
        matches!(
            from_snapshot_bytes(&write_machine_unchecked(&image), &sig()),
            Err(SnapshotError::Corrupt(
                "finalization registries: flagged registry holds no dead cell"
            ))
        ),
        "a flagged registry with no dead cell must not restore"
    );

    // A callback that is not a reference.
    let mut image = read_machine(&bytes, &sig()).expect("read");
    image.finalization_registries[0].callback = ironhorse_vm::Slot::integer(1);
    assert!(
        matches!(
            from_snapshot_bytes(&write_machine_unchecked(&image), &sig()),
            Err(SnapshotError::Corrupt(
                "finalization registries: cleanup callback is not a reference"
            ))
        ),
        "a non-callable callback must not restore"
    );

    // A token on the free list.
    let mut image = read_machine(&bytes, &sig()).expect("read");
    image.finalization_registries[0].cells[1].token = image.slot_free[0];
    assert!(
        matches!(
            from_snapshot_bytes(&write_machine_unchecked(&image), &sig()),
            Err(SnapshotError::Corrupt("side table names a free slot"))
        ),
        "a freed token must not restore"
    );
}

#[test]
fn a_machine_holding_neither_writes_no_weak_atoms() {
    // The atoms are content-determined: a machine without a WeakRef or a
    // registry writes the format-24 atom sequence under the new stamp.
    let (bytecode, names) = compile("var seen = 0; seen = 1; seen");
    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    assert!(machine.run(&bytecode).completed);
    let bytes = machine.write_snapshot(&sig()).expect("snapshot");
    let image = read_machine(&bytes, &sig()).expect("read");
    assert!(image.weak_refs.is_empty());
    assert!(image.finalization_registries.is_empty());
    assert!(!bytes.windows(4).any(|w| w == b"WKRF"));
    assert!(!bytes.windows(4).any(|w| w == b"FNRG"));
}
