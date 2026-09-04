//! Review findings 2+3 (free-record hygiene), the honest-machine half:
//! a machine that ran a collection holds freed slot records whose
//! stale chunk offsets point outside the compacted chunk arena — the
//! sweep does not scrub records, and compaction remaps MARKED slots
//! only. Those snapshots are honest and must restore, on the eager
//! blob path, the eager store path, and the lazy fault path alike.
//! (The dual — refusing side-table rows OWNED by free slots — is
//! locked by the in-crate `free_records_are_opaque_and_free_owners_
//! are_refused` unit test.)

use std::cell::RefCell;
use std::rc::Rc;

use ironhorse_snapshot::machine::{
    begin_store_session, checkpoint_to_store, from_snapshot_bytes, resume_from_store,
    resume_from_store_lazy, MachineSnapshot,
};
use ironhorse_snapshot::store::MemoryStore;
use ironhorse_snapshot::Signature;
use ironhorse_vm::Interp;

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

fn compile(src: &str) -> (Vec<u8>, Vec<String>) {
    let (b, s) = ironhorse_compile::compile_atoms(src).expect("compiles");
    (b, ironhorse_vm::parse_symbols(&s))
}

fn crank(m: &mut Interp, src: &str) -> String {
    let (b, n) = compile(src);
    let b = m.relink_crank(&b, &n).expect("relink");
    let o = m.run(&b);
    assert!(o.completed, "crank: {:?}", o.halt);
    o.result
}

/// A machine whose collection freed large late-allocated strings:
/// their slot records return to the free list with chunk offsets the
/// compaction has since moved the arena out from under.
fn post_gc_machine() -> Interp {
    // The big string must live in a PROPERTY SLOT of a droppable
    // object (a heap record holding the chunk ref) — a global `var`
    // holds its string payload in the global property that survives.
    let (b, n) = compile(
        "var keep = 0; var junk = 0; var i = 0; var t = 0; \
         keep = 'kept'; junk = { s: 'x' }; \
         for (i = 0; i < 12; i++) { junk.s = junk.s + junk.s; } \
         t = junk.s.length; t",
    );
    let mut m = Interp::new();
    m.link_intrinsics(&n);
    let o = m.run(&b);
    assert!(o.completed, "crank 1: {:?}", o.halt);
    assert_eq!(o.result, "4096");
    let r = crank(&mut m, "var keep; var junk; var t; junk = 0; t = keep; t");
    assert_eq!(r, "kept");
    let stats = m.collect_garbage();
    assert!(
        stats.chunk_bytes_after < stats.chunk_bytes_before,
        "the fixture must compact chunks out from under the freed strings: {stats:?}"
    );
    assert!(stats.slots_reclaimed > 0, "and free their slot records: {stats:?}");
    m
}

/// The eager blob path: write → read must accept the post-GC image.
#[test]
fn a_post_gc_snapshot_with_stale_freed_records_round_trips_the_blob_path() {
    let m = post_gc_machine();
    let live_probe = "var keep; var t; t = keep + '!'; t";
    let bytes = m.write_snapshot(&sig()).expect("the writer serializes as-is");
    let mut m2 = from_snapshot_bytes(&bytes, &sig())
        .expect("freed records are opaque: the read gate must accept an honest post-GC image");
    assert_eq!(crank(&mut m2, live_probe), "kept!");
}

/// The eager store path: checkpoint → resume_from_store.
#[test]
fn a_post_gc_checkpoint_resumes_eagerly() {
    let m = post_gc_machine();
    let mut store = MemoryStore::new();
    let mut session = begin_store_session(m, &sig(), &mut store)
        .map_err(|(_, e)| e)
        .expect("begin");
    checkpoint_to_store(&mut session, &sig(), &mut store).expect("checkpoint");
    drop(session);
    let mut resumed = resume_from_store(&store, &sig())
        .expect("the store read gate must accept an honest post-GC epoch");
    assert_eq!(
        crank(resumed.machine_mut(), "var keep; var t; t = keep + '?'; t"),
        "kept?"
    );
}

/// The lazy path: every page — the ones holding freed records with
/// stale offsets included — must fault in without tripping the
/// per-record assertions.
#[test]
fn a_post_gc_checkpoint_resumes_lazily_and_faults_every_page() {
    let m = post_gc_machine();
    let mut store = MemoryStore::new();
    let mut session = begin_store_session(m, &sig(), &mut store)
        .map_err(|(_, e)| e)
        .expect("begin");
    checkpoint_to_store(&mut session, &sig(), &mut store).expect("checkpoint");
    drop(session);
    let shared = Rc::new(RefCell::new(store));
    let mut resumed = resume_from_store_lazy(shared, &sig()).expect("lazy resume");
    resumed.machine().slots.ensure_all_resident();
    assert_eq!(
        crank(resumed.machine_mut(), "var keep; var t; t = keep + '.'; t"),
        "kept."
    );
}
