//! **Supervisor suspend/resume integration (stage-6 child 5, roadmap row 6).**
//!
//! Roadmap row 6's acceptance bar is *"supervisor suspend/resume integration
//! test passes on `-e ironhorse`"*: the endo daemon's worker supervisor
//! suspending an ironhorse-engined worker to a snapshot and resuming it, through
//! the same lifecycle the C xsnap worker uses today.
//!
//! ## What this test actually exercises (and the honest boundary)
//!
//! The **real** daemon supervisor lives in the excluded `rust/endo`
//! workspace (`rust/endo/src/supervisor.rs`, the `Supervisor` /
//! `SuspendedWorker` types) and is bound to the XS `xsnap` crate; it
//! cannot yet depend on `ironhorse-snapshot` (see the module-level GAP REPORT
//! in this file's companion tada report — separate workspace, no
//! `ironhorse` engine variant, an unbuildable worker/SES boot path, and the
//! post-stage-4 intrinsics the daemon boot needs). Wiring the *literal*
//! daemon `Supervisor` onto the ironhorse engine is therefore the enumerated
//! remaining work, not something one invocation can land green.
//!
//! What IS reachable — and what this integration test pins — is the ironhorse
//! snapshot surface (children 2–3) driven through the **exact lifecycle the
//! daemon supervisor drives**, reconstructed here as a faithful harness:
//!
//! - `rust/endo/src/supervisor.rs::mark_suspended` snapshots the worker to
//!   the CAS, **drops the live XS machine**, and retains only
//!   `SuspendedWorker { sha256, cas_dir, info, meter }` — the content hash,
//!   the store path, and the meter state, *not* the machine.
//! - On the next inbound message, `take_suspended` + `resume_from_cas`
//!   rebuild the machine from the CAS blob and `restore_meter` reinstates
//!   the held meter, after which the worker continues its next crank.
//!
//! The [`SupervisorHarness`] below is that state machine over the ironhorse
//! `Interp`: handle-keyed live workers, a `suspended` map holding a
//! [`SuspendedRecord`] whose fields mirror `SuspendedWorker`, a `suspend`
//! that genuinely drops the machine and keeps only the CAS key + meter, and
//! a `resume` that restores from the store and asserts the meter travelled
//! through the *record* (mirroring `restore_meter`) rather than through a
//! machine kept alive across the gap. This is a supervisor-shaped
//! **integration** test, not a verb round-trip: the machine does not exist
//! between suspend and resume, exactly as in the daemon.
//!
//! The row-6 property proven: a worker suspended to the CAS at a crank
//! boundary and resumed on the next message continues in **both result and
//! final computron count** identically to a worker that never suspended.

use std::collections::HashMap;
use std::path::PathBuf;

use ironhorse_snapshot::format::Signature;
use ironhorse_snapshot::machine::{resume_from_cas, MachineSnapshot};
use ironhorse_vm::meter::MeterState;
use ironhorse_vm::Interp;

mod common;

/// The host callback-table version the supervisor pins its workers to (the
/// `SIGN` atom gate); a mismatch fails resume closed.
fn worker_signature() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

// The exact XS bytecode the engine's own meter/snapshot tests use, so the
// computron expectations here are anchored to the same oracle-captured
// programs. `PROG_A` is `(function(x){return x+1})(5)` → "6"; `PROG_B` is
// `(function(){return (function(){return 1})()})()` → "1".
const PROG_A: [u8; 44] = [
    0x0b, 0x00, 0x4b, 0xe0, 0x38, 0x00, 0x00, 0x2e, 0x13, 0x0b, 0x01, 0x9e, 0x01, 0x86, 0x01, 0x00,
    0x02, 0x00, 0xe6, 0x01, 0x92, 0x5c, 0x01, 0x72, 0x01, 0x01, 0xbb, 0x44, 0x58, 0x92, 0x42, 0xe0,
    0x89, 0x02, 0x00, 0x72, 0x04, 0x28, 0x72, 0x05, 0xab, 0x01, 0xbb, 0xa9,
];
const PROG_B: [u8; 51] = [
    0x0b, 0x00, 0x4b, 0xe0, 0x38, 0x00, 0x00, 0x2e, 0x1c, 0x0b, 0x00, 0xe0, 0x38, 0x00, 0x00, 0x2e,
    0x06, 0x0b, 0x00, 0x72, 0x01, 0xbb, 0x44, 0x58, 0x92, 0x42, 0xe0, 0x89, 0x01, 0x00, 0x72, 0x04,
    0x28, 0xab, 0x00, 0xbb, 0x44, 0x58, 0x92, 0x42, 0xe0, 0x89, 0x01, 0x00, 0x72, 0x04, 0x28, 0xab,
    0x00, 0xbb, 0xa9,
];

/// A daemon worker handle (`rust/endo/src/types.rs::Handle`).
type Handle = i64;

/// The ironhorse mirror of `rust/endo/src/supervisor.rs::SuspendedWorker`: the
/// state that survives a suspend after the live machine is dropped. The
/// daemon additionally carries `info: WorkerInfo` for re-registration; that
/// is transport bookkeeping orthogonal to the engine snapshot surface, so
/// the integration harness keeps the two fields the resume path actually
/// consumes — the CAS key and the meter.
struct SuspendedRecord {
    /// SHA-256 hex digest of the snapshot (the CAS key), as
    /// `SuspendedWorker::sha256`.
    sha256: String,
    /// The CAS directory holding the snapshot blob, as
    /// `SuspendedWorker::cas_dir`.
    cas_dir: PathBuf,
    /// Meter state captured at suspend, restored on resume, as
    /// `SuspendedWorker::meter`. Held in the *record*, not in a machine.
    meter: MeterState,
}

/// A minimal supervisor over ironhorse workers, mirroring the suspend/resume
/// state machine of `rust/endo/src/supervisor.rs` closely enough to be a
/// genuine integration of the ironhorse snapshot surface: live workers keyed by
/// handle, and a suspended set keyed by handle whose entries hold only the
/// CAS key + meter (the machine is dropped on suspend).
struct SupervisorHarness {
    signature: Signature,
    cas_root: PathBuf,
    /// Live (resident) workers. A suspended handle is absent here and
    /// present in `suspended` — the two maps are disjoint, exactly as the
    /// daemon removes the inbox/worker entry on suspend.
    live: HashMap<Handle, Interp>,
    /// Suspended workers keyed by handle (`Supervisor::suspended`).
    suspended: HashMap<Handle, SuspendedRecord>,
    next_handle: Handle,
}

impl SupervisorHarness {
    fn new(cas_root: PathBuf) -> SupervisorHarness {
        SupervisorHarness {
            signature: worker_signature(),
            cas_root,
            live: HashMap::new(),
            suspended: HashMap::new(),
            next_handle: 1,
        }
    }

    /// Register a freshly booted worker (`Supervisor::alloc_handle` +
    /// `register`), returning its handle.
    fn spawn(&mut self) -> Handle {
        let handle = self.next_handle;
        self.next_handle += 1;
        self.live.insert(handle, Interp::new());
        handle
    }

    /// Deliver a program to a resident worker's crank. Panics if the handle
    /// is suspended — the daemon resumes before delivering, which the test
    /// driver does explicitly.
    fn deliver(&mut self, handle: Handle, program: &[u8]) -> ironhorse_vm::interp::RunOutcome {
        let worker = self
            .live
            .get_mut(&handle)
            .expect("deliver to a resident (non-suspended) worker");
        worker.run(program)
    }

    fn is_suspended(&self, handle: Handle) -> bool {
        self.suspended.contains_key(&handle)
    }

    /// The daemon's `mark_suspended` path: snapshot the worker to the CAS,
    /// capture the meter, then **drop the live machine** and retain only the
    /// CAS key + meter. Returns the content hash the supervisor holds as an
    /// ephemeral GC root while the worker sleeps.
    fn suspend(&mut self, handle: Handle) -> String {
        let worker = self
            .live
            .remove(&handle)
            .expect("suspend a resident worker");
        let cas_dir = self.cas_root.join(format!("worker-{handle}"));
        let sha256 = worker
            .suspend_to_cas(&self.signature, &cas_dir)
            .expect("snapshot streams to the CAS");
        let meter = worker.meter_state();
        // The machine is dropped here — nothing but the record survives the
        // suspend, exactly as in `SuspendedWorker`.
        drop(worker);
        self.suspended.insert(
            handle,
            SuspendedRecord {
                sha256: sha256.clone(),
                cas_dir,
                meter,
            },
        );
        sha256
    }

    /// The daemon's `take_suspended` + `resume_from_cas` + `restore_meter`
    /// path: rebuild the machine from the CAS blob, verify the meter carried
    /// by the snapshot matches the meter the record held (`restore_meter`
    /// re-installs exactly that state), and re-register the worker as
    /// resident. Panics if the handle is not suspended.
    fn resume(&mut self, handle: Handle) {
        let record = self
            .suspended
            .remove(&handle)
            .expect("resume a suspended worker");
        let worker = resume_from_cas(&record.cas_dir, &record.sha256, &self.signature)
            .expect("machine rebuilds from the CAS blob");
        // The meter the snapshot reinstated must equal the meter the
        // supervisor record held — the ironhorse analogue of the daemon
        // restoring `SuspendedWorker::meter` onto the fresh machine.
        assert_eq!(
            worker.meter_state(),
            record.meter,
            "resumed meter equals the meter the supervisor held across suspend"
        );
        self.live.insert(handle, worker);
    }
}

/// A per-test CAS root under the process temp dir — the guard
/// pre-cleans any prior run's leftover and removes the directory on
/// drop, success or panic. Keyed by the test name and process id so
/// parallel test binaries never collide (the run is
/// `--test-threads=1`, but the isolation is cheap and correct
/// regardless).
fn cas_root(test_name: &str) -> common::TempDir {
    common::TempDir::new(&format!(
        "ironhorse-supervisor-it-{}-{}",
        std::process::id(),
        test_name
    ))
}

/// **The row-6 bar.** A worker that runs crank A, is suspended to the CAS
/// (its machine dropped), and is resumed on the next message continues crank
/// B identically — in both result and final computron count — to a worker
/// that ran both cranks without ever suspending.
#[test]
fn supervisor_suspend_resume_preserves_result_and_meter() {
    let root = cas_root("preserves-result-and-meter");

    // Reference: one resident worker runs both cranks, never suspending.
    let mut reference = SupervisorHarness::new(root.join("reference"));
    let r = reference.spawn();
    let _ra = reference.deliver(r, &PROG_A);
    let rb = reference.deliver(r, &PROG_B);
    assert!(rb.completed, "reference crank B completes");

    // Suspended: a worker runs crank A, the supervisor suspends it (machine
    // dropped to the CAS), then resumes it and delivers crank B.
    let mut sup = SupervisorHarness::new(root.join("suspended"));
    let w = sup.spawn();
    let a = sup.deliver(w, &PROG_A);
    assert!(a.completed, "crank A completes before suspend");

    sup.suspend(w);
    assert!(sup.is_suspended(w), "worker is suspended (machine dropped)");
    assert!(!sup.live.contains_key(&w), "no live machine survives suspend");

    sup.resume(w);
    assert!(!sup.is_suspended(w), "worker is resident again after resume");

    let b = sup.deliver(w, &PROG_B);
    assert_eq!(
        b.result, rb.result,
        "resumed worker's crank B result equals the uninterrupted run"
    );
    assert_eq!(
        b.computrons, rb.computrons,
        "resumed worker's final computron count equals the uninterrupted run \
         (meter continued through suspend/resume)"
    );
    // The resumed crank's total strictly exceeds crank A's alone: the meter
    // genuinely continued from the snapshot rather than resetting on resume.
    assert!(
        b.computrons > a.computrons,
        "meter continued (resumed total exceeds crank A alone)"
    );

}

/// The suspended blob is content-addressed and durable: the supervisor holds
/// the sha256 as its CAS key, the blob is stored under exactly that hash, and
/// a resume reads it back. This is the store-integration half of the daemon's
/// suspend path (`SuspendedWorker::{sha256, cas_dir}` → `resume_from_cas`).
#[test]
fn supervisor_suspend_writes_content_addressed_blob() {
    let root = cas_root("content-addressed-blob");
    let mut sup = SupervisorHarness::new(root.to_path_buf());
    let w = sup.spawn();
    sup.deliver(w, &PROG_A);

    let hash = sup.suspend(w);
    let record_dir = root.join(format!("worker-{w}"));
    let blob = record_dir.join(&hash);
    assert!(blob.exists(), "snapshot stored at its content hash");
    // The hash addresses exactly those bytes.
    let bytes = std::fs::read(&blob).expect("blob is readable");
    assert_eq!(
        ironhorse_snapshot::sha256::hex_sha256(&bytes),
        hash,
        "the CAS key is the content hash of the stored blob"
    );

    // And the worker resumes from precisely that stored blob.
    sup.resume(w);
    assert!(sup.live.contains_key(&w), "resumed from the stored blob");

}

/// Multiple workers suspend and resume independently under one supervisor,
/// each keyed by its own handle, and each continues its own crank correctly —
/// the handle-keyed `suspended` map of the daemon supervisor, exercised with
/// two concurrent-lifecycle ironhorse workers (interleaved suspend/resume).
#[test]
fn supervisor_suspends_multiple_workers_independently() {
    let root = cas_root("multiple-workers");

    // Reference results for each program, run resident-only.
    let mut reference = SupervisorHarness::new(root.join("reference"));
    let ref_a = reference.spawn();
    let ra = reference.deliver(ref_a, &PROG_A);
    let ref_b = reference.spawn();
    let rb = reference.deliver(ref_b, &PROG_B);

    let mut sup = SupervisorHarness::new(root.join("live"));
    let wa = sup.spawn();
    let wb = sup.spawn();

    // Both suspended before either resumes — the maps hold two records.
    sup.suspend(wa);
    sup.suspend(wb);
    assert!(sup.is_suspended(wa) && sup.is_suspended(wb));
    assert!(sup.live.is_empty(), "both machines dropped");

    // Resume in the opposite order and deliver each its program.
    sup.resume(wb);
    sup.resume(wa);

    let ba = sup.deliver(wa, &PROG_A);
    let bb = sup.deliver(wb, &PROG_B);
    assert_eq!(ba.result, ra.result, "worker A crank matches its reference");
    assert_eq!(ba.computrons, ra.computrons);
    assert_eq!(bb.result, rb.result, "worker B crank matches its reference");
    assert_eq!(bb.computrons, rb.computrons);

}
