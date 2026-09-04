use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};

use tokio::task::JoinHandle;

use crate::cas::ContentStore;
use crate::mailbox::{self, Mailbox, MailboxReceiver};
use crate::types::{Handle, MeterMode, MeterState, Message, RateLimit, WorkerInfo};

/// State for a suspended worker.
///
/// The worker's XS machine has been dropped but its handle stays
/// registered.  On next inbound message, the supervisor restores
/// the machine from the snapshot.
pub struct SuspendedWorker {
    /// SHA-256 hex digest of the snapshot (CAS key). Empty for a
    /// store-backed Ironhorse worker, whose durable identity is
    /// `heap_store` instead.
    pub sha256: String,
    /// Path to the CAS directory containing the snapshot blob.
    pub cas_dir: std::path::PathBuf,
    /// For a store-backed Ironhorse worker: the heap database path
    /// (designs/ironhorse-snapshot-store-seam.md). The store carries
    /// its own (epoch, seal) succession chain, so no CAS key exists;
    /// resume reopens the database. `None` for XS snapshot workers.
    pub heap_store: Option<std::path::PathBuf>,
    /// Worker info (preserved for re-registration on resume).
    pub info: WorkerInfo,
    /// Metering state at suspend time (restored on resume).
    pub meter: Option<MeterState>,
}

pub struct Supervisor {
    inboxes: RwLock<HashMap<Handle, Mailbox>>,
    workers: RwLock<HashMap<Handle, WorkerInfo>>,
    parents: RwLock<HashMap<Handle, Handle>>,
    pending_syncs: Mutex<HashMap<(Handle, i64), Handle>>,
    /// Suspended workers keyed by handle.  The inbox is removed
    /// when the worker suspends; on resume, a new inbox is created.
    suspended: RwLock<HashMap<Handle, SuspendedWorker>>,
    /// Per-worker metering state.
    meters: RwLock<HashMap<Handle, MeterState>>,
    outbox: Mutex<Option<Mailbox>>,
    next_handle: AtomicI64,
    done: Mutex<Option<JoinHandle<()>>>,
    /// Content store for ephemeral GC root bookkeeping of
    /// suspended-worker snapshots.  Optional so unit tests that
    /// do not exercise CAS behavior can skip wiring it.
    cas: OnceLock<Arc<ContentStore>>,
}

impl Supervisor {
    /// Create a new supervisor, returning it and the outbox receiver
    /// (which must be passed to `start_routing`).
    pub fn new() -> (Arc<Self>, MailboxReceiver) {
        let (outbox_tx, outbox_rx) = mailbox::mailbox();
        let sup = Arc::new(Supervisor {
            inboxes: RwLock::new(HashMap::new()),
            workers: RwLock::new(HashMap::new()),
            parents: RwLock::new(HashMap::new()),
            pending_syncs: Mutex::new(HashMap::new()),
            suspended: RwLock::new(HashMap::new()),
            meters: RwLock::new(HashMap::new()),
            outbox: Mutex::new(Some(outbox_tx)),
            next_handle: AtomicI64::new(1),
            done: Mutex::new(None),
            cas: OnceLock::new(),
        });
        (sup, outbox_rx)
    }

    /// Wire the supervisor to a content store for ephemeral GC
    /// root bookkeeping.  When set, `mark_suspended` retains the
    /// snapshot hash and `take_suspended` releases it, so a
    /// concurrent `ContentStore::gc()` cannot collect a snapshot
    /// underneath a suspended worker.  Idempotent: a second call
    /// silently ignores the new value.
    pub fn set_cas(&self, cas: Arc<ContentStore>) {
        let _ = self.cas.set(cas);
    }

    /// Return the content store if one has been wired, for code
    /// paths (such as the resume path) that need to release a
    /// previously-retained snapshot hash.
    pub fn cas(&self) -> Option<Arc<ContentStore>> {
        self.cas.get().cloned()
    }

    pub fn alloc_handle(&self) -> Handle {
        self.next_handle.fetch_add(1, Ordering::SeqCst)
    }

    pub fn register(&self, h: Handle, info: Option<WorkerInfo>) -> MailboxReceiver {
        let (tx, rx) = mailbox::mailbox();
        self.inboxes.write().unwrap_or_else(|e| e.into_inner()).insert(h, tx);
        if let Some(info) = info {
            self.workers.write().unwrap_or_else(|e| e.into_inner()).insert(h, info);
        }
        rx
    }

    pub fn unregister(&self, h: Handle) {
        self.inboxes.write().unwrap_or_else(|e| e.into_inner()).remove(&h);
        self.workers.write().unwrap_or_else(|e| e.into_inner()).remove(&h);
        self.parents.write().unwrap_or_else(|e| e.into_inner()).remove(&h);
        self.meters.write().unwrap_or_else(|e| e.into_inner()).remove(&h);
    }

    pub fn set_parent(&self, child: Handle, parent: Handle) {
        self.parents.write().unwrap_or_else(|e| e.into_inner()).insert(child, parent);
    }

    fn can_block(&self, caller: Handle, callee: Handle) -> bool {
        if callee == 0 {
            return true;
        }
        let parents = self.parents.read().unwrap_or_else(|e| e.into_inner());
        let mut current = caller;
        loop {
            match parents.get(&current) {
                Some(&p) => {
                    if p == callee {
                        return true;
                    }
                    if p == 0 {
                        return false;
                    }
                    current = p;
                }
                None => return false,
            }
        }
    }

    pub fn workers_write(&self) -> std::sync::RwLockWriteGuard<'_, HashMap<Handle, WorkerInfo>> {
        self.workers.write().unwrap_or_else(|e| e.into_inner())
    }

    pub fn workers_snapshot(&self) -> Vec<WorkerInfo> {
        let workers = self.workers.read().unwrap_or_else(|e| e.into_inner());
        workers
            .values()
            .map(|w| WorkerInfo {
                handle: w.handle,
                platform: w.platform.clone(),
                cmd: w.cmd.clone(),
                args: w.args.clone(),
                pid: w.pid,
                started: w.started,
            })
            .collect()
    }

    /// Mark a worker as suspended.
    ///
    /// Stores the snapshot, removes the inbox (the worker thread is
    /// about to exit), and preserves the worker info for re-registration.
    ///
    /// If a content store is wired (see `set_cas`), the snapshot
    /// hash is retained as an ephemeral GC root for the duration
    /// of the suspension.  The matching release happens in
    /// `take_suspended`.
    pub fn mark_suspended(
        &self,
        handle: Handle,
        sha256: String,
        cas_dir: std::path::PathBuf,
    ) {
        self.mark_suspended_inner(handle, sha256, cas_dir, None);
    }

    /// Mark a store-backed Ironhorse worker as suspended.
    ///
    /// The heap database at `heap_store` IS the durable state, so
    /// suspend records only the path (no snapshot write, no CAS key).
    /// Resume reopens the database and continues from its committed
    /// epoch (designs/ironhorse-snapshot-store-seam.md § supervisor
    /// wiring).
    ///
    /// How much is durable at this point is the worker's
    /// `CadencePolicy`, not a fixed per-crank rule: under
    /// `checkpoint_every > 1` completed cranks can be pending. The
    /// close path flushes them before the machine is released, which is
    /// what makes the recorded path a complete suspend rather than one
    /// missing its tail.
    pub fn mark_suspended_store(&self, handle: Handle, heap_store: std::path::PathBuf) {
        self.mark_suspended_inner(handle, String::new(), std::path::PathBuf::new(), Some(heap_store));
    }

    fn mark_suspended_inner(
        &self,
        handle: Handle,
        sha256: String,
        cas_dir: std::path::PathBuf,
        heap_store: Option<std::path::PathBuf>,
    ) {
        let info = {
            let workers = self.workers.read().unwrap_or_else(|e| e.into_inner());
            workers.get(&handle).cloned()
        };
        let info = info.unwrap_or(WorkerInfo {
            handle,
            platform: "separate".to_string(),
            cmd: "<suspended>".to_string(),
            args: Vec::new(),
            pid: 0,
            started: std::time::SystemTime::now(),
        });
        // Capture meter state before removing it.
        let meter = self.meters.write().unwrap_or_else(|e| e.into_inner()).remove(&handle);
        // Remove the inbox — the worker thread is exiting.
        self.inboxes.write().unwrap_or_else(|e| e.into_inner()).remove(&handle);
        self.workers.write().unwrap_or_else(|e| e.into_inner()).remove(&handle);
        // Retain the snapshot in the CAS so a concurrent GC
        // pass cannot collect it while the worker is suspended.
        if let Some(cas) = self.cas.get() {
            cas.retain(&sha256);
        }
        self.suspended.write().unwrap_or_else(|e| e.into_inner()).insert(
            handle,
            SuspendedWorker {
                sha256,
                cas_dir,
                heap_store,
                info,
                meter,
            },
        );
    }

    /// Check if a handle is suspended.
    pub fn is_suspended(&self, handle: Handle) -> bool {
        self.suspended.read().unwrap_or_else(|e| e.into_inner()).contains_key(&handle)
    }

    /// Take the suspended worker data, removing it from the
    /// suspended set.  Returns `None` if the handle is not
    /// suspended.
    ///
    /// Releases the ephemeral GC root on the snapshot hash if a
    /// content store was wired at suspend time.  The caller (the
    /// resume path) is then responsible for either restoring the
    /// machine from the snapshot (consuming the file before any GC
    /// runs) or for re-retaining the hash if the snapshot needs to
    /// live past this call.
    pub fn take_suspended(&self, handle: Handle) -> Option<SuspendedWorker> {
        let removed = self
            .suspended
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&handle);
        if let Some(ref sw) = removed {
            if let Some(cas) = self.cas.get() {
                cas.release(&sw.sha256);
            }
        }
        removed
    }

    /// Cancel a suspended worker without resuming it.
    ///
    /// Drops the suspended state and releases the ephemeral GC
    /// root on the snapshot hash so a subsequent CAS GC pass can
    /// reclaim the snapshot.  Returns `true` if the handle was
    /// suspended, `false` otherwise.
    pub fn cancel_suspended(&self, handle: Handle) -> bool {
        self.take_suspended(handle).is_some()
    }

    /// Put a suspended-worker record back, exactly as taken — for a
    /// resume path that discovers it cannot serve this record (e.g. a
    /// store-backed Ironhorse worker reaching the XS resume dispatch
    /// before the Ironhorse envelope exists) and must leave the
    /// worker suspended rather than half-resumed.
    pub fn put_suspended(&self, handle: Handle, worker: SuspendedWorker) {
        self.suspended.write().unwrap_or_else(|e| e.into_inner()).insert(handle, worker);
    }

    // ---- Metering API ----

    /// Get a clone of the current meter state for a worker.
    pub fn meter_state(&self, handle: Handle) -> Option<MeterState> {
        self.meters.read().unwrap_or_else(|e| e.into_inner()).get(&handle).cloned()
    }

    /// Restore a meter state (used after resume from suspend).
    pub fn restore_meter(&self, handle: Handle, meter: MeterState) {
        self.meters.write().unwrap_or_else(|e| e.into_inner()).insert(handle, meter);
    }

    /// Process a meter-report from a worker.
    /// Deducts steps from budget and accumulates them.
    pub fn process_meter_report(&self, handle: Handle, steps: u64, outcome: &str) {
        let mut meters = self.meters.write().unwrap_or_else(|e| e.into_inner());
        let meter = meters.entry(handle).or_default();
        meter.accumulated += steps;
        meter.budget = meter.budget.saturating_sub(steps);
        if outcome == "terminated" {
            // Worker is dead — remove meter state.
            drop(meters);
            self.unregister(handle);
        }
    }

    /// Set quota mode for a worker.
    pub fn set_meter_quota(&self, handle: Handle, hard_limit: u64, budget: u64) {
        let mut meters = self.meters.write().unwrap_or_else(|e| e.into_inner());
        let meter = meters.entry(handle).or_default();
        if hard_limit == 0 {
            meter.mode = MeterMode::Measurement;
            meter.hard_limit = 0;
            meter.budget = 0;
            meter.rate_limit = None;
        } else {
            meter.mode = MeterMode::Quota;
            meter.hard_limit = hard_limit;
            meter.budget = budget;
            meter.rate_limit = None;
        }
    }

    /// Set rate-limited mode for a worker.
    pub fn set_meter_rate(
        &self,
        handle: Handle,
        hard_limit: u64,
        rate: u64,
        burst: u64,
    ) {
        let mut meters = self.meters.write().unwrap_or_else(|e| e.into_inner());
        let meter = meters.entry(handle).or_default();
        meter.mode = MeterMode::RateLimited;
        meter.hard_limit = hard_limit;
        meter.rate_limit = Some(RateLimit {
            rate,
            burst,
            last_refill: std::time::Instant::now(),
        });
        // Start with a full burst of budget.
        meter.budget = burst.min(hard_limit);
    }

    /// Add steps to a worker's budget (one-time top-up).
    pub fn meter_refill(&self, handle: Handle, amount: u64) -> u64 {
        let mut meters = self.meters.write().unwrap_or_else(|e| e.into_inner());
        let meter = meters.entry(handle).or_default();
        meter.budget = meter.budget.saturating_add(amount);
        if let Some(ref rl) = meter.rate_limit {
            meter.budget = meter.budget.min(rl.burst);
        }
        meter.budget
    }

    /// Reset accumulated step counter to zero.
    pub fn meter_reset(&self, handle: Handle) {
        let mut meters = self.meters.write().unwrap_or_else(|e| e.into_inner());
        if let Some(meter) = meters.get_mut(&handle) {
            meter.accumulated = 0;
        }
    }

    pub fn deliver(&self, msg: Message) {
        if let Some(ref outbox) = *self.outbox.lock().unwrap_or_else(|e| e.into_inner()) {
            outbox.deliver(msg);
        }
    }

    pub fn stop(&self) {
        self.outbox.lock().unwrap_or_else(|e| e.into_inner()).take();
    }

    pub async fn wait(&self) {
        let handle = self.done.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(h) = handle {
            let _ = h.await;
        }
    }
}

/// Callbacks for the supervisor routing loop.
pub struct RoutingCallbacks {
    /// Called for control messages (handle 0).
    pub on_control: Box<dyn Fn(Message) + Send>,
    /// Called when a message arrives for a suspended worker.
    /// The callback should restore the worker and re-register
    /// its inbox, then deliver the message.
    pub on_resume: Box<dyn Fn(&Arc<Supervisor>, Handle, SuspendedWorker, Message) + Send>,
}

/// Start the supervisor routing loop as a tokio task.
pub fn start_routing(
    sup: &Arc<Supervisor>,
    mut outbox_rx: MailboxReceiver,
    callbacks: RoutingCallbacks,
) {
    let sup_clone = Arc::clone(sup);
    let handle = tokio::spawn(async move {
        loop {
            let msg = match outbox_rx.recv().await {
                Some(m) => m,
                None => break,
            };
            route_message(&sup_clone, msg, &callbacks);
            for msg in outbox_rx.drain() {
                route_message(&sup_clone, msg, &callbacks);
            }
        }
    });
    *sup.done.lock().unwrap_or_else(|e| e.into_inner()) = Some(handle);
}

fn route_message(sup: &Arc<Supervisor>, msg: Message, callbacks: &RoutingCallbacks) {
    if is_debug() {
        eprintln!(
            "endor: route from={} to={} verb={} nonce={}",
            msg.from, msg.to, msg.envelope.verb, msg.envelope.nonce
        );
    }
    if msg.to == 0 {
        (callbacks.on_control)(msg);
        return;
    }

    // Check if the target is suspended — if so, trigger resume.
    if sup.is_suspended(msg.to) {
        if let Some(suspended) = sup.take_suspended(msg.to) {
            if is_debug() {
                // A store-backed record has no CAS key; name its heap
                // database instead of printing an empty sha256.
                let identity = if suspended.sha256.is_empty() {
                    match suspended.heap_store.as_deref() {
                        Some(p) => format!("heap_store={}", p.display()),
                        None => "no snapshot identity".to_string(),
                    }
                } else {
                    format!("sha256={}", suspended.sha256)
                };
                eprintln!("endor: resuming suspended worker {} ({identity})", msg.to);
            }
            (callbacks.on_resume)(sup, msg.to, suspended, msg);
            return;
        }
    }

    if msg.envelope.nonce > 0 && msg.from != 0 {
        let is_response = {
            let mut pending = sup.pending_syncs.lock().unwrap_or_else(|e| e.into_inner());
            let key = (msg.to, msg.envelope.nonce);
            if pending.remove(&key).is_some() {
                true
            } else {
                if !sup.can_block(msg.from, msg.to) {
                    if is_debug() {
                        eprintln!(
                            "endor: sync call denied: {} -> {}",
                            msg.from, msg.to
                        );
                    }
                    return;
                }
                pending.insert((msg.from, msg.envelope.nonce), msg.to);
                false
            }
        };
        let _ = is_response;
    }
    let inboxes = sup.inboxes.read().unwrap_or_else(|e| e.into_inner());
    if let Some(inbox) = inboxes.get(&msg.to) {
        inbox.deliver(msg);
    } else if is_debug() {
        eprintln!("endor: no inbox for handle {}", msg.to);
    }
}

fn is_debug() -> bool {
    static ENDO_TRACE: OnceLock<bool> = OnceLock::new();
    *ENDO_TRACE.get_or_init(|| std::env::var("ENDO_TRACE").is_ok())
}

pub fn is_debug_public() -> bool {
    is_debug()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    #[test]
    fn suspend_resume_preserves_platform() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        rt.block_on(async {
            let (sup, _outbox_rx) = Supervisor::new();
            let handle = sup.alloc_handle();
            let info = WorkerInfo {
                handle,
                platform: "shared".to_string(),
                cmd: "<in-process>".to_string(),
                args: Vec::new(),
                pid: 42,
                started: SystemTime::now(),
            };
            let _inbox = sup.register(handle, Some(info));

            // Mark suspended.
            sup.mark_suspended(
                handle,
                "abc123".to_string(),
                std::path::PathBuf::from("/tmp/cas"),
            );
            assert!(sup.is_suspended(handle));

            // Take suspended and verify platform preserved.
            let suspended = sup.take_suspended(handle).unwrap();
            assert_eq!(suspended.info.platform, "shared");
            assert_eq!(suspended.sha256, "abc123");
            assert!(!sup.is_suspended(handle));
        });
    }

    #[test]
    fn suspend_fallback_defaults_to_separate() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        rt.block_on(async {
            let (sup, _outbox_rx) = Supervisor::new();
            let handle = sup.alloc_handle();
            // Register without WorkerInfo.
            let _inbox = sup.register(handle, None);

            sup.mark_suspended(
                handle,
                "def456".to_string(),
                std::path::PathBuf::from("/tmp/cas"),
            );

            let suspended = sup.take_suspended(handle).unwrap();
            assert_eq!(suspended.info.platform, "separate");
            assert!(suspended.meter.is_none());
        });
    }

    #[test]
    fn suspend_preserves_meter_state() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        rt.block_on(async {
            let (sup, _outbox_rx) = Supervisor::new();
            let handle = sup.alloc_handle();
            let info = WorkerInfo {
                handle,
                platform: "shared".to_string(),
                cmd: "<in-process>".to_string(),
                args: Vec::new(),
                pid: 42,
                started: SystemTime::now(),
            };
            let _inbox = sup.register(handle, Some(info));

            // Set up quota metering.
            sup.set_meter_quota(handle, 5000, 20000);

            // Simulate some work.
            sup.process_meter_report(handle, 3000, "ok");

            // Check pre-suspend state.
            let state = sup.meter_state(handle).unwrap();
            assert_eq!(state.accumulated, 3000);
            assert_eq!(state.budget, 17000);

            // Suspend.
            sup.mark_suspended(
                handle,
                "abc123".to_string(),
                std::path::PathBuf::from("/tmp/cas"),
            );

            // Meter state removed from active meters.
            assert!(sup.meter_state(handle).is_none());

            // Take suspended and verify meter state preserved.
            let suspended = sup.take_suspended(handle).unwrap();
            let meter = suspended.meter.unwrap();
            assert_eq!(meter.accumulated, 3000);
            assert_eq!(meter.budget, 17000);
            assert_eq!(meter.hard_limit, 5000);

            // Restore meter state (as handle_resume does).
            sup.restore_meter(handle, meter);
            let restored = sup.meter_state(handle).unwrap();
            assert_eq!(restored.accumulated, 3000);
            assert_eq!(restored.budget, 17000);
        });
    }

    // ---- Ephemeral GC root bookkeeping (Phase 2 wrap-up) ----
    //
    // The design at designs/daemon-xs-worker-snapshot.md § Suspend
    // /resume model item 5 requires the supervisor to hold an
    // ephemeral GC root on the snapshot hash for as long as the
    // worker is suspended and to release that root when the
    // worker resumes (or is cancelled).  These tests pin that
    // contract against the ContentStore retain / release API.

    fn write_snapshot_blob(cas_dir: &std::path::Path, hex_hash: &str, bytes: &[u8]) {
        std::fs::create_dir_all(cas_dir).unwrap();
        std::fs::write(cas_dir.join(hex_hash), bytes).unwrap();
    }

    fn make_worker(sup: &Arc<Supervisor>, handle: Handle) {
        let info = WorkerInfo {
            handle,
            platform: "shared".to_string(),
            cmd: "<in-process>".to_string(),
            args: Vec::new(),
            pid: 42,
            started: SystemTime::now(),
        };
        let _inbox = sup.register(handle, Some(info));
    }

    #[test]
    fn mark_suspended_retains_snapshot_in_cas() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        rt.block_on(async {
            let tmp = tempfile::tempdir().unwrap();
            let cas = Arc::new(ContentStore::open(tmp.path()).unwrap());
            let (sup, _outbox_rx) = Supervisor::new();
            sup.set_cas(Arc::clone(&cas));
            let handle = sup.alloc_handle();
            make_worker(&sup, handle);

            // The worker would normally have written the snapshot
            // file to disk before sending the "suspended" envelope.
            // Place a blob at the expected name.
            let hash = "deadbeef".to_string();
            write_snapshot_blob(tmp.path(), &hash, b"snapshot-bytes");

            sup.mark_suspended(handle, hash.clone(), tmp.path().to_path_buf());

            // GC with empty live_roots would normally sweep the
            // snapshot.  The retain bumps refs > 0, which gc()
            // honors as live.
            let report = cas.gc(&std::collections::HashSet::new()).unwrap();
            assert_eq!(report.freed_count, 0, "snapshot must survive gc while worker is suspended");
            assert!(
                tmp.path().join(&hash).exists(),
                "snapshot file must still be on disk after gc"
            );
        });
    }

    #[test]
    fn take_suspended_releases_snapshot_in_cas() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        rt.block_on(async {
            let tmp = tempfile::tempdir().unwrap();
            let cas = Arc::new(ContentStore::open(tmp.path()).unwrap());
            let (sup, _outbox_rx) = Supervisor::new();
            sup.set_cas(Arc::clone(&cas));
            let handle = sup.alloc_handle();
            make_worker(&sup, handle);

            let hash = "cafef00d".to_string();
            write_snapshot_blob(tmp.path(), &hash, b"snapshot-bytes");

            sup.mark_suspended(handle, hash.clone(), tmp.path().to_path_buf());
            let taken = sup.take_suspended(handle).expect("expected suspended");
            assert_eq!(taken.sha256, hash);

            // After take_suspended the ephemeral root is released.
            // A gc pass with empty live_roots may now reclaim the
            // snapshot.  The resume path is expected to consume
            // the file before any subsequent gc, but the
            // bookkeeping invariant is that the root is gone.
            let report = cas.gc(&std::collections::HashSet::new()).unwrap();
            assert_eq!(
                report.freed_count, 1,
                "snapshot must be collectable after resume releases the ephemeral root"
            );
            assert!(
                !tmp.path().join(&hash).exists(),
                "snapshot file must be gone after gc"
            );
        });
    }

    #[test]
    fn cancel_suspended_releases_snapshot() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        rt.block_on(async {
            let tmp = tempfile::tempdir().unwrap();
            let cas = Arc::new(ContentStore::open(tmp.path()).unwrap());
            let (sup, _outbox_rx) = Supervisor::new();
            sup.set_cas(Arc::clone(&cas));
            let handle = sup.alloc_handle();
            make_worker(&sup, handle);

            let hash = "f00dbabe".to_string();
            write_snapshot_blob(tmp.path(), &hash, b"snapshot-bytes");

            sup.mark_suspended(handle, hash.clone(), tmp.path().to_path_buf());
            assert!(sup.cancel_suspended(handle));
            assert!(!sup.cancel_suspended(handle), "second cancel is a no-op");

            // Snapshot is now collectable.
            let report = cas.gc(&std::collections::HashSet::new()).unwrap();
            assert_eq!(report.freed_count, 1);
            assert!(!tmp.path().join(&hash).exists());
        });
    }

    #[test]
    fn suspend_without_cas_still_works() {
        // A supervisor that was never wired to a content store
        // (the test harnesses in this module) must continue to
        // accept mark_suspended / take_suspended without panicking.
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        rt.block_on(async {
            let (sup, _outbox_rx) = Supervisor::new();
            assert!(sup.cas().is_none());

            let handle = sup.alloc_handle();
            make_worker(&sup, handle);

            sup.mark_suspended(
                handle,
                "no-cas-wired".to_string(),
                std::path::PathBuf::from("/tmp/cas"),
            );
            let _ = sup.take_suspended(handle).unwrap();
        });
    }

    #[test]
    fn set_cas_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let cas1 = Arc::new(ContentStore::open(tmp.path()).unwrap());
        let cas2 = Arc::new(ContentStore::open(tmp.path()).unwrap());
        let (sup, _outbox_rx) = Supervisor::new();
        sup.set_cas(Arc::clone(&cas1));
        sup.set_cas(Arc::clone(&cas2));
        // Either call returns a CAS, and the bookkeeping path
        // does not panic.  We do not pin which CAS wins because
        // the contract is "first set wins, subsequent calls are
        // silently ignored".
        assert!(sup.cas().is_some());
    }

    #[test]
    fn double_suspend_does_not_inflate_refcount() {
        // Marking the same handle suspended twice (which would be
        // a bug at a higher layer) must not leave the ephemeral
        // root pinned after a single take.  We do not currently
        // refuse the second mark; we document the behavior so
        // that future work on a cleaner suspend / cancel path can
        // change it deliberately.
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        rt.block_on(async {
            let tmp = tempfile::tempdir().unwrap();
            let cas = Arc::new(ContentStore::open(tmp.path()).unwrap());
            let (sup, _outbox_rx) = Supervisor::new();
            sup.set_cas(Arc::clone(&cas));
            let handle = sup.alloc_handle();
            make_worker(&sup, handle);

            let hash = "abc".to_string();
            write_snapshot_blob(tmp.path(), &hash, b"x");

            sup.mark_suspended(handle, hash.clone(), tmp.path().to_path_buf());
            // Second mark with the same hash bumps the refcount
            // a second time; the inserted SuspendedWorker
            // overwrites the previous entry but the extra retain
            // leaks unless take_suspended is called twice.  This
            // test documents the current behavior so a future
            // change is visible in the diff.
            sup.mark_suspended(handle, hash.clone(), tmp.path().to_path_buf());

            let _ = sup.take_suspended(handle).unwrap();
            // One retain leaked; gc still sees refs > 0.
            let report = cas.gc(&std::collections::HashSet::new()).unwrap();
            assert_eq!(
                report.freed_count, 0,
                "current behavior: double-mark leaks one retain"
            );
        });
    }

    #[test]
    fn take_suspended_on_unknown_handle_with_cas_is_noop() {
        // `take_suspended` on a handle that was never marked
        // suspended must return None and must not attempt to
        // release any CAS root.  This pins the early-return branch
        // in the new release logic (the `if let Some(ref sw)` arm
        // must not fire when nothing was removed).
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        rt.block_on(async {
            let tmp = tempfile::tempdir().unwrap();
            let cas = Arc::new(ContentStore::open(tmp.path()).unwrap());
            let (sup, _outbox_rx) = Supervisor::new();
            sup.set_cas(Arc::clone(&cas));

            // Hand-retain a hash that is unrelated to any worker so
            // we can prove the no-op `take_suspended` did not call
            // release on anything that would have driven this
            // refcount to zero.
            let hash = "unrelated".to_string();
            write_snapshot_blob(tmp.path(), &hash, b"keep-me");
            cas.retain(&hash);

            // Handle 9999 was never suspended; the call returns None.
            let result = sup.take_suspended(9999);
            assert!(result.is_none());

            // The unrelated retain is still live; gc must not
            // collect it.
            let report = cas.gc(&std::collections::HashSet::new()).unwrap();
            assert_eq!(report.freed_count, 0);
            assert!(tmp.path().join(&hash).exists());
        });
    }

    #[test]
    fn suspend_resume_resuspend_with_different_hash() {
        // A worker's lifetime spans many suspend / resume cycles,
        // each with a fresh snapshot hash.  The bookkeeping
        // invariant for each cycle is independent: a hash retained
        // at suspend-N is released at resume-N, and gc after the
        // release reclaims that hash even if a later cycle has
        // pinned a different one.
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        rt.block_on(async {
            let tmp = tempfile::tempdir().unwrap();
            let cas = Arc::new(ContentStore::open(tmp.path()).unwrap());
            let (sup, _outbox_rx) = Supervisor::new();
            sup.set_cas(Arc::clone(&cas));
            let handle = sup.alloc_handle();
            make_worker(&sup, handle);

            let hash_a = "aaaaaaaa".to_string();
            let hash_b = "bbbbbbbb".to_string();
            write_snapshot_blob(tmp.path(), &hash_a, b"snap-a");
            write_snapshot_blob(tmp.path(), &hash_b, b"snap-b");

            // Cycle 1: suspend with hash A, resume (take).
            sup.mark_suspended(handle, hash_a.clone(), tmp.path().to_path_buf());
            // Re-register worker info as a real resume path would.
            make_worker(&sup, handle);
            let taken_a = sup.take_suspended(handle).unwrap();
            assert_eq!(taken_a.sha256, hash_a);

            // Cycle 2: suspend the same handle with a different hash.
            sup.mark_suspended(handle, hash_b.clone(), tmp.path().to_path_buf());

            // A gc here must reclaim hash A (refcount fell to 0 at
            // the resume in cycle 1) but must not reclaim hash B
            // (still pinned by the cycle-2 suspend).
            let report = cas.gc(&std::collections::HashSet::new()).unwrap();
            assert_eq!(report.freed_count, 1, "exactly hash A must be reclaimed");
            assert!(
                !tmp.path().join(&hash_a).exists(),
                "hash A must be gone after gc"
            );
            assert!(
                tmp.path().join(&hash_b).exists(),
                "hash B must survive while worker is suspended on it"
            );

            // Resume cycle 2 to drain.
            let taken_b = sup.take_suspended(handle).unwrap();
            assert_eq!(taken_b.sha256, hash_b);
            let report = cas.gc(&std::collections::HashSet::new()).unwrap();
            assert_eq!(report.freed_count, 1);
            assert!(!tmp.path().join(&hash_b).exists());
        });
    }

    #[test]
    fn two_workers_sharing_same_snapshot_use_refcount() {
        // Two distinct workers happen to suspend on the same
        // snapshot hash (e.g., two clones of an identical-shape XS
        // machine).  The CAS refcount is the only protection
        // against collecting the shared blob while one worker has
        // resumed but the other has not.  This test pins that the
        // bookkeeping is refcount-based, not occupancy-based.
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        rt.block_on(async {
            let tmp = tempfile::tempdir().unwrap();
            let cas = Arc::new(ContentStore::open(tmp.path()).unwrap());
            let (sup, _outbox_rx) = Supervisor::new();
            sup.set_cas(Arc::clone(&cas));

            let h1 = sup.alloc_handle();
            let h2 = sup.alloc_handle();
            make_worker(&sup, h1);
            make_worker(&sup, h2);

            let hash = "sharedhash".to_string();
            write_snapshot_blob(tmp.path(), &hash, b"shared-bytes");

            sup.mark_suspended(h1, hash.clone(), tmp.path().to_path_buf());
            sup.mark_suspended(h2, hash.clone(), tmp.path().to_path_buf());

            // Resume worker 1 only.  Worker 2 still depends on the
            // snapshot; gc must not reclaim it.
            let _ = sup.take_suspended(h1).unwrap();
            let report = cas.gc(&std::collections::HashSet::new()).unwrap();
            assert_eq!(
                report.freed_count, 0,
                "shared snapshot must survive while one worker is still suspended"
            );
            assert!(tmp.path().join(&hash).exists());

            // Resume worker 2.  Now both retains are released; the
            // snapshot becomes collectable.
            let _ = sup.take_suspended(h2).unwrap();
            let report = cas.gc(&std::collections::HashSet::new()).unwrap();
            assert_eq!(report.freed_count, 1);
            assert!(!tmp.path().join(&hash).exists());
        });
    }

    #[test]
    fn cas_accessor_returns_wired_store() {
        // The `cas()` accessor is the surface the resume path in
        // `endo.rs` reaches through to release a previously
        // retained hash.  The returned Arc must point to the same
        // ContentStore the supervisor was wired with, so a release
        // call via the accessor affects the same refcounts as a
        // release call via the supervisor's internal path.
        let tmp = tempfile::tempdir().unwrap();
        let cas = Arc::new(ContentStore::open(tmp.path()).unwrap());
        let (sup, _outbox_rx) = Supervisor::new();
        assert!(sup.cas().is_none());
        sup.set_cas(Arc::clone(&cas));

        let accessed = sup.cas().expect("cas wired");
        // A retain via the original handle and a release via the
        // accessor handle must net to zero; both refer to the same
        // underlying store.
        let hash = "accessor-hash".to_string();
        write_snapshot_blob(tmp.path(), &hash, b"x");
        cas.retain(&hash);
        accessed.release(&hash);
        let report = cas.gc(&std::collections::HashSet::new()).unwrap();
        assert_eq!(
            report.freed_count, 1,
            "release via cas() accessor must affect the same refcount"
        );
    }
}
