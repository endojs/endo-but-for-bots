// The test store passes the engine's `StoreError` through as the trait does.
#![allow(clippy::result_large_err)]

use crate::*;
use ironhorse_snapshot::{
    machine::{begin_store_session, checkpoint_to_store, resume_from_store, StoreSession},
    store::{
        CommitToken, CommitTokenSource, CommitVerifier, HeapStore, MemoryStore, StoreError,
        StoreManifest,
    },
    Signature,
};
use ironhorse_vm::{parse_symbols, Interp};
use serde_json::{json, Value};
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

fn test_limits() -> WorkerLimits {
    WorkerLimits::parse(r#"{"crankBudget":"100000000","bootstrapBudget":"1000000000","slotCeiling":2000000,"chunkCeiling":536870912}"#).unwrap()
}

#[test]
fn configured_heap_above_default_survives_restore() {
    let limits = test_limits();
    let signature = Signature::new("configured-heap");
    let mut worker =
        Worker::begin(MemoryStore::new(), signature.clone(), limits.clone(), None).unwrap();
    assert_eq!(
        worker
            .eval(
                "globalThis.kept = null; for (var i = 0; i < 350000; i++) kept = {n:i, next:kept}; kept.n",
                limits.crank_budget
            )
            .unwrap(),
        "349999"
    );
    assert!(worker.machine().slots().capacity() > ironhorse_vm::value::DEFAULT_SLOT_CEILING);
    let store = worker.close().unwrap();
    // The resume reapplies the limits, which are not snapshot state.
    let mut restored =
        Worker::resume(store, signature, limits.clone(), Resume::Eager, None).unwrap();
    assert_eq!(restored.machine().slots().ceiling(), limits.slot_ceiling);
    assert_eq!(
        restored.machine().chunks().ceiling(),
        limits.chunk_ceiling as usize
    );
    assert_eq!(
        restored.eval("kept.n", limits.crank_budget).unwrap(),
        "349999"
    );
}

#[test]
fn configured_heap_and_meter_failures_remain_distinct() {
    for heap_failure in [false, true] {
        let signature = Signature::new("configured-refusal");
        let mut store = MemoryStore::new();
        let mut session = begin_store_session(Interp::new(), &signature, &mut store)
            .map_err(|(_, error)| error)
            .unwrap();
        // Link builtins before restricting subsequent guest allocation.
        eval(&mut session, "globalThis.kept = []", 1000000).unwrap();
        let budget = if heap_failure {
            let ceiling = session.machine_mut().slots().capacity() + 100;
            session.machine_mut().set_slot_ceiling(ceiling).unwrap();
            10000000
        } else {
            1000
        };
        let error = eval(
            &mut session,
            "for (var i = 0; i < 10000; i++) kept.push({i}); kept.length",
            budget,
        )
        .unwrap_err();
        assert!(
            error.contains(if heap_failure {
                "HeapExhausted"
            } else {
                "MeterAbort"
            }),
            "{error}"
        );
    }
}

#[test]
fn worker_limits_preserve_u64_budgets_and_validate_ceilings() {
    let limits = WorkerLimits::parse(r#"{"crankBudget":"9007199254740993","bootstrapBudget":"18446744073709551615","slotCeiling":2000000,"chunkCeiling":536870912}"#).unwrap();
    assert_eq!(limits.crank_budget, 9_007_199_254_740_993);
    assert_eq!(limits.bootstrap_budget, u64::MAX);
    assert!(positive_integer(&json!(0), "budget").is_err());
    assert!(positive_integer(&json!("18446744073709551616"), "budget").is_err());
}

#[test]
fn configured_ceilings_above_consensus_limits_are_refused() {
    let mut limits = test_limits();
    limits.slot_ceiling = ironhorse_vm::CONSENSUS_MAX_SLOT_CEILING + 1;
    assert!(limits
        .apply(&mut Interp::new())
        .unwrap_err()
        .contains("slotCeiling refused"));
    limits.slot_ceiling = test_limits().slot_ceiling;
    limits.chunk_ceiling = (ironhorse_vm::CONSENSUS_MAX_CHUNK_CEILING + 1) as u32;
    assert!(limits
        .apply(&mut Interp::new())
        .unwrap_err()
        .contains("chunkCeiling refused"));
}

#[test]
fn malformed_requests_are_answered_rather_than_fatal() {
    let crank_budget = 42;
    assert_eq!(
        parse_request(&json!({"op":"eval","source":"1"}), crank_budget).unwrap(),
        ("1", crank_budget)
    );
    assert_eq!(
        parse_request(
            &json!({"op":"eval","source":"1","budget":"9007199254740993"}),
            crank_budget
        )
        .unwrap(),
        ("1", 9_007_199_254_740_993)
    );
    assert_eq!(
        parse_request(&json!({"op":"eval"}), crank_budget).unwrap_err(),
        "source required"
    );
    assert_eq!(
        parse_request(&json!({"op":"eval","source":"1","budget":0}), crank_budget).unwrap_err(),
        "budget must be a positive u64 integer"
    );
    // The reply a shell writes for that request: one line, then the session
    // stays open.
    let (mut session, _) = memory_session("malformed");
    let error = json!({"op":"error", "message":"budget must be a positive u64 integer"});
    let Step::Continue(text) = respond(
        &mut session,
        &test_limits(),
        r#"{"op":"eval","source":"1","budget":0}"#,
    ) else {
        panic!("a malformed request is answered");
    };
    assert!(text.ends_with('\n') && !text.trim_end().contains('\n'));
    assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), error);
}

#[test]
fn worker_compilation_is_charged_without_changing_script_semantics() {
    let source = "var n = 7; n";
    let signature = Signature::new("worker-compile-test");
    let mut store = MemoryStore::new();
    let mut session = begin_store_session(Interp::new(), &signature, &mut store)
        .map_err(|(_, error)| error)
        .unwrap();
    let meter = ironhorse_compile::ParseMeter::with_budget(u64::MAX);
    let (code, symbols) = ironhorse_compile::compile_atoms_goal_with_meter(
        source,
        ironhorse_compile::Goal::Script,
        false,
        meter.clone(),
    )
    .unwrap();
    let mut baseline = Interp::new();
    baseline.link_intrinsics(&parse_symbols(&symbols));
    let expected = baseline.run(&code);
    assert_eq!(
        eval(&mut session, source, 1_000_000).unwrap(),
        expected.result
    );
    assert_eq!(
        session.machine_mut().meter_index(),
        expected.meter_raw + meter.raw()
    );
}

/// Every incomplete crank is fatal, so none is committed; a host
/// allocation failure says so, and is never reported as a guest halt.
#[test]
fn a_host_allocation_failure_is_fatal_and_named_as_the_hosts() {
    use ironhorse_vm::Halt;
    let host = crank_halted(&Halt::HostAllocationFailed);
    assert!(
        host.starts_with("host failure, crank not committed"),
        "{host}"
    );
    assert!(!host.contains("guest crank halted"), "{host}");
    assert_eq!(
        crank_halted(&Halt::HeapExhausted),
        "guest crank halted: HeapExhausted"
    );
}

#[test]
fn worker_admission_refuses_before_link_or_dispatch() {
    let signature = Signature::new("worker-compile-test");
    let mut store = MemoryStore::new();
    let mut session = begin_store_session(Interp::new(), &signature, &mut store)
        .map_err(|(_, error)| error)
        .unwrap();
    let start = session.machine_mut().meter_index();
    let source = format!("/*{}*/ 1", "x".repeat(1_000_000));
    assert_eq!(
        eval(&mut session, &source, 32).unwrap_err(),
        "guest crank halted: MeterAbort during compilation"
    );
    assert_eq!(session.machine_mut().meter_index() - start, 32 << 16);
    assert!(session.machine_mut().program_symbol_names().is_empty());
}

#[test]
fn finalizers_run_within_the_delivery_that_frees_their_targets() {
    let signature = Signature::new("worker-finalization");
    let mut store = MemoryStore::new();
    let mut session = begin_store_session(Interp::new(), &signature, &mut store)
        .map_err(|(_, error)| error)
        .unwrap();
    let budget = test_limits().crank_budget;
    eval(
        &mut session,
        "globalThis.gone = []; \
         globalThis.registry = new FinalizationRegistry(held => gone.push(held)); \
         globalThis.target = {}; registry.register(target, 'a'); 0",
        budget,
    )
    .unwrap();
    // The target dies in this crank. Its callback has not run when the
    // script reads `gone`, and has run by the time the crank is answered.
    assert_eq!(
        eval(&mut session, "target = null; gone.length", budget).unwrap(),
        "0"
    );
    assert!(!session.machine_mut().finalization_cleanup_pending());
    assert_eq!(
        eval(&mut session, "JSON.stringify(gone)", budget).unwrap(),
        "[\"a\"]"
    );
}

#[test]
fn a_cleanup_cascade_is_followed_to_its_end_and_an_endless_one_is_halted() {
    let signature = Signature::new("worker-finalization-cascade");
    let mut store = MemoryStore::new();
    let mut session = begin_store_session(Interp::new(), &signature, &mut store)
        .map_err(|(_, error)| error)
        .unwrap();
    let budget = test_limits().crank_budget;
    // Each callback registers one more doomed target, five times over:
    // every round's garbage flags the next, and the rounds end.
    eval(
        &mut session,
        "globalThis.rounds = 0; \
         globalThis.registry = new FinalizationRegistry(() => { \
           rounds += 1; if (rounds < 6) registry.register({}, 0); \
         }); \
         registry.register({}, 0); 0",
        budget,
    )
    .unwrap();
    assert_eq!(eval(&mut session, "rounds", budget).unwrap(), "6");
    // A cascade without an end is halted: by the round count when its
    // callbacks are cheap, by the budget the rounds share when they are
    // not. The cascade begins in the crank that registers it.
    let cheap = eval(
        &mut session,
        "globalThis.endless = new FinalizationRegistry(() => endless.register({}, 0)); \
         endless.register({}, 0); 0",
        budget,
    )
    .unwrap_err();
    assert!(cheap.contains("finalization cascade exceeded"), "{cheap}");
}

#[test]
fn a_costly_cleanup_cascade_spends_the_rounds_shared_budget() {
    let signature = Signature::new("worker-finalization-budget");
    let mut store = MemoryStore::new();
    let mut session = begin_store_session(Interp::new(), &signature, &mut store)
        .map_err(|(_, error)| error)
        .unwrap();
    // Each round burns well over the small budget's share of 64 rounds,
    // so the meter halts the cascade before the round count does.
    let costly = eval(
        &mut session,
        "globalThis.costly = new FinalizationRegistry(() => { \
           let x = 0; for (let i = 0; i < 100000; i += 1) x += i; \
           costly.register({}, x); \
         }); \
         costly.register({}, 0); 0",
        200_000,
    )
    .unwrap_err();
    assert!(
        costly.contains("guest crank halted") && !costly.contains("cascade exceeded"),
        "{costly}"
    );
}

fn memory_session(profile: &str) -> (StoreSession, MemoryStore) {
    let signature = Signature::new(profile);
    let mut store = MemoryStore::new();
    let session = begin_store_session(Interp::new(), &signature, &mut store)
        .map_err(|(_, error)| error)
        .unwrap();
    (session, store)
}

fn delivery_session() -> (StoreSession, MemoryStore) {
    memory_session("combined-delivery")
}

const TEST_OUTBOX: &str = "globalThis.frames = []; \
    globalThis.thixotropeTakeOutbound = () => { \
      const result = frames; frames = []; return result; \
    }; 0";

#[test]
fn combined_delivery_includes_jobs_and_finalizer_frames_before_extracting() {
    let (mut session, _) = delivery_session();
    let budget = test_limits().crank_budget;
    eval(&mut session, TEST_OUTBOX, budget).unwrap();
    eval(
        &mut session,
        "globalThis.registry = new FinalizationRegistry(held => { \
        frames.push('final:' + held); \
        Promise.resolve().then(() => frames.push('cleanup-job')); \
      }); \
      globalThis.dispatch = () => { \
        frames.push('sync'); \
        Promise.resolve().then(() => { \
          frames.push('job'); registry.register({}, 'gone'); \
        }); \
      }; 0",
        budget,
    )
    .unwrap();
    let frames = deliver(&mut session, "dispatch()", budget, budget).unwrap();
    assert_eq!(frames, r#"["sync","job","final:gone","cleanup-job"]"#);
    assert!(!session.machine_mut().finalization_cleanup_pending());
    assert_eq!(
        eval(&mut session, "JSON.stringify(frames)", budget).unwrap(),
        "[]"
    );
}

#[test]
fn combined_delivery_completes_cleanup_cascades_and_survives_restore() {
    let (mut session, mut store) = delivery_session();
    let budget = test_limits().crank_budget;
    eval(&mut session, TEST_OUTBOX, budget).unwrap();
    eval(
        &mut session,
        "globalThis.rounds = 0; \
        globalThis.registry = new FinalizationRegistry(() => { \
          rounds += 1; frames.push(rounds); \
          if (rounds < 6) registry.register({}, 0); \
        }); 0",
        budget,
    )
    .unwrap();
    assert_eq!(
        deliver(&mut session, "registry.register({}, 0)", budget, budget).unwrap(),
        "[1,2,3,4,5,6]"
    );
    assert!(!session.machine_mut().finalization_cleanup_pending());
    let signature = Signature::new("combined-delivery");
    checkpoint_to_store(&mut session, &signature, &mut store).unwrap();
    let mut restored = resume_from_store(&store, &signature).unwrap();
    assert_eq!(
        deliver(&mut restored, "frames.push(++rounds)", budget, budget).unwrap(),
        "[7]"
    );
}

#[test]
fn combined_delivery_halts_on_an_endless_cleanup_before_extracting() {
    let (mut session, _) = delivery_session();
    let budget = test_limits().crank_budget;
    eval(&mut session, TEST_OUTBOX, budget).unwrap();
    let error = deliver(
        &mut session,
        "globalThis.endless = new FinalizationRegistry(() => endless.register({}, 0)); \
         endless.register({}, 0); 0",
        budget,
        budget,
    )
    .unwrap_err();
    assert!(error.contains("finalization cascade exceeded"), "{error}");
}

#[test]
fn combined_delivery_keeps_extraction_budget_separate() {
    let (mut session, _) = delivery_session();
    let budget = test_limits().crank_budget;
    eval(&mut session, TEST_OUTBOX, budget).unwrap();
    let error = deliver(&mut session, "frames.push('ready')", budget, 1).unwrap_err();
    assert!(error.contains("MeterAbort"), "{error}");
}

// The protocol, one request shape at a time.

fn reply(step: Step) -> Value {
    let Step::Continue(text) = step else {
        panic!("expected a reply, got {step:?}");
    };
    assert!(text.ends_with('\n') && !text.trim_end().contains('\n'));
    serde_json::from_str(&text).unwrap()
}

fn protocol_worker() -> Worker<MemoryStore> {
    let mut worker = Worker::begin(
        MemoryStore::new(),
        Signature::new("protocol"),
        test_limits(),
        None,
    )
    .unwrap();
    worker.boot("outbox.js", TEST_OUTBOX).unwrap();
    worker
}

#[test]
fn the_ready_line_advertises_the_combined_delivery() {
    assert_eq!(
        ready_line(),
        "{\"features\":[\"deliver-v1\"],\"op\":\"ready\"}\n"
    );
}

#[test]
fn an_unparseable_line_is_answered_with_the_parser_error() {
    let mut worker = protocol_worker();
    let expected = serde_json::from_str::<Value>("{op")
        .unwrap_err()
        .to_string();
    assert_eq!(
        reply(worker.respond("{op")),
        json!({"op":"error", "message":expected})
    );
    // The session is still open.
    assert_eq!(
        reply(worker.respond(r#"{"op":"eval","source":"1 + 1"}"#)),
        json!({"op":"result", "result":"2"})
    );
}

#[test]
fn a_request_without_source_or_with_a_bad_budget_is_answered() {
    let mut worker = protocol_worker();
    for (request, message) in [
        (r#"{"op":"eval"}"#, "source required"),
        (r#"{"op":"deliver","budget":"1"}"#, "source required"),
        (
            r#"{"op":"eval","source":"1","budget":"-1"}"#,
            "budget must be a positive u64 integer",
        ),
        (
            r#"{"op":"deliver","source":"1","budget":0}"#,
            "budget must be a positive u64 integer",
        ),
        (
            r#"{"op":"deliver","source":"1","drainBudget":"0"}"#,
            "drainBudget must be a positive u64 integer",
        ),
        (
            r#"{"op":"deliver","source":"1","drainBudget":1.5}"#,
            "drainBudget must be a positive u64 integer",
        ),
    ] {
        assert_eq!(
            reply(worker.respond(request)),
            json!({"op":"error", "message":message}),
            "{request}"
        );
    }
    // None of them ran: the outbox is untouched and nothing was dispatched.
    assert_eq!(
        reply(worker.respond(r#"{"op":"eval","source":"frames.length"}"#)),
        json!({"op":"result", "result":"0"})
    );
}

#[test]
fn a_drain_budget_is_ignored_outside_a_delivery() {
    let mut worker = protocol_worker();
    assert_eq!(
        reply(worker.respond(r#"{"op":"eval","source":"3","drainBudget":0}"#)),
        json!({"op":"result", "result":"3"})
    );
}

#[test]
fn eval_and_deliver_requests_are_answered_with_their_results() {
    let mut worker = protocol_worker();
    assert_eq!(
        reply(
            worker.respond(r#"{"op":"eval","source":"frames.push('a'); 'ok'","budget":"1000000"}"#)
        ),
        json!({"op":"result", "result":"ok"})
    );
    assert_eq!(
        reply(worker.respond(r#"{"op":"deliver","source":"frames.push('b')","budget":"1000000","drainBudget":"1000000"}"#)),
        json!({"op":"result", "result":"[\"a\",\"b\"]"})
    );
    // Without a drain budget, extraction takes the crank budget.
    assert_eq!(
        reply(worker.respond(r#"{"op":"deliver","source":"frames.push('c')"}"#)),
        json!({"op":"result", "result":"[\"c\"]"})
    );
}

#[test]
fn an_unknown_or_missing_op_is_an_eval() {
    let mut worker = protocol_worker();
    for request in [
        r#"{"op":"frobnicate","source":"frames.push(1); 6 * 7"}"#,
        r#"{"source":"frames.push(1); 6 * 7"}"#,
    ] {
        assert_eq!(
            reply(worker.respond(request)),
            json!({"op":"result", "result":"42"}),
            "{request}"
        );
    }
    // An eval never extracts the outbox.
    assert_eq!(
        reply(worker.respond(r#"{"op":"eval","source":"frames.length"}"#)),
        json!({"op":"result", "result":"2"})
    );
}

#[test]
fn close_writes_nothing_and_needs_no_source() {
    let mut worker = protocol_worker();
    assert_eq!(worker.respond(r#"{"op":"close"}"#), Step::Close);
    assert_eq!(
        worker.respond(r#"{"op":"close","source":1,"budget":0}"#),
        Step::Close
    );
}

/// A store over a shared `MemoryStore` that counts its row reads and can be
/// made to fail them: a test keeps a handle on what a worker owns.
#[derive(Clone, Default)]
struct Probe {
    inner: Rc<RefCell<MemoryStore>>,
    row_reads: Rc<Cell<u32>>,
    failing: Rc<Cell<bool>>,
}

impl Probe {
    fn epoch(&self) -> u64 {
        self.inner.borrow().reread_manifest().unwrap().epoch
    }

    fn row(
        &self,
        read: impl FnOnce(&MemoryStore) -> Result<Vec<u8>, StoreError>,
    ) -> Result<Vec<u8>, StoreError> {
        if self.failing.get() {
            return Err(StoreError::Io("the probe fails its reads".into()));
        }
        self.row_reads.set(self.row_reads.get() + 1);
        read(&self.inner.borrow())
    }
}

impl HeapStore for Probe {
    fn manifest(&self) -> Result<StoreManifest, StoreError> {
        self.inner.borrow().manifest()
    }
    fn reread_manifest(&self) -> Result<StoreManifest, StoreError> {
        self.inner.borrow().reread_manifest()
    }
    fn replace_for_migration(
        &mut self,
        from: &StoreManifest,
        to: &StoreManifest,
        small: &[u8],
    ) -> Result<(), StoreError> {
        self.inner
            .borrow_mut()
            .replace_for_migration(from, to, small)
    }
    fn read_small_state(&self) -> Result<Vec<u8>, StoreError> {
        self.inner.borrow().read_small_state()
    }
    fn small_section_hashes(
        &self,
    ) -> Result<[[u8; 32]; ironhorse_snapshot::store_sections::SMALL_SECTION_COUNT], StoreError>
    {
        self.inner.borrow().small_section_hashes()
    }
    fn read_slot_page(&self, page: u32) -> Result<Vec<u8>, StoreError> {
        self.row(|store| store.read_slot_page(page))
    }
    fn read_chunk_extent(&self, ext: u32) -> Result<Vec<u8>, StoreError> {
        self.row(|store| store.read_chunk_extent(ext))
    }
    fn inventory(&self) -> Result<(Vec<usize>, Vec<usize>), StoreError> {
        self.inner.borrow().inventory()
    }
    fn read_free_seg(&self, seg: u32) -> Result<Vec<u8>, StoreError> {
        self.inner.borrow().read_free_seg(seg)
    }
    fn page_edges(&self) -> Result<Vec<Vec<u32>>, StoreError> {
        self.inner.borrow().page_edges()
    }
    fn commit_verified(&mut self, verify: &mut CommitVerifier<'_>) -> Result<(), StoreError> {
        self.inner.borrow_mut().commit_verified(verify)
    }
}

fn probe_worker(profile: &str) -> (Worker<Probe>, Probe) {
    let probe = Probe::default();
    let mut worker =
        Worker::begin(probe.clone(), Signature::new(profile), test_limits(), None).unwrap();
    worker.boot("outbox.js", TEST_OUTBOX).unwrap();
    worker.checkpoint().unwrap();
    (worker, probe)
}

#[test]
fn a_halted_crank_is_fatal_and_ends_the_worker() {
    let (mut worker, probe) = probe_worker("halt");
    let committed = probe.epoch();
    let Step::Die { line, error } =
        worker.respond(r#"{"op":"eval","source":"for (;;) {}","budget":"1000"}"#)
    else {
        panic!("a halt ends the worker");
    };
    assert!(
        error.starts_with("guest crank halted: MeterAbort"),
        "{error}"
    );
    assert!(line.ends_with('\n') && !line.trim_end().contains('\n'));
    assert_eq!(
        serde_json::from_str::<Value>(&line).unwrap(),
        json!({"op":"fatal", "message":error})
    );
    assert!(worker.is_dead());
    assert!(worker.close().is_err());
    assert_eq!(probe.epoch(), committed, "nothing committed");
    // A delivery whose extraction halts is fatal the same way.
    let (mut worker, probe) = probe_worker("halt");
    let committed = probe.epoch();
    let Step::Die { error, .. } =
        worker.respond(r#"{"op":"deliver","source":"0","drainBudget":"1"}"#)
    else {
        panic!("a halted extraction ends the worker");
    };
    assert!(error.contains("MeterAbort"), "{error}");
    assert!(worker.close().is_err());
    assert_eq!(probe.epoch(), committed, "nothing committed");
}

/// The dispatch half of this delivery completes and is swept, so the machine
/// is quiescent with its effects applied; the extraction is refused at
/// compilation. Only the latch keeps those effects from a commit.
#[test]
fn a_dead_worker_refuses_to_run_or_commit_and_hands_its_store_back() {
    let (mut worker, probe) = probe_worker("dead");
    let committed = probe.epoch();
    let Step::Die { error, .. } =
        worker.respond(r#"{"op":"deliver","source":"frames.push(1)","drainBudget":"1"}"#)
    else {
        panic!("a refused extraction ends the worker");
    };
    assert_eq!(error, "guest crank halted: MeterAbort during compilation");
    let dead = WorkerError::Dead(error.clone());
    assert_eq!(
        dead.to_string(),
        format!("worker is dead after a failed crank: {error}")
    );
    assert_eq!(worker.checkpoint().unwrap_err(), dead);
    assert_eq!(
        worker.eval("frames.length", 1_000_000).unwrap_err(),
        dead.to_string()
    );
    assert_eq!(
        worker.deliver("0", 1_000_000, 1_000_000).unwrap_err(),
        dead.to_string()
    );
    assert_eq!(worker.boot("again.js", "0").unwrap_err(), dead.to_string());
    assert_eq!(
        worker.respond(r#"{"op":"eval","source":"0"}"#),
        Step::Die {
            line: format!("{}\n", json!({"op":"fatal", "message":dead.to_string()})),
            error: dead.to_string(),
        }
    );
    assert_eq!(probe.epoch(), committed);
    // The store comes back as last committed, the failed crank not in it.
    let store = worker.into_store().unwrap();
    assert_eq!(store.epoch(), committed);
    let mut restored = Worker::resume(
        store,
        Signature::new("dead"),
        test_limits(),
        Resume::Eager,
        None,
    )
    .unwrap();
    assert_eq!(restored.eval("frames.length", 1_000_000).unwrap(), "0");
    // An Err from a direct crank kills the worker the same way.
    let (mut worker, probe) = probe_worker("dead");
    let committed = probe.epoch();
    let error = worker.eval("for (;;) {}", 1000).unwrap_err();
    assert_eq!(worker.close().err(), Some(WorkerError::Dead(error)));
    assert_eq!(probe.epoch(), committed);
}

/// A heap large enough that a lazy wake touches only part of it.
fn lazy_heap(profile: &str) -> (Probe, u64) {
    let (mut worker, probe) = probe_worker(profile);
    worker
        .eval(
            "globalThis.kept = null; for (var i = 0; i < 100000; i++) kept = {n:i, next:kept}; \
             globalThis.n = 41; 0",
            test_limits().crank_budget,
        )
        .unwrap();
    worker.close().unwrap();
    let epoch = probe.epoch();
    (probe, epoch)
}

fn slot_pages(probe: &Probe) -> u32 {
    ironhorse_snapshot::store::slot_page_count(probe.inner.borrow().manifest().unwrap().slot_count)
}

#[test]
fn a_lazy_resume_runs_a_crank_and_checkpoints() {
    let signature = Signature::new("lazy");
    let limits = test_limits();
    let (probe, booted) = lazy_heap("lazy");
    // The control: an eager resume reads every slot page.
    probe.row_reads.set(0);
    let worker = Worker::resume(
        probe.clone(),
        signature.clone(),
        limits.clone(),
        Resume::Eager,
        None,
    )
    .unwrap();
    assert!(probe.row_reads.get() >= slot_pages(&probe));
    drop(worker.into_store().unwrap());

    probe.row_reads.set(0);
    let mut worker = Worker::resume(
        probe.clone(),
        signature.clone(),
        limits.clone(),
        Resume::Lazy,
        Some(Box::new(Counted(100))),
    )
    .unwrap();
    assert!(
        probe.row_reads.get() < slot_pages(&probe) / 2,
        "{} of {} pages read",
        probe.row_reads.get(),
        slot_pages(&probe)
    );
    assert!(!worker.machine().slots().is_fully_resident());
    assert_eq!(worker.machine().slots().ceiling(), limits.slot_ceiling);
    assert_eq!(worker.eval("n += 1; n", limits.crank_budget).unwrap(), "42");
    assert_eq!(worker.checkpoint().unwrap(), booted + 1);
    assert_eq!(worker.session().token(), CommitToken([101; 16]));
    assert_eq!(worker.eval("n += 1; n", limits.crank_budget).unwrap(), "43");
    let store = worker.close().unwrap();
    assert_eq!(store.epoch(), booted + 2);

    let mut worker = Worker::resume(store, signature, limits, Resume::Eager, None).unwrap();
    assert_eq!(worker.eval("n", 1_000_000).unwrap(), "43");
    assert_eq!(worker.eval("kept.n", 1_000_000).unwrap(), "99999");
}

#[test]
fn a_lazy_store_fault_fails_the_crank_as_a_host_failure() {
    let signature = Signature::new("lazy-fault");
    let limits = test_limits();
    let (probe, committed) = lazy_heap("lazy-fault");
    let mut worker = Worker::resume(
        probe.clone(),
        signature.clone(),
        limits.clone(),
        Resume::Lazy,
        None,
    )
    .unwrap();
    probe.failing.set(true);
    // Walking the list faults pages the wake did not read.
    let Step::Die { line, error } = worker
        .respond(r#"{"op":"eval","source":"var c = 0; for (var k = kept; k; k = k.next) c++; c"}"#)
    else {
        panic!("a store fault ends the worker");
    };
    assert!(
        error.starts_with("host failure, crank not committed: StoreFault(Io("),
        "{error}"
    );
    assert!(error.ends_with("; restore in a fresh worker"), "{error}");
    assert!(!error.contains("guest crank halted"), "{error}");
    assert_eq!(
        serde_json::from_str::<Value>(&line).unwrap(),
        json!({"op":"fatal", "message":error})
    );
    assert!(worker.is_dead());
    probe.failing.set(false);
    assert_eq!(
        worker.checkpoint().unwrap_err(),
        WorkerError::Dead(error.clone())
    );
    assert!(matches!(
        worker.respond(r#"{"op":"eval","source":"0"}"#),
        Step::Die { .. }
    ));
    assert_eq!(probe.epoch(), committed, "nothing committed");
    // The same fault through a direct crank.
    let mut worker = Worker::resume(probe.clone(), signature, limits, Resume::Lazy, None).unwrap();
    probe.failing.set(true);
    let error = worker
        .eval(
            "var c = 0; for (var k = kept; k; k = k.next) c++; c",
            1_000_000_000,
        )
        .unwrap_err();
    assert!(
        error.starts_with("host failure, crank not committed"),
        "{error}"
    );
    assert!(worker.close().is_err());
    assert_eq!(probe.epoch(), committed);
}

#[test]
fn worker_errors_keep_the_store_error_and_print_as_before() {
    let refused = StoreError::NeedsMigration { found: 1 };
    for (error, text) in [
        (
            WorkerError::Begin(StoreError::NeedsMigration { found: 1 }),
            "begin: ",
        ),
        (
            WorkerError::Migrate(StoreError::NeedsMigration { found: 1 }),
            "migrate: ",
        ),
        (
            WorkerError::Restore(StoreError::NeedsMigration { found: 1 }),
            "restore: ",
        ),
        (
            WorkerError::Checkpoint(StoreError::NeedsMigration { found: 1 }),
            "checkpoint: ",
        ),
    ] {
        assert_eq!(error.to_string(), format!("{text}{refused:?}"));
        assert_eq!(error.store_error(), Some(&refused));
    }
    // A limits refusal prints as the refusal itself.
    let mut limits = test_limits();
    limits.slot_ceiling = ironhorse_vm::CONSENSUS_MAX_SLOT_CEILING + 1;
    let error = Worker::begin(MemoryStore::new(), Signature::new("limits"), limits, None)
        .err()
        .unwrap();
    assert!(matches!(error, WorkerError::Limits(_)), "{error:?}");
    assert!(
        error.to_string().starts_with("slotCeiling refused: "),
        "{error}"
    );
    assert_eq!(error.store_error(), None);
    // A resume of an empty store fails to restore, as the native worker's
    // resume of an empty file does.
    let error = Worker::resume(
        MemoryStore::new(),
        Signature::new("empty"),
        test_limits(),
        Resume::Eager,
        None,
    )
    .err()
    .unwrap();
    assert_eq!(error, WorkerError::Restore(StoreError::Empty));
    assert_eq!(error.to_string(), "restore: Empty");
}

// The worker's session.

/// Tokens counted up from one: reproducible, which a test may want and a
/// worker may not.
struct Counted(u8);
impl CommitTokenSource for Counted {
    fn next_token(&mut self) -> Result<CommitToken, StoreError> {
        self.0 += 1;
        Ok(CommitToken([self.0; 16]))
    }
}

#[test]
fn a_begin_draws_its_commit_tokens_from_the_shells_source() {
    let mut worker = Worker::begin(
        MemoryStore::new(),
        Signature::new("tokens"),
        test_limits(),
        Some(Box::new(Counted(0))),
    )
    .unwrap();
    assert_eq!(worker.session().token(), CommitToken([1; 16]));
    assert_eq!(
        worker.store().manifest().unwrap().token,
        CommitToken([1; 16])
    );
    worker.eval("globalThis.n = 1", 1_000_000).unwrap();
    assert_eq!(worker.checkpoint().unwrap(), 2);
    assert_eq!(worker.session().token(), CommitToken([2; 16]));
    // A source that refuses refuses the begin, and nothing is written.
    struct Refusing;
    impl CommitTokenSource for Refusing {
        fn next_token(&mut self) -> Result<CommitToken, StoreError> {
            Err(StoreError::TokenSource("no randomness here"))
        }
    }
    let probe = Probe::default();
    let refused = Worker::begin(
        probe.clone(),
        Signature::new("tokens"),
        test_limits(),
        Some(Box::new(Refusing)),
    )
    .err()
    .unwrap();
    assert_eq!(
        refused,
        WorkerError::Begin(StoreError::TokenSource("no randomness here"))
    );
    assert_eq!(
        probe.inner.borrow().manifest().unwrap_err(),
        StoreError::Empty
    );
}

/// A heap at an older store schema is upgraded in place before it resumes.
/// The heap is written by this build and restamped as schema 35, the last
/// schema before the commit token, whose small state is laid out as the
/// current one.
#[test]
fn a_resume_migrates_an_older_schema_first() {
    use ironhorse_snapshot::store::STORE_SCHEMA_VERSION;
    let signature = Signature::new("worker-migration-test");
    let mut worker =
        Worker::begin(MemoryStore::new(), signature.clone(), test_limits(), None).unwrap();
    assert_eq!(worker.eval("var n = 7; n", 1_000_000).unwrap(), "7");
    let mut store = worker.close().unwrap();
    let current = store.manifest().unwrap();
    let older = StoreManifest {
        store_schema: 35,
        ..current.clone()
    };
    let small = ironhorse_snapshot::store_sections::small_state_at_schema(
        &store.read_small_state().unwrap(),
        older.store_schema,
    )
    .unwrap();
    store
        .replace_for_migration(&current, &older, &small)
        .unwrap();
    // Without the migration, the restamped heap does not resume.
    assert!(matches!(
        resume_from_store(&store, &signature).unwrap_err(),
        StoreError::NeedsMigration { found: 35 }
    ));

    let mut worker = Worker::resume(store, signature, test_limits(), Resume::Eager, None).unwrap();
    assert_eq!(
        worker.store().manifest().unwrap(),
        StoreManifest {
            store_schema: STORE_SCHEMA_VERSION,
            ..current
        }
    );
    assert_eq!(worker.eval("var n; n + 1", 1_000_000).unwrap(), "8");
}
