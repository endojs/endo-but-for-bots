//! The session the harness's exports drive: one product
//! `thixotrope_ironhorse_core::Worker` over one `DoStore`, held in a
//! thread-local, plus what only the harness needs (a clean store per begin,
//! container import and export, residency counters). Every crank, the
//! collection and finalizer cascade that end it, the protocol and the commit
//! are the core's; nothing here runs the engine by other means.

// `StoreError` is the store trait's error type, which the harness does not
// choose.
#![allow(clippy::result_large_err)]

use std::cell::RefCell;

use ironhorse_snapshot::machine::{begin_store_session_with_tokens, from_snapshot_bytes};
use ironhorse_snapshot::store::{export_to_container, slot_page_count, HeapStore};
use ironhorse_snapshot::Signature;
use ironhorse_store_do::DoStore;
use thixotrope_ironhorse_core::{Resume, Step, Worker, WorkerLimits};

use crate::host::{HostSql, HostTokens};

pub type Store = DoStore<HostSql>;

thread_local! {
    static WORKER: RefCell<Option<Worker<Store>>> = const { RefCell::new(None) };
}

/// A handle on store `id`, through the stamp check; its rows are left as
/// they are.
pub fn open_store(id: u32) -> Result<Store, String> {
    DoStore::open(HostSql, id).map_err(|error| format!("open: {error:?}"))
}

/// A handle on store `id` with every row of it deleted: the harness reuses
/// one database across runs and wants each begin, import and suite case to
/// start from a never-used store.
pub fn open_clean(id: u32) -> Result<Store, String> {
    let mut store = open_store(id)?;
    store
        .reset_for_harness()
        .map_err(|error| format!("reset: {error:?}"))?;
    Ok(store)
}

fn tokens() -> Option<Box<dyn ironhorse_snapshot::store::CommitTokenSource>> {
    Some(Box::new(HostTokens))
}

/// Install `worker`, dropping any earlier one uncommitted.
fn install(worker: Worker<Store>) {
    WORKER.with(|slot| *slot.borrow_mut() = Some(worker));
}

fn with_worker<T>(f: impl FnOnce(&mut Worker<Store>) -> Result<T, String>) -> Result<T, String> {
    WORKER.with(|slot| {
        let mut slot = slot.borrow_mut();
        let worker = slot.as_mut().ok_or("no worker")?;
        f(worker)
    })
}

fn take_worker() -> Option<Worker<Store>> {
    WORKER.with(|slot| slot.borrow_mut().take())
}

/// A fresh worker on store `id`, emptied first: `Worker::begin` commits the
/// bare machine.
pub fn begin(id: u32, profile: &str, limits: &str) -> Result<(), String> {
    let limits = WorkerLimits::parse(limits)?;
    let store = open_clean(id)?;
    let worker = Worker::begin(store, Signature::new(profile), limits, tokens())
        .map_err(|error| error.to_string())?;
    install(worker);
    Ok(())
}

/// The worker stored in `id`, migrated and restored eagerly or lazily.
pub fn resume(id: u32, lazy: bool, profile: &str, limits: &str) -> Result<(), String> {
    let limits = WorkerLimits::parse(limits)?;
    let mode = if lazy { Resume::Lazy } else { Resume::Eager };
    let worker = Worker::resume(
        open_store(id)?,
        Signature::new(profile),
        limits,
        mode,
        tokens(),
    )
    .map_err(|error| error.to_string())?;
    install(worker);
    Ok(())
}

/// One boot source under the bootstrap budget; nothing is committed.
pub fn boot(name: &str, source: &str) -> Result<(), String> {
    with_worker(|worker| worker.boot(name, source))
}

/// One request line through the core's protocol.
pub fn request(line: &str) -> Result<Step, String> {
    with_worker(|worker| Ok(worker.respond(line)))
}

/// Commit every crank since the last commit; answers the new epoch.
pub fn checkpoint() -> Result<u64, String> {
    with_worker(|worker| worker.checkpoint().map_err(|error| error.to_string()))
}

/// Commit and close the worker, as `Worker::close`; answers the epoch the
/// close committed. The worker is gone whatever the outcome.
pub fn close() -> Result<u64, String> {
    let mut worker = take_worker().ok_or("no worker")?;
    let epoch = worker.checkpoint().map_err(|error| error.to_string())?;
    worker.into_store().map_err(|error| error.to_string())?;
    Ok(epoch)
}

/// Drop the worker without committing; answers whether there was one.
pub fn drop_worker() -> bool {
    take_worker().is_some_and(|worker| {
        let _ = worker.into_store();
        true
    })
}

/// Residency and progress, as one JSON object.
pub fn stats() -> Result<String, String> {
    with_worker(|worker| {
        let manifest = worker
            .store()
            .manifest()
            .map_err(|error| format!("manifest: {error:?}"))?;
        let session = worker.session();
        let machine = worker.machine();
        Ok(format!(
            "{{\"epoch\":{},\"cranks\":{},\"meter\":{},\"dead\":{},\"resident_pages\":{},\"total_pages\":{},\"fully_resident\":{},\"slot_count\":{},\"chunk_len\":{}}}",
            session.epoch(),
            session.cranks(),
            machine.meter_index(),
            worker.is_dead(),
            machine.slots().resident_page_count(),
            slot_page_count(manifest.slot_count),
            machine.slots().is_fully_resident(),
            manifest.slot_count,
            manifest.chunk_len
        ))
    })
}

/// Seed store `id` from canonical container bytes under `profile`: restore
/// the machine, then write it as the store's first, full commit with the
/// host's tokens. No worker is left open; a wake resumes the seeded store.
pub fn import(id: u32, bytes: &[u8], profile: &str) -> Result<(), String> {
    let signature = Signature::new(profile);
    let interp = from_snapshot_bytes(bytes, &signature)
        .map_err(|error| format!("import: restore: {error:?}"))?;
    let mut store = open_clean(id)?;
    begin_store_session_with_tokens(interp, &signature, &mut store, 0, Box::new(HostTokens))
        .map_err(|(_, error)| format!("import: begin: {error:?}"))?;
    Ok(())
}

/// Store `id`'s canonical container.
pub fn export(id: u32) -> Result<Vec<u8>, String> {
    export_to_container(&open_store(id)?).map_err(|error| format!("export: {error:?}"))
}
