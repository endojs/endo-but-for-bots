use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};

use tokio::task::JoinHandle;

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
    /// its own (epoch, commit token) succession, so no CAS key exists;
    /// resume reopens the database. `None` for XS snapshot workers.
    pub heap_store: Option<std::path::PathBuf>,
    /// Worker info (preserved for re-registration on resume).
    pub info: WorkerInfo,
    /// Metering state at suspend time (restored on resume).
    pub meter: Option<MeterState>,
}

/// Ownership of one ephemeral GC-root reference taken at suspend.
///
/// The resume path takes the suspended record out of the supervisor
/// and wraps its pin in a lease; dropping the lease releases the root.
/// The holder drops it once the restored worker has consumed the
/// snapshot (or the resume failed), never before the worker has
/// opened the blob.
pub struct GcRootLease {
    sup: Arc<Supervisor>,
    sha256: String,
}

impl GcRootLease {
    /// Adopt the pin `mark_suspended` took for `sha256`. An empty
    /// digest (store-backed worker) is a no-op lease.
    pub fn adopt(sup: Arc<Supervisor>, sha256: String) -> Self {
        GcRootLease { sup, sha256 }
    }
}

impl Drop for GcRootLease {
    fn drop(&mut self) {
        if !self.sha256.is_empty() {
            self.sup.release_gc_root(&self.sha256);
        }
    }
}

pub struct Supervisor {
    inboxes: RwLock<HashMap<Handle, Mailbox>>,
    /// Registration generation per live handle. `register` stamps a
    /// fresh one; an exit path that captured its generation unregisters
    /// through `unregister_registration`, which is a no-op once the
    /// handle was suspended or re-registered (resumed) after it. Lock
    /// order: this lock before `inboxes`/`workers`/`parents`/`meters`.
    registrations: RwLock<HashMap<Handle, u64>>,
    next_registration: AtomicU64,
    workers: RwLock<HashMap<Handle, WorkerInfo>>,
    parents: RwLock<HashMap<Handle, Handle>>,
    pending_syncs: Mutex<HashMap<(Handle, i64), Handle>>,
    /// Suspended workers keyed by handle.  The inbox is removed
    /// when the worker suspends; on resume, a new inbox is created.
    suspended: RwLock<HashMap<Handle, SuspendedWorker>>,
    /// Ephemeral CAS GC roots: SHA-256 hex digest → reference count.
    /// A suspended XS worker's snapshot blob is pinned here from
    /// `mark_suspended` until its resumed worker has consumed the
    /// snapshot (`GcRootLease` drop), so a future CAS collector must
    /// treat every key in this map as live.
    gc_roots: Mutex<HashMap<String, usize>>,
    /// Per-worker metering state.
    meters: RwLock<HashMap<Handle, MeterState>>,
    outbox: Mutex<Option<Mailbox>>,
    next_handle: AtomicI64,
    done: Mutex<Option<JoinHandle<()>>>,
}

impl Supervisor {
    /// Create a new supervisor, returning it and the outbox receiver
    /// (which must be passed to `start_routing`).
    pub fn new() -> (Arc<Self>, MailboxReceiver) {
        let (outbox_tx, outbox_rx) = mailbox::mailbox();
        let sup = Arc::new(Supervisor {
            inboxes: RwLock::new(HashMap::new()),
            registrations: RwLock::new(HashMap::new()),
            next_registration: AtomicU64::new(1),
            workers: RwLock::new(HashMap::new()),
            parents: RwLock::new(HashMap::new()),
            pending_syncs: Mutex::new(HashMap::new()),
            suspended: RwLock::new(HashMap::new()),
            gc_roots: Mutex::new(HashMap::new()),
            meters: RwLock::new(HashMap::new()),
            outbox: Mutex::new(Some(outbox_tx)),
            next_handle: AtomicI64::new(1),
            done: Mutex::new(None),
        });
        (sup, outbox_rx)
    }

    pub fn alloc_handle(&self) -> Handle {
        self.next_handle.fetch_add(1, Ordering::SeqCst)
    }

    pub fn register(&self, h: Handle, info: Option<WorkerInfo>) -> MailboxReceiver {
        self.register_tracked(h, info).0
    }

    /// Like `register`, also returning the registration generation for
    /// a later `unregister_registration`.
    pub fn register_tracked(&self, h: Handle, info: Option<WorkerInfo>) -> (MailboxReceiver, u64) {
        let (tx, rx) = mailbox::mailbox();
        let generation = self.next_registration.fetch_add(1, Ordering::SeqCst);
        let mut registrations = self.registrations.write().unwrap_or_else(|e| e.into_inner());
        registrations.insert(h, generation);
        self.inboxes.write().unwrap_or_else(|e| e.into_inner()).insert(h, tx);
        if let Some(info) = info {
            self.workers.write().unwrap_or_else(|e| e.into_inner()).insert(h, info);
        }
        (rx, generation)
    }

    /// The handle's current registration generation, if registered.
    pub fn registration(&self, h: Handle) -> Option<u64> {
        self.registrations.read().unwrap_or_else(|e| e.into_inner()).get(&h).copied()
    }

    pub fn unregister(&self, h: Handle) {
        let mut registrations = self.registrations.write().unwrap_or_else(|e| e.into_inner());
        registrations.remove(&h);
        self.remove_registered_state(h);
    }

    /// Unregister `h` only if `generation` is still its current
    /// registration. A worker thread's exit path uses this so it cannot
    /// clobber a handle that was suspended (parent link kept for the
    /// resume) or resumed (fresh inbox) after the exiting registration.
    /// Returns whether it unregistered.
    pub fn unregister_registration(&self, h: Handle, generation: u64) -> bool {
        let mut registrations = self.registrations.write().unwrap_or_else(|e| e.into_inner());
        if registrations.get(&h) != Some(&generation) {
            return false;
        }
        registrations.remove(&h);
        self.remove_registered_state(h);
        true
    }

    fn remove_registered_state(&self, h: Handle) {
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
        // Pin the snapshot blob for as long as the worker is suspended.
        if !sha256.is_empty() {
            self.pin_gc_root(&sha256);
        }
        // Remove the inbox — the worker thread is exiting. Ending the
        // registration makes that thread's exit-path
        // `unregister_registration` a no-op, so it cannot drop the
        // parent link kept for resume or a resumed registration.
        let mut registrations = self.registrations.write().unwrap_or_else(|e| e.into_inner());
        registrations.remove(&handle);
        self.inboxes.write().unwrap_or_else(|e| e.into_inner()).remove(&handle);
        self.workers.write().unwrap_or_else(|e| e.into_inner()).remove(&handle);
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
        drop(registrations);
    }

    /// Check if a handle is suspended.
    pub fn is_suspended(&self, handle: Handle) -> bool {
        self.suspended.read().unwrap_or_else(|e| e.into_inner()).contains_key(&handle)
    }

    /// Take the suspended worker data, removing it from the
    /// suspended set.  Returns `None` if the handle is not
    /// suspended.
    pub fn take_suspended(&self, handle: Handle) -> Option<SuspendedWorker> {
        self.suspended.write().unwrap_or_else(|e| e.into_inner()).remove(&handle)
    }

    /// Put a suspended-worker record back, exactly as taken — for a
    /// resume path that discovers it cannot serve this record (e.g. a
    /// store-backed Ironhorse worker reaching the XS resume dispatch
    /// before the Ironhorse envelope exists) and must leave the
    /// worker suspended rather than half-resumed.
    pub fn put_suspended(&self, handle: Handle, worker: SuspendedWorker) {
        self.suspended.write().unwrap_or_else(|e| e.into_inner()).insert(handle, worker);
    }

    // ---- Ephemeral CAS GC roots ----

    /// Add one reference to the ephemeral GC root for `sha256`.
    pub fn pin_gc_root(&self, sha256: &str) {
        *self
            .gc_roots
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(sha256.to_string())
            .or_insert(0) += 1;
    }

    /// Drop one reference to the ephemeral GC root for `sha256`,
    /// removing the root when the count reaches zero.
    pub fn release_gc_root(&self, sha256: &str) {
        let mut roots = self.gc_roots.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(count) = roots.get_mut(sha256) {
            *count -= 1;
            if *count == 0 {
                roots.remove(sha256);
            }
        }
    }

    /// Whether `sha256` is currently held as an ephemeral GC root.
    pub fn is_gc_root(&self, sha256: &str) -> bool {
        self.gc_roots
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(sha256)
    }

    /// The current ephemeral GC root set (CAS keys a collector must
    /// keep), sorted.
    pub fn gc_roots(&self) -> Vec<String> {
        let mut roots: Vec<String> = self
            .gc_roots
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .cloned()
            .collect();
        roots.sort();
        roots
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
    fn stale_exit_unregister_spares_suspend_and_resume() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        rt.block_on(async {
            let (sup, _outbox_rx) = Supervisor::new();
            let parent = sup.alloc_handle();
            let handle = sup.alloc_handle();
            let (_old_inbox, old) = sup.register_tracked(handle, None);
            sup.set_parent(handle, parent);
            assert_eq!(sup.registration(handle), Some(old));

            // Suspend ends the registration; the exiting thread's late
            // unregister must not drop the parent link kept for resume.
            sup.mark_suspended(handle, String::new(), std::path::PathBuf::from("/tmp/cas"));
            assert_eq!(sup.registration(handle), None);
            assert!(!sup.unregister_registration(handle, old));
            assert!(sup.can_block(handle, parent));

            // Resume re-registers; the stale exit is still a no-op.
            let _ = sup.take_suspended(handle);
            let (_new_inbox, new) = sup.register_tracked(handle, None);
            assert_ne!(new, old);
            assert!(!sup.unregister_registration(handle, old));
            assert!(sup.inboxes.read().unwrap().contains_key(&handle));

            // The current registration's own exit does unregister.
            assert!(sup.unregister_registration(handle, new));
            assert!(!sup.inboxes.read().unwrap().contains_key(&handle));
        });
    }

    #[test]
    fn gc_root_leases_are_reference_counted() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        rt.block_on(async {
            let (sup, _outbox_rx) = Supervisor::new();
            let first = sup.alloc_handle();
            let second = sup.alloc_handle();
            let store_backed = sup.alloc_handle();
            let _first_inbox = sup.register(first, None);
            let _second_inbox = sup.register(second, None);
            let _store_inbox = sup.register(store_backed, None);
            let cas = std::path::PathBuf::from("/tmp/cas");

            // Two workers suspended to the same snapshot share one root.
            sup.mark_suspended(first, "same".to_string(), cas.clone());
            sup.mark_suspended(second, "same".to_string(), cas.clone());
            // A store-backed worker has no snapshot digest and pins nothing.
            sup.mark_suspended(store_backed, String::new(), cas);
            assert_eq!(sup.gc_roots(), vec!["same".to_string()]);

            let first_lease = GcRootLease::adopt(Arc::clone(&sup), "same".to_string());
            let second_lease = GcRootLease::adopt(Arc::clone(&sup), "same".to_string());
            drop(GcRootLease::adopt(Arc::clone(&sup), String::new()));
            drop(first_lease);
            assert!(sup.is_gc_root("same"), "one pin still outstanding");
            drop(second_lease);
            assert!(!sup.is_gc_root("same"));
            assert!(sup.gc_roots().is_empty());

            // Releasing an unpinned digest is a no-op, not an underflow.
            sup.release_gc_root("same");
            assert!(sup.gc_roots().is_empty());
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
}
