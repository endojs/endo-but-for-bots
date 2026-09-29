//! Gap-revealing end-to-end probe of `designs/ironhorse-panic.md` (Refs #1018).
//!
//! Drives one C-XS worker through the design's recovery pipeline:
//!
//! 1. a panic mid-delivery (FFI callback panic, JS stack overflow, meter abort),
//! 2. a supervisor-visible `Panicked` outcome,
//! 3. discard of the crank's embargoed outbound frames,
//! 4. terminate,
//! 5. restore from the last committed snapshot,
//! 6. replay of the committed transcript suffix, up to but not including the
//!    panicking delivery,
//! 7. a debugger stop at the panic site.
//!
//! Tests named `today_*` pin what the live C-XS path does now, including the
//! places where it falls short of the design. Tests marked `#[ignore]` state
//! the design's required behavior for a stage whose mechanism does not exist
//! yet; each names the missing mechanism and the follow-up leg of the
//! `endojs-endo-but-for-bots-pr1018-followups-20260929` orchestration that
//! owns it. The PR body carries the full gap report.
//!
//! The harness is deliberately small: a crank is one `deliver(n, mode)` promise
//! job drained by `run_promise_jobs_metered`, and the "transcript" is a
//! test-local `Vec` of committed delivery numbers. The design's Slot Machine
//! supervisor, SQLite transcript, and embargo do not exist, so the harness
//! stands in for them only as far as needed to show which stages compose.

use std::sync::{Arc, Mutex};

use xsnap::ffi::{XsMachine, XS_JAVASCRIPT_STACK_OVERFLOW_EXIT, XS_TOO_MUCH_COMPUTATION_EXIT};
use xsnap::worker_io::{self, FfiPanic, InitResult, WorkerTransport};
use xsnap::{envelope, set_crank_limit, Machine, SuspendData, DEFAULT_CREATION};

const SIGNATURE: &[u8] = b"panic-e2e-probe 1";
const CRANK_LIMIT: u64 = 1_000_000;

/// Transport that records every outbound frame instead of writing a pipe.
/// Anything recorded here has "left the vat" in the design's sense.
struct Wire {
    sent: Arc<Mutex<Vec<Vec<u8>>>>,
}

impl WorkerTransport for Wire {
    fn init_handshake(&mut self) -> std::io::Result<InitResult> {
        Ok(InitResult::Init(0))
    }
    fn recv_raw_envelope(&mut self) -> std::io::Result<Option<Vec<u8>>> {
        Ok(None)
    }
    fn try_recv_raw_envelope(&mut self) -> std::io::Result<Option<Vec<u8>>> {
        Ok(None)
    }
    fn send_raw_frame(&mut self, data: &[u8]) -> std::io::Result<()> {
        self.sent.lock().unwrap().push(data.to_vec());
        Ok(())
    }
    fn send_frame(&mut self, payload: &[u8]) -> std::io::Result<()> {
        self.sent.lock().unwrap().push(payload.to_vec());
        Ok(())
    }
    fn recv_frame(&mut self) -> std::io::Result<Option<Vec<u8>>> {
        Ok(None)
    }
    fn daemon_handle(&self) -> envelope::Handle {
        0
    }
}

/// A test-only host function that panics inside the FFI guard, standing in
/// for any production callback's latent `panic!`/`.expect(..)` (design
/// § Scope, "The already-live FFI abort hazard").
unsafe extern "C" fn host_explode(_the: *mut XsMachine) {
    worker_io::guard_ffi(|| panic!("probe: injected callback panic"));
}

/// The guest. Each delivery records itself, sends one frame, optionally
/// faults, then records and sends again. `try`/`catch` surrounds every fault so
/// the test can see whether the fault was catchable.
const GUEST: &str = r#"
var state = [];
function hex(s) {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    out += s.charCodeAt(i).toString(16).padStart(2, '0');
  }
  return out;
}
function recurse() { return recurse() + 1; }
function deliver(n, mode) {
  state.push(n);
  sendFrame(hex('before-' + n));
  try {
    if (mode === 'ffi') explode();
    if (mode === 'stack') recurse();
    if (mode === 'meter') for (;;) {}
  } catch (e) {
    state.push('caught-' + mode);
  }
  state.push('after-' + n);
  sendFrame(hex('after-' + n));
}
"#;

#[derive(Debug, Clone, Copy, PartialEq)]
enum Mode {
    Ok,
    Ffi,
    Stack,
    Meter,
}

impl Mode {
    fn js(self) -> &'static str {
        match self {
            Mode::Ok => "ok",
            Mode::Ffi => "ffi",
            Mode::Stack => "stack",
            Mode::Meter => "meter",
        }
    }
}

/// What the harness can observe about one crank today. There is no
/// `ExecutionOutcome` for C-XS, so this is the raw material an adapter would
/// have to classify.
#[derive(Debug)]
struct CrankObservation {
    /// `run_promise_jobs_metered`'s status: `Ok` or the `fxAbort` exit code.
    xs_status: Result<(), i32>,
    /// The FFI guard's poison marker, drained at the crank boundary.
    ffi_panic: Option<FfiPanic>,
    /// Frames the crank put on the wire.
    frames: Vec<String>,
}

struct Worker {
    machine: Machine,
    sent: Arc<Mutex<Vec<Vec<u8>>>>,
}

fn install_wire() -> Arc<Mutex<Vec<Vec<u8>>>> {
    let sent = Arc::new(Mutex::new(Vec::new()));
    worker_io::install_transport(Box::new(Wire {
        sent: Arc::clone(&sent),
    }));
    sent
}

impl Worker {
    fn new(name: &str) -> Worker {
        xsnap::ensure_shared_cluster();
        let sent = install_wire();
        let machine = Machine::new(&DEFAULT_CREATION, name).expect("machine");
        machine.define_function("sendFrame", worker_io::host_send_frame, 1);
        machine.define_function("explode", host_explode, 0);
        machine.eval(GUEST).expect("install guest");
        machine.begin_metering(xsnap::DEFAULT_METERING_INTERVAL);
        Worker { machine, sent }
    }

    fn resume(data: &SuspendData, name: &str) -> Worker {
        let sent = install_wire();
        let machine = Machine::resume(data, name).expect("resume");
        machine.begin_metering(xsnap::DEFAULT_METERING_INTERVAL);
        Worker { machine, sent }
    }

    /// One crank: queue `deliver(n, mode)` as a promise job and drain it
    /// under the per-crank hard limit, mirroring the live main loop.
    fn crank(&self, n: u32, mode: Mode) -> CrankObservation {
        let before = self.sent.lock().unwrap().len();
        self.machine
            .eval(&format!(
                "Promise.resolve().then(() => deliver({n}, '{}'))",
                mode.js()
            ))
            .expect("queue delivery");
        self.machine.set_meter(0);
        set_crank_limit(CRANK_LIMIT);
        let xs_status = self.machine.run_promise_jobs_metered();
        set_crank_limit(0);
        worker_io::reset_capturing();
        let ffi_panic = if worker_io::ffi_panicked() {
            worker_io::take_ffi_panic()
        } else {
            None
        };
        let frames = self.sent.lock().unwrap()[before..]
            .iter()
            .map(|f| String::from_utf8_lossy(f).into_owned())
            .collect();
        CrankObservation {
            xs_status,
            ffi_panic,
            frames,
        }
    }

    fn state(&self) -> String {
        self.machine
            .eval_to_string("JSON.stringify(state)")
            .expect("state")
    }

    fn all_frames(&self) -> Vec<String> {
        self.sent
            .lock()
            .unwrap()
            .iter()
            .map(|f| String::from_utf8_lossy(f).into_owned())
            .collect()
    }
}

/// Runs `f` on its own thread: XS machines, the transport, and the FFI poison
/// marker are all thread-local, as they are for a live worker.
fn on_worker_thread<F: FnOnce() + Send + 'static>(f: F) {
    std::thread::spawn(f).join().expect("worker thread");
}

/// Marks a stage whose mechanism does not exist yet.
fn pending(leg: &str, mechanism: &str) -> ! {
    panic!("pending: {mechanism} (owned by leg {leg})")
}

// ---------------------------------------------------------------------------
// Stage 1: a panic mid-delivery. Pins today's behavior per source.
// ---------------------------------------------------------------------------

#[test]
fn today_ffi_callback_panic_is_confined_but_the_guest_keeps_running() {
    on_worker_thread(|| {
        let w = Worker::new("probe ffi");
        let obs = w.crank(1, Mode::Ffi);
        // The guard kept the panic from aborting the process and recorded it.
        let panic = obs.ffi_panic.expect("poison marker");
        assert!(panic.message.contains("injected callback panic"), "{panic:?}");
        // XS itself did not abort: the guard *returned* to the guest.
        assert_eq!(obs.xs_status, Ok(()));
        // So the guest ran past the panic site. The catch did not fire (the
        // guard does not throw), but `after-1` was pushed: the heap kept
        // mutating after the panic. Only the later `sendFrame` was
        // short-circuited by the poison.
        assert_eq!(w.state(), r#"[1,"after-1"]"#);
        assert_eq!(obs.frames, vec![wire("before-1")]);
    });
}

#[test]
fn today_stack_overflow_aborts_uncatchably_with_its_own_exit_code() {
    on_worker_thread(|| {
        let w = Worker::new("probe stack");
        let obs = w.crank(1, Mode::Stack);
        assert!(obs.ffi_panic.is_none());
        assert_eq!(obs.xs_status, Err(XS_JAVASCRIPT_STACK_OVERFLOW_EXIT));
        // Neither the catch nor the tail of `deliver` ran.
        assert_eq!(w.state(), "[1]");
        assert_eq!(obs.frames, vec![wire("before-1")]);
    });
}

#[test]
fn today_meter_abort_aborts_uncatchably_with_its_own_exit_code() {
    on_worker_thread(|| {
        let w = Worker::new("probe meter");
        let obs = w.crank(1, Mode::Meter);
        assert!(obs.ffi_panic.is_none());
        assert_eq!(obs.xs_status, Err(XS_TOO_MUCH_COMPUTATION_EXIT));
        assert_eq!(w.state(), "[1]");
        assert_eq!(obs.frames, vec![wire("before-1")]);
    });
}

// ---------------------------------------------------------------------------
// Stage 2: one supervisor-visible `Panicked` arm.
// ---------------------------------------------------------------------------

/// The live main loop (`xsnap/src/lib.rs`, the reactive pump) sets
/// `metering_abort = true` for *any* nonzero `run_promise_jobs_metered`
/// status and reports `send_meter_report(steps, "terminated")`. A stack
/// overflow therefore reaches the supervisor as a metering termination, and an
/// FFI panic reaches it only as an `XsnapError::Panicked` run-entry error
/// followed by `unregister`. Three sources, two unrelated channels, and no
/// single `Panicked` value.
#[test]
#[ignore = "gap: no C-XS ExecutionOutcome; owned by ironhorse-panic-cxs-panicked-adapter"]
fn every_panic_source_surfaces_one_panicked_outcome() {
    pending(
        "endojs-endo-but-for-bots-ironhorse-panic-cxs-panicked-adapter",
        "a C-XS adapter that maps XS_JAVASCRIPT_STACK_OVERFLOW_EXIT, \
         XS_TOO_MUCH_COMPUTATION_EXIT, XS_NATIVE_STACK_OVERFLOW_EXIT, \
         XS_NOT_ENOUGH_MEMORY_EXIT and XsnapError::Panicked to one \
         supervisor-visible Panicked arm carrying the source",
    );
}

// ---------------------------------------------------------------------------
// Stage 3: embargo discard.
// ---------------------------------------------------------------------------

#[test]
fn today_pre_panic_outbound_frames_escape_for_every_source() {
    for mode in [Mode::Ffi, Mode::Stack, Mode::Meter] {
        on_worker_thread(move || {
            let w = Worker::new("probe leak");
            let obs = w.crank(7, mode);
            assert!(
                obs.frames.contains(&wire("before-7")),
                "{mode:?}: expected today's leak, got {:?}",
                obs.frames
            );
        });
    }
}

#[test]
#[ignore = "gap: no outbound embargo; owned by ironhorse-panic-outbound-embargo"]
fn a_panicked_crank_releases_zero_outbound_frames() {
    for mode in [Mode::Ffi, Mode::Stack, Mode::Meter] {
        on_worker_thread(move || {
            let w = Worker::new("probe embargo");
            let obs = w.crank(7, mode);
            assert!(
                obs.frames.is_empty(),
                "{mode:?}: frames escaped a panicked crank: {:?}",
                obs.frames
            );
        });
    }
}

// ---------------------------------------------------------------------------
// Stage 4: terminate. Exists: the live loop breaks out and `inproc`
// unregisters the worker (`inproc::tests::panicked_manager_unregisters_*`).
// Not re-driven here; it needs the full bootstrap bundle and supervisor.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Stages 5 and 6: snapshot restore and transcript replay.
// ---------------------------------------------------------------------------

/// The engine primitives compose: snapshot after delivery 1, commit 2 and 3,
/// panic on 4, restore the snapshot, re-deliver 2 and 3 from a hand-kept log,
/// and the heap matches the live pre-panic state. What is missing is
/// everything the design assigns to Slot Machine around those primitives.
#[test]
fn today_snapshot_restore_plus_manual_redelivery_reaches_the_pre_panic_heap() {
    for mode in [Mode::Ffi, Mode::Stack, Mode::Meter] {
        on_worker_thread(move || {
            let live = Worker::new("probe live");
            assert!(live.crank(1, Mode::Ok).xs_status.is_ok());
            let snapshot = live.machine.suspend(SIGNATURE).expect("suspend");
            // Stand-in transcript: committed deliveries after the snapshot.
            let mut committed = Vec::new();
            for n in [2, 3] {
                let obs = live.crank(n, Mode::Ok);
                assert!(obs.xs_status.is_ok() && obs.ffi_panic.is_none());
                committed.push(n);
            }
            let pre_panic = live.state();
            let panicked = live.crank(4, mode);
            assert!(panicked.xs_status.is_err() || panicked.ffi_panic.is_some());
            drop(live);

            let restored = Worker::resume(&snapshot, "probe restored");
            assert_eq!(restored.state(), "[1,\"after-1\"]");
            for n in committed {
                assert!(restored.crank(n, Mode::Ok).xs_status.is_ok());
            }
            assert_eq!(restored.state(), pre_panic, "{mode:?}");
            // With no replay mode, redelivery re-sends every frame the
            // committed cranks already sent once.
            assert_eq!(
                restored.all_frames(),
                ["before-2", "after-2", "before-3", "after-3"]
                    .iter()
                    .map(|s| wire(s))
                    .collect::<Vec<_>>()
            );
        });
    }
}

#[test]
#[ignore = "gap: no per-worker transcript; owned by ironhorse-panic-transcript"]
fn committed_suffix_is_read_from_a_durable_per_worker_transcript() {
    pending(
        "endojs-endo-but-for-bots-ironhorse-panic-transcript",
        "<endo-dir>/workers/<handle>/transcript.sqlite with snapshot, crank, \
         event and host_handle records, and a snapshot watermark",
    );
}

#[test]
#[ignore = "gap: no replay mode; owned by ironhorse-panic-retry-replay"]
fn replay_suppresses_recorded_outbound_and_stops_before_the_panicking_delivery() {
    pending(
        "endojs-endo-but-for-bots-ironhorse-panic-retry-replay",
        "a supervisor replay mode that re-delivers only committed inbound \
         events after the snapshot watermark, matches each outbound send \
         against the recorded event (suppressing it), treats a mismatch as \
         a deterministic replay fault, and leaves the panicking delivery \
         pending for an explicit retry",
    );
}

#[test]
#[ignore = "gap: suspend refuses open native handles; owned by ironhorse-panic-host-call-transcript"]
fn a_snapshot_with_open_native_handles_can_serve_as_a_restore_point() {
    pending(
        "endojs-endo-but-for-bots-ironhorse-panic-host-call-transcript",
        "logical host handles with reconstruction descriptors; today \
         handle_suspend refuses with suspend-error while any native handle \
         is open, so a busy worker may have no restore point at all",
    );
}

// ---------------------------------------------------------------------------
// Stage 7: debugger stop at the panic site.
// ---------------------------------------------------------------------------

#[test]
#[ignore = "gap: no <panic> wire message; owned by ironhorse-panic-debugger-panic-break"]
fn an_attached_debugger_stops_at_the_panic_site() {
    pending(
        "endojs-endo-but-for-bots-ironhorse-panic-debugger-panic-break",
        "a <panic kind=...> element emitted on the always-fatal path and a \
         stop-the-world hook before teardown, independent of \
         setExceptionBreakMode; for an FFI callback panic this also needs \
         the guard to halt the guest at the callback (today it returns to \
         the guest, which runs on past the panic site)",
    );
}

/// `host_send_frame` hex-decodes its argument, so the wire carries the
/// guest's original ASCII tag.
fn wire(s: &str) -> String {
    s.to_string()
}
