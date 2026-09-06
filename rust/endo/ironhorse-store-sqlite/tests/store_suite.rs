//! Instantiates the shared **backend-parameterized store acceptance
//! suite** (`ironhorse_snapshot::store_suite`) against the SQLite
//! backend, in-memory and on-disk — the seven-way metamorphic
//! determinism runner, the lazy working-set bound, and the checkpoint
//! acceptance locks. The reference backends run the identical suite
//! in the engine workspace, so backend parity is enforced by one
//! instrument rather than hand-mirrored tests; the real-JS lifecycle
//! scenarios in `engine_lifecycle.rs` remain this backend's own
//! deeper coverage (full close/reopen cycles, sidecar removal).

use ironhorse_snapshot::store_suite::{
    boundary_collection_twins, checkpoint_acceptance, lazy_working_set_bound, metamorphic_suite,
    resume_equals_uninterrupted,
};
use ironhorse_store_sqlite::SqliteHeapStore;

mod common;

fn in_memory() -> SqliteHeapStore {
    SqliteHeapStore::open_in_memory().expect("in-memory store opens")
}

#[test]
fn sqlite_in_memory_agrees_seven_ways() {
    metamorphic_suite(in_memory);
}

#[test]
fn sqlite_in_memory_twins_agree_after_a_boundary_collection() {
    boundary_collection_twins(in_memory);
}

#[test]
fn sqlite_in_memory_lazy_resume_faults_only_the_working_set() {
    lazy_working_set_bound(in_memory);
}

#[test]
fn sqlite_in_memory_checkpoint_acceptance() {
    let mut store = in_memory();
    checkpoint_acceptance(&mut store);
}

#[test]
fn sqlite_in_memory_resume_equals_uninterrupted() {
    let mut store = in_memory();
    resume_equals_uninterrupted(&mut store);
}

/// Fresh on-disk stores under one test-owned temp dir, removed at the
/// end. WAL and the full connection discipline engage on this path,
/// unlike `:memory:`.
fn with_disk_stores(name: &str, run: impl FnOnce(&mut dyn FnMut() -> SqliteHeapStore)) {
    let dir = common::TempDir::new(&format!(
        "ironhorse-sqlite-suite-{name}-{}",
        std::process::id()
    ));
    let mut n = 0u32;
    let mut fresh = {
        let dir = dir.to_path_buf();
        move || {
            n += 1;
            SqliteHeapStore::open(dir.join(format!("heap-{n}.sqlite"))).expect("disk store opens")
        }
    };
    run(&mut fresh);
}

#[test]
fn sqlite_on_disk_agrees_seven_ways() {
    with_disk_stores("metamorphic", |fresh| metamorphic_suite(fresh));
}

#[test]
fn sqlite_on_disk_lazy_resume_faults_only_the_working_set() {
    with_disk_stores("working-set", |fresh| lazy_working_set_bound(&mut *fresh));
}

#[test]
fn sqlite_on_disk_twins_agree_after_a_boundary_collection() {
    with_disk_stores("boundary-collection", |fresh| boundary_collection_twins(fresh));
}

#[test]
fn sqlite_on_disk_checkpoint_acceptance() {
    with_disk_stores("acceptance", |fresh| {
        let mut store = fresh();
        checkpoint_acceptance(&mut store);
        store.close().expect("full last-connection close");
    });
}

#[test]
fn sqlite_on_disk_resume_equals_uninterrupted() {
    with_disk_stores("resume", |fresh| {
        let mut store = fresh();
        resume_equals_uninterrupted(&mut store);
        store.close().expect("full last-connection close");
    });
}
