//! Promise-cluster carry (`PRMS`, store schema 23): the four
//! cross-referencing side tables — `promises`, `promise_functions`,
//! `promise_guards`, `combinators` — PERSIST across a suspend/resume,
//! so a resumed machine's promises keep their identity, settlement
//! state, pending reactions, resolving functions, and combinator
//! progress. This retires the round-3 P1: a resumed settled promise
//! rendered `[object Object]` (its `promises` row silently dropped)
//! where the uninterrupted machine rendered `[object Promise]`, and a
//! stored resolver was refused outright by the persist gate.
//!
//! Every arm is an uninterrupted-vs-resumed TWIN (the
//! `side_table_ledger.rs` discipline): the same cranks run on one
//! continuous machine and across a checkpoint/resume split, and the
//! observations — completion, halt, result, COMPUTRONS — must be equal
//! and the real answer. Crank discipline: later cranks are RELINKED
//! (`relink_crank`), the managed-lifecycle path, on both twins alike;
//! every crank redeclares the same globals in the same order so
//! positional ids line up.

mod common;

use common::TempDir;

use ironhorse_snapshot::machine::{
    begin_store_session, checkpoint_to_store, from_snapshot_bytes, resume_from_store,
    MachineSnapshot,
};
use ironhorse_snapshot::store::{validate_store, HeapStore, MemoryStore};
use ironhorse_snapshot::store_file::FileStore;
use ironhorse_snapshot::Signature;
use ironhorse_vm::{parse_symbols, Interp};

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

fn compile(source: &str) -> (Vec<u8>, Vec<String>) {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("compiles");
    (bytecode, parse_symbols(&symbols))
}

/// Relink and run one crank, returning `(completed, halt debug, result,
/// computrons)`. The COMPUTRON count is part of the observation: a
/// resumed machine that answers correctly while charging differently
/// has still diverged.
fn crank(m: &mut Interp, src: &str) -> (bool, String, String, u64) {
    let (b, n) = compile(src);
    let b = m.relink_crank(&b, &n).expect("relink");
    let o = m.run(&b);
    (o.completed, format!("{:?}", o.halt), o.result, o.computrons)
}

/// Run crank 1 and then the observation cranks uninterrupted, and the
/// same cranks across a checkpoint/resume split on `store`; assert the
/// observations agree pairwise and return the continuous ones.
fn twin(
    crank1: &str,
    observations: &[&str],
    store: &mut dyn HeapStore,
) -> Vec<(bool, String, String, u64)> {
    let (b1, n1) = compile(crank1);

    let mut cont = Interp::new();
    cont.link_intrinsics(&n1);
    assert!(cont.run(&b1).completed, "crank 1 (continuous)");
    let continuous: Vec<_> = observations.iter().map(|s| crank(&mut cont, s)).collect();

    let mut m = Interp::new();
    m.link_intrinsics(&n1);
    assert!(m.run(&b1).completed, "crank 1 (store)");
    let session = begin_store_session(m, &sig(), store)
        .map_err(|(_, e)| e)
        .expect("begin (live promise state persists now)");
    drop(session);
    let mut session = resume_from_store(store, &sig()).expect("resume");
    let resumed: Vec<_> = observations
        .iter()
        .map(|s| crank(session.machine_mut(), s))
        .collect();
    assert_eq!(continuous, resumed, "resumed observes exactly as uninterrupted");
    continuous
}

/// The full twin over memory and file stores; asserts the continuous
/// observations are also the real answers.
fn assert_twin(name: &str, crank1: &str, observations: &[&str], expect: &[(bool, &str)]) {
    let mut mem = MemoryStore::new();
    let seen = twin(crank1, observations, &mut mem);
    let got: Vec<(bool, &str)> = seen
        .iter()
        .map(|(c, h, r, _)| (*c, if *c { r.as_str() } else { h.as_str() }))
        .collect();
    assert_eq!(got, expect, "the continuous observations are the real answers");

    let dir = TempDir::new(name);
    let mut file = FileStore::open(dir.join("heap.ihstore")).unwrap();
    twin(crank1, observations, &mut file);
}

/// The round-3 P1 repro, now a twin: a settled promise keeps its
/// EXOTIC IDENTITY (the `[object Promise]` render consults the row)
/// and its settlement — a `.then` attached after the split still sees
/// the stored value.
#[test]
fn a_resumed_settled_promise_keeps_its_identity_and_state() {
    assert_twin(
        "ih-prms-settled",
        "var p = 0; var g = 0; var t = 0; p = Promise.resolve(1); t = 7; t",
        &[
            "var p; var g; var t; p",
            "var p; var g; var t; p.then(function (v) { g = v + 41; }); 0",
            "var p; var g; var t; g",
        ],
        &[(true, "[object Promise]"), (true, "0"), (true, "42")],
    );
}

/// The shape the persist gate REFUSED before the carry: a stored
/// resolving function. It survives the split callable and still
/// settles its promise — including through the guard, which makes the
/// SECOND settlement attempt a metered no-op.
#[test]
fn a_resolver_called_after_resume_settles_its_promise() {
    assert_twin(
        "ih-prms-resolver",
        "var p = 0; var res = 0; var g = 0; var t = 0; \
         p = new Promise(function (rs, rj) { res = rs; }); t = 7; t",
        &[
            "var p; var res; var g; var t; t = typeof res; t",
            "var p; var res; var g; var t; p.then(function (v) { g = v; }); res(42); res(7); 0",
            "var p; var res; var g; var t; g",
        ],
        &[(true, "function"), (true, "0"), (true, "42")],
    );
}

/// A custom `NewPromiseCapability` executor can escape its constructor. Its
/// hidden resolve/reject capture and non-constructable native identity must
/// survive both snapshot backends, including the already-initialized guard
/// that rejects a second non-empty capture.
#[test]
fn a_custom_capability_executor_survives_resume() {
    assert_twin(
        "ih-prms-capability-executor",
        "var ex = 0; var log = ''; var t = 0; \
         function C(e) { ex = e; e(function (v) { log = 'r' + v; }, \
                                    function (v) { log = 'j' + v; }); return {}; } \
         Promise.resolve.call(C, 5); t = 7; t",
        &[
            "var ex; var log; var t; typeof ex + ':' + ex.name + ':' + ex.length + ':' + log",
            "var ex; var log; var t; try { ex(function () {}, function () {}); false } \
             catch (e) { e instanceof TypeError }",
        ],
        &[(true, "function::2:r5"), (true, "true")],
    );
}

/// A pending `.then` reaction can carry resolve/reject callbacks supplied by a
/// custom species constructor. The callbacks and the arbitrary result object
/// must retain identity and behavior across both snapshot backends.
#[test]
fn a_custom_species_reaction_survives_resume() {
    assert_twin(
        "ih-prms-custom-species-reaction",
        "var p=0;var res=0;var q=0;var result={tag:9};var log='';var t=0; \
         function C(executor){executor(function(v){log='r'+v},function(e){log='j'+e});return result} \
         p=new Promise(function(resolve){res=resolve});p.constructor={}; \
         p.constructor[Symbol.species]=C;q=p.then(function(v){return v+1});t=7;t",
        &[
            "var p;var res;var q;var result;var log;var t;(q===result)+':'+q.tag+':'+log",
            "var p;var res;var q;var result;var log;var t;res(41);0",
            "var p;var res;var q;var result;var log;var t;log",
        ],
        &[(true, "true:9:"), (true, "0"), (true, "r42")],
    );
}

/// A custom Promise subclass selected by `finally` remains threaded through
/// the pending callback-result await, including its outer capability and the
/// subclass prototype, across a checkpoint boundary.
#[test]
fn a_custom_species_finally_await_survives_resume() {
    assert_twin(
        "ih-prms-custom-species-finally",
        "var P=class extends Promise{};var gate=0;var release=0;var q=0;var g='';var t=0; \
         gate=new Promise(function(resolve){release=resolve});var p=Promise.resolve(5); \
         p.constructor={};p.constructor[Symbol.species]=P; \
         q=p.finally(function(){return gate});t=7;t",
        &[
            "var P;var gate;var release;var q;var g;var t;(q instanceof P)+':'+(q.constructor===P)+':'+g",
            "var P;var gate;var release;var q;var g;var t;q.then(function(v){g='r'+v},function(e){g='j'+e});release(1);0",
            "var P;var gate;var release;var q;var g;var t;g",
        ],
        &[(true, "true:true:"), (true, "0"), (true, "r5")],
    );
}

/// A `.then` reaction registered BEFORE the split fires after it: the
/// pending reaction row (handler + derived capability) travels.
#[test]
fn a_reaction_attached_before_suspend_fires_after_resume() {
    assert_twin(
        "ih-prms-reaction",
        "var p = 0; var res = 0; var g = 0; var t = 0; \
         p = new Promise(function (rs, rj) { res = rs; }); \
         p.then(function (v) { g = v + 1; }); t = 7; t",
        &[
            "var p; var res; var g; var t; res(5); 0",
            "var p; var res; var g; var t; g",
        ],
        &[(true, "0"), (true, "6")],
    );
}

/// The pair's shared `[[AlreadyResolved]]` guard travels TRIPPED: a
/// resolve fired before the split makes the reject fired after it a
/// no-op, so the promise stays fulfilled.
#[test]
fn the_already_resolved_guard_survives_resume() {
    assert_twin(
        "ih-prms-guard",
        "var p = 0; var res = 0; var rej = 0; var g = 0; var t = 0; \
         p = new Promise(function (rs, rj) { res = rs; rej = rj; }); \
         res(1); t = 7; t",
        &[
            "var p; var res; var rej; var g; var t; rej('nope'); \
             p.then(function (v) { g = 'ok:' + v; }, function (e) { g = 'rej:' + e; }); 0",
            "var p; var res; var rej; var g; var t; g",
        ],
        &[(true, "0"), (true, "ok:1")],
    );
}

/// The keystone two-level structure: resolving with a thenable mints a
/// SECOND resolving pair (its own fresh guard) while the promise stays
/// pending. The thenable stored that second pair's resolve; calling it
/// after the split settles the promise.
#[test]
fn a_thenable_resolutions_second_pair_survives_resume() {
    assert_twin(
        "ih-prms-thenable",
        "var p = 0; var srs = 0; var g = 0; var t = 0; \
         p = Promise.resolve({ then: function (rs, rj) { srs = rs; } }); t = 7; t",
        &[
            "var p; var srs; var g; var t; p.then(function (v) { g = v; }); srs(9); 0",
            "var p; var srs; var g; var t; g",
        ],
        &[(true, "0"), (true, "9")],
    );
}

/// `Promise.all` mid-flight: one element settled before the split
/// (remaining already decremented, its value in the accumulator), one
/// after. The combinator row, its `Combine` reaction, and the derived
/// promise's user reaction all travel.
#[test]
fn promise_all_mid_flight_completes_after_resume() {
    assert_twin(
        "ih-prms-all",
        "var p1 = 0; var p2 = 0; var r1 = 0; var r2 = 0; var g = 0; var t = 0; \
         p1 = new Promise(function (rs, rj) { r1 = rs; }); \
         p2 = new Promise(function (rs, rj) { r2 = rs; }); \
         Promise.all([p1, p2]).then(function (v) { g = v[0] + '-' + v[1]; }); \
         r1(1); t = 7; t",
        &[
            "var p1; var p2; var r1; var r2; var g; var t; t = '' + g; t",
            "var p1; var p2; var r1; var r2; var g; var t; r2(2); 0",
            "var p1; var p2; var r1; var r2; var g; var t; g",
        ],
        &[(true, "0"), (true, "0"), (true, "1-2")],
    );
}

/// A static combinator can retain callbacks supplied by an arbitrary result
/// constructor. The custom result object and the pending accumulator survive
/// both snapshot backends, then the restored callback receives the final Array.
#[test]
fn a_custom_capability_combinator_survives_resume() {
    assert_twin(
        "ih-prms-custom-combinator",
        "var p=0;var res=0;var q=0;var result={tag:9};var log='';var t=0; \
         function C(executor){executor(function(v){log='r'+v[0]}, \
                                       function(e){log='j'+e});return result} \
         C.resolve=function(v){return Promise.resolve(v)}; \
         p=new Promise(function(resolve){res=resolve}); \
         q=Promise.all.call(C,[p]);t=7;t",
        &[
            "var p;var res;var q;var result;var log;var t;(q===result)+':'+q.tag+':'+log",
            "var p;var res;var q;var result;var log;var t;res(42);0",
            "var p;var res;var q;var result;var log;var t;log",
        ],
        &[(true, "true:9:"), (true, "0"), (true, "r42")],
    );
}

/// A custom `then` may retain the engine's per-element callback beyond the
/// combinator call. Its one-shot guard and direct combinator reaction must
/// survive a checkpoint before the guest eventually invokes it.
#[test]
fn a_retained_custom_then_element_callback_survives_resume() {
    assert_twin(
        "ih-prms-direct-combinator",
        "var fulfill=0;var result={};var log='';var t=0; \
         function C(executor){executor(function(v){log='r'+v[0]}, \
                                       function(e){log='j'+e});return result} \
         C.resolve=function(){return {then:function(resolve){fulfill=resolve}}}; \
         Promise.all.call(C,[1]);t=7;t",
        &[
            "var fulfill;var result;var log;var t;typeof fulfill+':'+fulfill.name+':'+fulfill.length+':'+log",
            "var fulfill;var result;var log;var t;fulfill(42);fulfill(9);0",
            "var fulfill;var result;var log;var t;log",
        ],
        &[(true, "function::1:"), (true, "0"), (true, "r42")],
    );
}

/// `Promise.race` and `Promise.any` mid-flight, in one machine: the
/// race settles with whichever element settles first after the split;
/// the `any` — one element already rejected before it — rejects only
/// once the last element rejects.
#[test]
fn race_and_any_mid_flight_complete_after_resume() {
    assert_twin(
        "ih-prms-race-any",
        "var p1 = 0; var p2 = 0; var r1 = 0; var r2 = 0; var j1 = 0; var j2 = 0; \
         var ga = 0; var gb = 0; var t = 0; \
         p1 = new Promise(function (rs, rj) { r1 = rs; j1 = rj; }); \
         p2 = new Promise(function (rs, rj) { r2 = rs; j2 = rj; }); \
         Promise.race([p1, p2]).then(function (v) { ga = 'won:' + v; }); \
         Promise.any([p1, p2]).then(function (v) { gb = 'ok:' + v; }, \
                                    function (e) { gb = 'allrejected'; }); \
         j1('x'); t = 7; t",
        &[
            "var p1; var p2; var r1; var r2; var j1; var j2; var ga; var gb; var t; \
             t = ga + '|' + gb; t",
            "var p1; var p2; var r1; var r2; var j1; var j2; var ga; var gb; var t; j2('y'); 0",
            "var p1; var p2; var r1; var r2; var j1; var j2; var ga; var gb; var t; \
             t = ga + '|' + gb; t",
        ],
        // Before the split the race already LOST to j1's rejection —
        // rejections win races too — so `ga` never updates (the race's
        // on-rejected is absent, the reaction latches done). The `any`
        // still waits for the second element.
        &[(true, "0|0"), (true, "0"), (true, "0|allrejected")],
    );
}

/// `Promise.prototype.finally` across the split: the `FinallyReturn`
/// reaction runs its callback and passes the ORIGINAL value through.
#[test]
fn a_finally_reaction_passes_through_across_the_split() {
    assert_twin(
        "ih-prms-finally",
        "var p = 0; var res = 0; var ran = 0; var g = 0; var t = 0; \
         p = new Promise(function (rs, rj) { res = rs; }); \
         p.finally(function () { ran = 1; return 99; }) \
          .then(function (v) { g = 'v:' + v + ',ran:' + ran; }); t = 7; t",
        &[
            "var p; var res; var ran; var g; var t; res(5); 0",
            "var p; var res; var ran; var g; var t; g",
        ],
        &[(true, "0"), (true, "v:5,ran:1")],
    );
}

/// The second half of `finally` crosses the split too: `onFinally` has run and
/// returned a still-pending promise, so the carried `FinallyAwait` reaction
/// must retain both the original settlement and the derived capability until
/// the returned promise settles after resume.
#[test]
fn a_finally_await_reaction_restores_the_original_value_after_resume() {
    assert_twin(
        "ih-prms-finally-await",
        "var gate = 0; var release = 0; var g = 0; var t = 0; \
         gate = new Promise(function (rs) { release = rs; }); \
         Promise.resolve(5).finally(function () { return gate; }) \
          .then(function (v) { g = 'v:' + v; }, function (e) { g = 'e:' + e; }); \
         t = 7; t",
        &[
            "var gate; var release; var g; var t; release(9); 0",
            "var gate; var release; var g; var t; g",
        ],
        &[(true, "0"), (true, "v:5")],
    );
}

/// The unhandled-rejection latch (`ever_handled`) travels: a rejection
/// nothing observed stays reportable after the split, and a late
/// `.catch` both reads the stored reason and clears the report — on
/// the resumed machine exactly as on the uninterrupted one.
#[test]
fn the_unhandled_rejection_latch_survives_resume() {
    let crank1 = "var p = 0; var g = 0; var t = 0; \
                  p = new Promise(function (rs, rj) { rj('boom'); }); t = 7; t";
    let observe = "var p; var g; var t; p.then(0, function (e) { g = 'caught:' + e; }); 0";
    let read = "var p; var g; var t; g";
    let (b1, n1) = compile(crank1);

    let mut cont = Interp::new();
    cont.link_intrinsics(&n1);
    assert!(cont.run(&b1).completed, "crank 1 (continuous)");
    assert!(cont.has_unhandled_rejection(), "the fixture rejects unobserved");
    let cont_obs = (crank(&mut cont, observe), cont.has_unhandled_rejection(), crank(&mut cont, read));

    let mut m = Interp::new();
    m.link_intrinsics(&n1);
    assert!(m.run(&b1).completed, "crank 1 (store)");
    let mut store = MemoryStore::new();
    drop(
        begin_store_session(m, &sig(), &mut store)
            .map_err(|(_, e)| e)
            .expect("begin"),
    );
    let mut session = resume_from_store(&store, &sig()).expect("resume");
    assert!(
        session.machine_mut().has_unhandled_rejection(),
        "the resumed machine still reports the unobserved rejection"
    );
    let res_obs = (
        crank(session.machine_mut(), observe),
        session.machine_mut().has_unhandled_rejection(),
        crank(session.machine_mut(), read),
    );
    assert_eq!(cont_obs, res_obs, "twin observations agree");
    assert!(!cont_obs.1, "the late catch clears the report");
    assert_eq!(cont_obs.2 .2, "caught:boom", "the stored reason reaches the handler");
}

/// A resumed machine holding restored promise rows must checkpoint
/// cleanly — the cluster re-serializes into the next commit and the
/// store still validates — and a SECOND resume still settles through
/// the re-serialized resolver.
#[test]
fn a_resumed_machine_checkpoints_its_restored_promise_rows() {
    let mut store = MemoryStore::new();
    let (b1, n1) = compile(
        "var p = 0; var res = 0; var g = 0; var t = 0; \
         p = new Promise(function (rs, rj) { res = rs; }); \
         p.then(function (v) { g = v; }); t = 7; t",
    );
    let mut m = Interp::new();
    m.link_intrinsics(&n1);
    assert!(m.run(&b1).completed, "crank 1");
    drop(
        begin_store_session(m, &sig(), &mut store)
            .map_err(|(_, e)| e)
            .expect("begin"),
    );
    let mut session = resume_from_store(&store, &sig()).expect("resume");
    let (done, _, result, _) = crank(
        session.machine_mut(),
        "var p; var res; var g; var t; t = typeof res; t",
    );
    assert!(done, "observation completes");
    assert_eq!(result, "function");
    checkpoint_to_store(&mut session, &sig(), &mut store).expect("checkpoint after resume");
    validate_store(&store, &sig()).expect("post-crank store validates");
    let mut session = resume_from_store(&store, &sig()).expect("second resume");
    let (done, _, _, _) = crank(session.machine_mut(), "var p; var res; var g; var t; res(3); 0");
    assert!(done);
    let (done, _, result, _) = crank(session.machine_mut(), "var p; var res; var g; var t; g");
    assert!(done);
    assert_eq!(result, "3", "the twice-resumed resolver still settles its promise");
}

/// The blob verbs share the carry: suspend to container bytes, rebuild,
/// and the restored machine settles exactly as the continuous one.
#[test]
fn blob_snapshot_carries_the_promise_cluster_too() {
    let crank1 = "var p = 0; var res = 0; var g = 0; var t = 0; \
                  p = new Promise(function (rs, rj) { res = rs; }); \
                  p.then(function (v) { g = v * 2; }); t = 7; t";
    let obs = [
        "var p; var res; var g; var t; res(21); 0",
        "var p; var res; var g; var t; g",
    ];
    let (b1, n1) = compile(crank1);

    let mut cont = Interp::new();
    cont.link_intrinsics(&n1);
    assert!(cont.run(&b1).completed, "crank 1 (continuous)");
    let continuous: Vec<_> = obs.iter().map(|s| crank(&mut cont, s)).collect();

    let mut m = Interp::new();
    m.link_intrinsics(&n1);
    assert!(m.run(&b1).completed, "crank 1 (blob)");
    let bytes = m.write_snapshot(&sig()).expect("suspend with live promise state");
    let mut r = from_snapshot_bytes(&bytes, &sig()).expect("rebuild");
    let resumed: Vec<_> = obs.iter().map(|s| crank(&mut r, s)).collect();
    assert_eq!(resumed, continuous, "blob twin agrees");
    assert_eq!(continuous[1].2, "42");
}
