//! The **backend-parameterized store acceptance suite** (store seam
//! design, decision 8): the metamorphic determinism runner (seven execution ways),
//! the lazy working-set bound, the checkpoint acceptance locks, the
//! resume-equals-uninterrupted twin, and the boundary-collection twins
//! (continuous against resumed live counts and canonical bytes after a
//! collection), generic over the [`HeapStore`] under test so every backend —
//! in-crate reference or external (the daemon-side SQLite store) —
//! runs the SAME instrument rather than a hand-copied subset.
//!
//! Gated behind the `store-suite` cargo feature: this module is test
//! support, compiled into the library only so that OTHER crates'
//! integration tests (which cannot see this crate's `tests/`) can
//! instantiate it against their backends. In-crate tests activate it
//! through a self dev-dependency.
//!
//! What deliberately does NOT live here: the byte-level corruption
//! sweeps and commit-stats proportionality locks. Those poke a
//! backend's physical representation (file bytes, per-commit row
//! counters), so their failure taxonomy is backend-specific by
//! nature; they stay next to the backend they describe.

use crate::store::HeapStoreCommit;
use std::cell::RefCell;
use std::rc::Rc;

use crate::machine::{
    begin_store_session, checkpoint_to_store, from_snapshot_bytes, resume_from_store,
    resume_from_store_lazy, MachineSnapshot, StoreSession,
};
use crate::sha256::hex_sha256;
use crate::store::{
    chunk_extent_count, derive_page_edges, export_to_container, root_hash, slot_page_count,
    store_to_image, HeapStore, SLOTS_PER_PAGE,
};
use crate::Signature;
use ironhorse_vm::{parse_symbols, Interp};

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

fn compile(source: &str) -> (Vec<u8>, Vec<ironhorse_vm::SymbolName>) {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("fixture compiles");
    (bytecode, parse_symbols(&symbols))
}

/// One crank's host-visible verdict: the completion flag, the rendered
/// result, the halt itself (rendered with `Debug`), and the harness's
/// coercion error. All four must agree across the seven ways. Every
/// non-completion renders an empty result, so without the halt two
/// different halts would agree on the flag and the string; and a
/// null-prototype completion renders the same `[object Object]` as a
/// plain object with the same `Return` halt, so without the coercion
/// error a resumed twin that lost the null prototype link would agree
/// on everything the other three fields see.
type CrankResult = (bool, String, String, Option<String>);

fn crank_result(o: &ironhorse_vm::RunOutcome) -> CrankResult {
    (
        o.completed,
        o.result.clone(),
        format!("{:?}", o.halt),
        o.coercion_error.clone(),
    )
}

struct Baseline {
    results: Vec<CrankResult>,
    /// Cumulative computrons AFTER EVERY CRANK, not just the last: a
    /// mid-run meter divergence that reconverges by the final crank
    /// must still fail.
    computrons: Vec<u64>,
    final_blob: Vec<u8>,
}

fn run_baseline(scenario: &str, compiled: &[(Vec<u8>, Vec<ironhorse_vm::SymbolName>)]) -> Baseline {
    let mut m = Interp::new();
    m.link_intrinsics(&compiled[0].1);
    let mut results = Vec::new();
    let mut computrons = Vec::new();
    for (i, (bytecode, names)) in compiled.iter().enumerate() {
        let code = if i == 0 {
            bytecode.clone()
        } else {
            m.relink_crank(bytecode, names).expect("crank relinks")
        };
        let o = m.run(&code);
        // The suite's real precondition is a QUIESCENT boundary after
        // every crank, which `completed` now agrees with by
        // construction; asserting the predicate itself keeps the two
        // reconciled (a crank whose completion value the oracle
        // harness cannot coerce completes with `coercion_error` set,
        // and the seven ways must agree on it too). A crank that
        // genuinely halts fails here, loudly.
        assert!(
            m.is_quiescent(),
            "{scenario} baseline crank {} must leave a quiescent machine (halt: {:?})",
            i + 1,
            o.halt
        );
        results.push(crank_result(&o));
        computrons.push(o.computrons);
    }
    Baseline {
        results,
        computrons,
        final_blob: m
            .write_snapshot(&sig())
            .expect("quiescent machine snapshots"),
    }
}

fn assert_agrees(
    variant: &str,
    scenario: &str,
    baseline: &Baseline,
    results: &[CrankResult],
    computrons: &[u64],
    final_blob: &[u8],
) {
    assert_eq!(
        results,
        &baseline.results[..],
        "[{scenario}/{variant}] per-crank results agree"
    );
    assert_eq!(
        computrons,
        &baseline.computrons[..],
        "[{scenario}/{variant}] per-crank computron vector agrees"
    );
    assert_eq!(
        final_blob,
        &baseline.final_blob[..],
        "[{scenario}/{variant}] final canonical blob agrees byte-for-byte"
    );
}

/// Variant 2: blob suspend/resume between every crank.
fn run_blob(
    compiled: &[(Vec<u8>, Vec<ironhorse_vm::SymbolName>)],
) -> (Vec<CrankResult>, Vec<u64>, Vec<u8>) {
    run_blob_scheduled(compiled, &vec![true; compiled.len()])
}

fn run_blob_scheduled(
    compiled: &[(Vec<u8>, Vec<ironhorse_vm::SymbolName>)],
    suspend_before: &[bool],
) -> (Vec<CrankResult>, Vec<u64>, Vec<u8>) {
    let mut m = Interp::new();
    m.link_intrinsics(&compiled[0].1);
    let mut results = Vec::new();
    let mut computrons = Vec::new();
    for (i, (bytecode, names)) in compiled.iter().enumerate() {
        if i > 0 && suspend_before[i] {
            let bytes = m
                .write_snapshot(&sig())
                .expect("quiescent machine snapshots");
            m = from_snapshot_bytes(&bytes, &sig()).expect("blob resumes");
        }
        let code = if i == 0 {
            bytecode.clone()
        } else {
            m.relink_crank(bytecode, names).expect("crank relinks")
        };
        let o = m.run(&code);
        results.push(crank_result(&o));
        computrons.push(o.computrons);
    }
    (
        results,
        computrons,
        m.write_snapshot(&sig())
            .expect("quiescent machine snapshots"),
    )
}

/// How a store-backed variant resumes between cranks.
enum Resume {
    Eager,
    Lazy,
    LazyAdversarialPrefetch,
    /// Prefetch everything, then evict every clean page and extent —
    /// both right after the resume (attach-time rows) and right after
    /// each checkpoint (rows the session itself just committed and
    /// cleaned). Any evict schedule must be observably irrelevant
    /// (see `designs/ironhorse-snapshot-store-seam.md`), including
    /// commit-then-evict-then-refault: the fault must check the refreshed
    /// leaves, not stale attach-time leaves. The arm asserts
    /// eviction genuinely happened, so a future guard change cannot
    /// silently degrade it into a prefetch duplicate.
    LazyAdversarialEvict,
}

/// Variants 3-6: store-backed sleep/wake between every crank, with the
/// chosen resume mode, against a fresh backend from the caller.
fn run_store<S: HeapStore + 'static>(
    store: S,
    compiled: &[(Vec<u8>, Vec<ironhorse_vm::SymbolName>)],
    mode: Resume,
) -> (Vec<CrankResult>, Vec<u64>, Vec<u8>) {
    run_store_scheduled(store, compiled, mode, &vec![true; compiled.len()])
}

fn run_store_scheduled<S: HeapStore + 'static>(
    store: S,
    compiled: &[(Vec<u8>, Vec<ironhorse_vm::SymbolName>)],
    mode: Resume,
    suspend_before: &[bool],
) -> (Vec<CrankResult>, Vec<u64>, Vec<u8>) {
    let store = Rc::new(RefCell::new(store));
    let mut results = Vec::new();
    let mut computrons = Vec::new();

    // Crank 1 on a fresh machine, then bind.
    let mut m = Interp::new();
    m.link_intrinsics(&compiled[0].1);
    let o = m.run(&compiled[0].0);
    results.push(crank_result(&o));
    computrons.push(o.computrons);
    let mut session = begin_store_session(m, &sig(), &mut *store.borrow_mut())
        .map_err(|(_, e)| e)
        .expect("begin session");

    let mut evictions = 0u32;
    for (i, (bytecode, names)) in compiled.iter().enumerate().skip(1) {
        if suspend_before[i] {
            drop(session);
            session = match mode {
                Resume::Eager => resume_from_store(&*store.borrow(), &sig()).expect("resumes"),
                Resume::Lazy | Resume::LazyAdversarialPrefetch | Resume::LazyAdversarialEvict => {
                    resume_from_store_lazy(store.clone(), &sig()).expect("resumes lazily")
                }
            };
        }
        if let Resume::LazyAdversarialEvict = mode {
            // Warm everything, then throw it all away again: the
            // re-faults must reinstall identical content.
            let manifest = store.borrow().manifest().unwrap();
            for page in 0..slot_page_count(manifest.slot_count) {
                session.machine().slots.touch_page(page);
            }
            for ext in 0..chunk_extent_count(manifest.chunk_len) {
                session.machine().chunks.touch_extent(ext);
            }
            for page in 0..slot_page_count(manifest.slot_count) {
                evictions += session.machine().slots.evict_page(page) as u32;
            }
            for ext in 0..chunk_extent_count(manifest.chunk_len) {
                evictions += session.machine().chunks.evict_extent(ext) as u32;
            }
            // A freshly resumed session is wholly clean, so the evict
            // sweep must have emptied residency — the arm's premise.
            assert_eq!(
                session.machine().slots.resident_page_count(),
                0,
                "post-resume evict sweep empties slot residency"
            );
        }
        if let Resume::LazyAdversarialPrefetch = mode {
            // Touch every page and extent in reverse order — a fault
            // schedule no organic run produces. Residency order must
            // be observably irrelevant.
            let manifest = store.borrow().manifest().unwrap();
            for page in (0..slot_page_count(manifest.slot_count)).rev() {
                session.machine().slots.touch_page(page);
            }
            for ext in (0..chunk_extent_count(manifest.chunk_len)).rev() {
                session.machine().chunks.touch_extent(ext);
            }
        }
        let code = session
            .machine_mut()
            .relink_crank(bytecode, names)
            .expect("crank relinks");
        let o = session.machine_mut().run(&code);
        results.push(crank_result(&o));
        computrons.push(o.computrons);
        checkpoint_to_store(&mut session, &sig(), &mut *store.borrow_mut()).expect("checkpoint");
        if let Resume::LazyAdversarialEvict = mode {
            // Evict AFTER the session's own checkpoint too: the rows
            // this commit rewrote are clean again — evictable — and
            // their re-faults must verify against the leaves the
            // commit refreshed (frozen attach-time leaves would
            // misdiagnose exactly this healthy re-fault as a corrupt
            // store). The final
            // `write_snapshot` below re-faults everything evicted
            // here.
            let manifest = store.borrow().manifest().unwrap();
            for page in 0..slot_page_count(manifest.slot_count) {
                evictions += session.machine().slots.evict_page(page) as u32;
            }
            for ext in 0..chunk_extent_count(manifest.chunk_len) {
                evictions += session.machine().chunks.evict_extent(ext) as u32;
            }
        }
    }
    if let Resume::LazyAdversarialEvict = mode {
        assert!(
            evictions > 0,
            "the adversarial-evict arm must actually evict"
        );
    }
    (
        results,
        computrons,
        session
            .machine()
            .write_snapshot(&sig())
            .expect("quiescent machine snapshots"),
    )
}

/// Variant 7: one surviving machine, checkpoint after every crank, one
/// lazy resume at the end. The resumed machine's blob must equal the
/// survivor's.
fn run_checkpoint_every_crank<S: HeapStore + 'static>(
    store: S,
    compiled: &[(Vec<u8>, Vec<ironhorse_vm::SymbolName>)],
) -> (Vec<CrankResult>, Vec<u64>, Vec<u8>) {
    let store = Rc::new(RefCell::new(store));
    let mut results = Vec::new();
    let mut computrons = Vec::new();

    let mut m = Interp::new();
    m.link_intrinsics(&compiled[0].1);
    let o = m.run(&compiled[0].0);
    results.push(crank_result(&o));
    computrons.push(o.computrons);
    let mut session: StoreSession = begin_store_session(m, &sig(), &mut *store.borrow_mut())
        .map_err(|(_, e)| e)
        .expect("begin session");

    for (bytecode, names) in compiled.iter().skip(1) {
        let code = session
            .machine_mut()
            .relink_crank(bytecode, names)
            .expect("crank relinks");
        let o = session.machine_mut().run(&code);
        results.push(crank_result(&o));
        computrons.push(o.computrons);
        checkpoint_to_store(&mut session, &sig(), &mut *store.borrow_mut()).expect("checkpoint");
    }
    drop(session);
    let resumed = resume_from_store_lazy(store.clone(), &sig()).expect("final lazy resume");
    (
        results,
        computrons,
        resumed
            .machine()
            .write_snapshot(&sig())
            .expect("quiescent machine snapshots"),
    )
}

fn metamorphic<S: HeapStore + 'static>(
    fresh: &mut dyn FnMut() -> S,
    scenario: &str,
    cranks: &[&str],
) {
    let compiled: Vec<(Vec<u8>, Vec<ironhorse_vm::SymbolName>)> =
        cranks.iter().map(|s| compile(s)).collect();
    let baseline = run_baseline(scenario, &compiled);

    let (r, c, b) = run_blob(&compiled);
    assert_agrees("blob", scenario, &baseline, &r, &c, &b);

    let (r, c, b) = run_store(fresh(), &compiled, Resume::Eager);
    assert_agrees("store-eager", scenario, &baseline, &r, &c, &b);

    let (r, c, b) = run_store(fresh(), &compiled, Resume::Lazy);
    assert_agrees("store-lazy", scenario, &baseline, &r, &c, &b);

    let (r, c, b) = run_store(fresh(), &compiled, Resume::LazyAdversarialPrefetch);
    assert_agrees("store-lazy-prefetch", scenario, &baseline, &r, &c, &b);

    let (r, c, b) = run_store(fresh(), &compiled, Resume::LazyAdversarialEvict);
    assert_agrees("store-lazy-evict", scenario, &baseline, &r, &c, &b);

    let (r, c, b) = run_checkpoint_every_crank(fresh(), &compiled);
    assert_agrees("checkpoint-every-crank", scenario, &baseline, &r, &c, &b);
}

/// Compare uninterrupted, blob, eager-store, and lazy-store executions under
/// an arbitrary subset of the boundaries before cranks. Element zero must be
/// false (there is no predecessor to resume). Later cranks are relinked by name.
pub fn metamorphic_with_suspend_schedule<S: HeapStore + 'static>(
    mut fresh: impl FnMut() -> S,
    scenario: &str,
    cranks: &[&str],
    suspend_before: &[bool],
) {
    assert!(!cranks.is_empty());
    assert_eq!(suspend_before.len(), cranks.len());
    assert!(!suspend_before[0]);
    let compiled: Vec<_> = cranks.iter().map(|source| compile(source)).collect();
    let baseline = run_baseline(scenario, &compiled);
    let (r, c, b) = run_blob_scheduled(&compiled, suspend_before);
    assert_agrees("scheduled-blob", scenario, &baseline, &r, &c, &b);
    for mode in [Resume::Eager, Resume::Lazy] {
        let (r, c, b) = run_store_scheduled(fresh(), &compiled, mode, suspend_before);
        assert_agrees("scheduled-store", scenario, &baseline, &r, &c, &b);
    }
}

fn suspend_subset_scenario<S: HeapStore + 'static>(fresh: &mut dyn FnMut() -> S) {
    let cranks = [
        "var n; var s; var f; n=1; s='seed'; f=function(){return n+s;}; f()",
        "var n; var s; var f; if(false) f.caller; n=n+1; s=s+'x'; f()",
        "var n; var s; var f; if(false) f.caller; n=n+2; f()",
        "var n; var s; var f; if(false) f.caller; s=s+'y'; f()",
        "var n; var s; var f; if(false) f.caller; f()",
    ];
    for mask in 0..1u32 << (cranks.len() - 1) {
        let schedule: Vec<_> = (0..cranks.len())
            .map(|i| i > 0 && mask & (1 << (i - 1)) != 0)
            .collect();
        metamorphic_with_suspend_schedule(&mut *fresh, "all-suspend-subsets", &cranks, &schedule);
    }
}

fn halting_crank_scenario<S: HeapStore + 'static>(fresh: &mut dyn FnMut() -> S) {
    for resume_before in [false, true] {
        let (setup, names) = compile("var n=1; n");
        let mut baseline = Interp::new();
        baseline.link_intrinsics(&names);
        assert!(baseline.run(&setup).completed);
        let stable = baseline.write_snapshot(&sig()).unwrap();
        let store = Rc::new(RefCell::new(fresh()));
        let worker = from_snapshot_bytes(&stable, &sig()).unwrap();
        let mut session = begin_store_session(worker, &sig(), &mut *store.borrow_mut())
            .map_err(|(_, error)| error)
            .unwrap();
        let manifest = store.borrow().manifest().unwrap();
        if resume_before {
            drop(session);
            session = resume_from_store_lazy(store.clone(), &sig()).unwrap();
        }
        let (abort, names) = compile("n=99; throw new Error('abort')");
        let b = baseline.relink_crank(&abort, &names).unwrap();
        let w = session.machine_mut().relink_crank(&abort, &names).unwrap();
        let expected = baseline.run(&b);
        let actual = session.machine_mut().run(&w);
        assert!(!actual.completed);
        assert_eq!(crank_result(&actual), crank_result(&expected));
        assert_eq!(actual.computrons, expected.computrons);
        assert!(session.machine().write_snapshot(&sig()).is_err());
        assert!(checkpoint_to_store(&mut session, &sig(), &mut *store.borrow_mut()).is_err());
        assert_eq!(store.borrow().manifest().unwrap(), manifest);
        assert_eq!(export_to_container(&*store.borrow()).unwrap(), stable);
        // Rewind both to the last durable boundary, then verify continuation.
        baseline = from_snapshot_bytes(&stable, &sig()).unwrap();
        drop(session);
        let mut session = resume_from_store_lazy(store.clone(), &sig()).unwrap();
        let (next, names) = compile("var n; n=n+1; n");
        let b = baseline.relink_crank(&next, &names).unwrap();
        let w = session.machine_mut().relink_crank(&next, &names).unwrap();
        let expected = baseline.run(&b);
        let actual = session.machine_mut().run(&w);
        assert_eq!(actual.result, "2");
        assert_eq!(crank_result(&actual), crank_result(&expected));
        assert_eq!(actual.computrons, expected.computrons);
        checkpoint_to_store(&mut session, &sig(), &mut *store.borrow_mut()).unwrap();
        assert_eq!(
            export_to_container(&*store.borrow()).unwrap(),
            baseline.write_snapshot(&sig()).unwrap()
        );
    }
}

/// The full seven-way metamorphic determinism suite against a
/// backend: five real-JS scenarios, each executed uninterrupted /
/// blob / store-eager / store-lazy / adversarial-prefetch /
/// adversarial-evict / checkpoint-every-crank, agreeing on per-crank
/// results, per-crank computrons, and final canonical blob bytes.
/// `fresh` must return an EMPTY store; it is called once per
/// store-backed variant.
///
/// A carry scenario with a repeated declaration preamble.
/// Every execution variant relinks later cranks independently, including when
/// symbol names are reordered, omitted, or introduced for the first time.
fn carry<S: HeapStore + 'static>(
    fresh: &mut dyn FnMut() -> S,
    scenario: &str,
    mentions: &str,
    cranks: &[&str],
) {
    let bodies: Vec<String> = cranks
        .iter()
        .map(|body| {
            format!(
                // Declarations WITHOUT initializers: `var x;` on an
                // existing global leaves it alone, so the same
                // preamble can open every crank of the scenario.
                "var b; var box; var buf; var c; var d; var dv; \
                 var f; var g; var i; var it; var m; var mi; \
                 var n; var nf; var o; var p; var re; var s; \
                 var t; var ta; var C; \
                 if (0) {{ (function (a, k, v) {{ return a + k + v; }}); {mentions} }} {body}"
            )
        })
        .collect();
    let cranks: Vec<&str> = bodies.iter().map(String::as_str).collect();
    metamorphic(fresh, scenario, &cranks);
}

pub fn metamorphic_suite<S: HeapStore + 'static>(mut fresh: impl FnMut() -> S) {
    // Deliberately disjoint and reordered symbols; no mention-block anchor.
    for seed in 0..8 {
        let setup = format!("var retained = {{value: {seed}}}; var next = function(n) {{ retained.value += n; return retained.value; }}; 0");
        let mutate = format!("var fresh{seed} = next(2); fresh{seed}");
        metamorphic(
            &mut fresh,
            "changing-symbols",
            &[
                &setup,
                &mutate,
                "retained.value + next(3)",
                "var later = retained; later.value",
                "next(1)",
            ],
        );
    }
    suspend_subset_scenario(&mut fresh);
    halting_crank_scenario(&mut fresh);
    metamorphic(
        &mut fresh,
        "globals",
        &["var x = 5;", "x = x + 1;", "x + 10"],
    );
    metamorphic(
        &mut fresh,
        "strings",
        &["var s = 'seed';", "s = s + '-grow';", "s = s + s;", "s"],
    );
    metamorphic(
        &mut fresh,
        "objects",
        &[
            "var o = { a: 1, b: 2 };",
            "o.a = o.a + o.b;",
            "o.b = o.a * 10;",
            "o.a + o.b",
        ],
    );
    metamorphic(
        &mut fresh,
        "free-list",
        &[
            "var o = { a: 1, b: 2, c: 3, d: 0 };",
            "o.a; o.c; o.d; delete o.b;",
            "o.a; o.b; o.c; o.d = 4;",
            "o.b; o.a + o.c + o.d",
        ],
    );
    // The GRADUATED side-table carries. Until these landed the suite
    // proved determinism only over globals, strings, plain objects and
    // the free list -- every scenario's machine held an EMPTY side
    // table, so no carry was ever exercised across the residency
    // schedules, and a carry that decoded differently under a lazy
    // fault, or metered differently after a mid-scenario checkpoint,
    // would have agreed with itself in every twin and still diverged
    // here. Each scenario suspends across a crank boundary with the
    // family's state live, then OBSERVES it, so results, per-crank
    // computrons and final canonical bytes all have to agree seven
    // ways.
    carry(
        &mut fresh,
        "language-rows",
        "re.exec('').index; re.lastIndex; box.valueOf(); d.getTime(); \
         new Number(0); new Date(0);",
        &[
            "re = /a(b+)c/g; box = new Number(41); d = new Date(86400000); re.lastIndex",
            "t = re.exec('xabbc').index; re.lastIndex",
            "t = re.lastIndex + box.valueOf() + d.getTime(); t",
        ],
    );
    carry(
        &mut fresh,
        "callables",
        // No `f.call(o, 1)` here: a cross-crank `.call` on a guest
        // function is a defect this branch tracks separately (it
        // throws in the UNINTERRUPTED baseline too), and a determinism
        // scenario must not be the place it is discovered.
        "f.bind(o, 0); o.k;",
        &[
            "f = function (a) { return a + this.k; }; o = { k: 10 }; b = f.bind(o, 5); o.k",
            "t = b(); o.k = 20; t",
            "t = b() + o.k; t",
        ],
    );
    carry(
        &mut fresh,
        "accessors-and-private",
        // The dead class is what interns the PRIVATE name `#n`, which
        // only a class body can spell.
        "i.n; new C(); \
         (class { #n = 0; get n() { return this.#n; } set n(v) { this.#n = v; } });",
        &[
            "C = class { #n = 3; get n() { return this.#n; } set n(v) { this.#n = v; } }; \
             i = new C(); i.n",
            "t = i.n; i.n = i.n + 4; t",
            "t = i.n; t",
        ],
    );
    carry(
        &mut fresh,
        "generators-and-iterators",
        "it.next().value; it.next().done; new Map(); m.set('a', 0); m.entries(); \
         mi.next().value[0];",
        &[
            "g = function* () { var a = 1; yield a; yield a + 1; yield a + 2; }; \
             it = g(); m = new Map(); m.set('a', 1); m.set('b', 2); mi = m.entries(); \
             t = it.next().value; t",
            "t = it.next().value + mi.next().value[1]; t",
            "t = it.next().value + mi.next().value[1] + (it.next().done ? 100 : 0); t",
        ],
    );
    carry(
        &mut fresh,
        "promises",
        // The schema-23 cluster live across every crank boundary: a
        // pending promise with a stored resolver and a user reaction, a
        // mid-flight `Promise.all`, and a settled promise observed
        // late. Settlements land in different cranks so the reaction
        // rows, the guard, and the combinator's remaining count all
        // travel mid-flight through every residency schedule.
        "new Promise(function (rs, rj) { rs(rj); }); Promise.resolve(0); \
         Promise.all([p]); p.then(null, null);",
        &[
            "p = new Promise(function (rs, rj) { f = rs; }); \
             p.then(function (v) { g = v + 1; }); \
             Promise.all([p, new Promise(function (rs, rj) { d = rs; })]) \
               .then(function (v) { b = v[0] + '+' + v[1]; }); \
             o = 0; Promise.resolve(5).then(function (v) { o = v; }); o",
            "f(41); t = '' + o; t",
            "d(8); t = g; t",
            "t = g + ':' + o + ':' + b; t",
        ],
    );
    carry(
        &mut fresh,
        "intl-and-proxy",
        "nf.format(0); c.compare('a', 'a'); p.v; new Proxy({ v: 0 }, { get: null }); \
         new Intl.NumberFormat('en', { style: 'percent' }); new Intl.Collator('en');",
        &[
            "nf = new Intl.NumberFormat('en', { style: 'percent' }); \
             c = new Intl.Collator('en'); \
             p = new Proxy({ v: 1 }, { get: function (o, k) { return o[k] * 3; } }); p.v",
            "t = nf.format(0.5) + ':' + c.compare('a', 'b'); t",
            "t = t + ':' + p.v + ':' + nf.format(0.25); t",
        ],
    );
    carry(
        &mut fresh,
        "typed-arrays-and-disposal",
        "new ArrayBuffer(1); new Uint16Array(buf, 0, 1); new DataView(buf, 0, 1); \
         new DisposableStack(); s.defer(null); s.dispose(); dv.getUint8(0);",
        &[
            "buf = new ArrayBuffer(16); ta = new Uint16Array(buf, 2, 4); \
             dv = new DataView(buf, 0, 8); ta[0] = 513; n = 0; \
             s = new DisposableStack(); s.defer(function () { n = 9; }); ta[0]",
            "t = ta[0] + dv.getUint8(2); ta[1] = ta[0] + 1; t",
            "s.dispose(); t = t + ta[1] + n; t",
        ],
    );
    // A heap spanning several pages and extents, so lazy runs genuinely
    // fault multiple rows mid-crank and the adversarial prefetch
    // touches a nontrivial space.
    metamorphic(
        &mut fresh,
        "wide-heap",
        &[
            "var last = { v: 0 }; var s = 'x'; var i = 0; \
             for (i = 0; i < 900; i = i + 1) { last = { v: i }; } \
             for (i = 0; i < 11; i = i + 1) { s = s + s; }",
            "var i; last.v; s = s + 'tail';",
            "var i; var s; last.v + 1",
        ],
    );
    // The uncoercible-completion class:
    // a crank whose completion value the oracle harness's
    // `String(result)` cannot coerce. The engine reports it COMPLETED
    // with its own rendering and the harness's `TypeError` beside it
    // (`coercion_error`); the boundary registers clear, the machine
    // persists, and every way must agree on the verdict, the
    // computrons, and the bytes. Before the register-clear fix the
    // twins agreed here and forked at their next collection
    // (`boundary_collection_twins` is the instrument for that half),
    // and before the raw-completion surface the engine rewrote the
    // halt itself, so the suite's every-crank-completes assertion
    // could not even run this scenario.
    carry(
        &mut fresh,
        "uncoercible-completion",
        "Symbol('k'); Object.create(null); o.p;",
        &[
            "o = { p: 20 }; s = Symbol('k'); s",
            "t = Object.create(null); t",
            "t = o.p + 22; t",
        ],
    );
}

/// The continuous-versus-resumed IMAGE comparison after a boundary
/// collection, against a backend. The seven-way runner compares results, computrons and
/// final bytes, and is blind to a machine whose boundary registers
/// stayed rooted: two such twins answer every crank identically while
/// their free lists, live counts and canonical bytes diverge at the
/// first collection — a durable-heap fork with no observable in the
/// runner. So: for each scenario, run crank 1 uninterrupted and on a
/// machine that slept in the store; collect BOTH at the boundary; run
/// the same crank 2; and require live counts, verdicts, computrons and
/// canonical bytes to agree.
pub fn boundary_collection_twins<S: HeapStore + 'static>(mut fresh: impl FnMut() -> S) {
    // Crank 1's bindings are LEXICAL: a top-level `let` lives in the
    // frame's `locals` register, not on the global object, so `a` and
    // the completion value are rooted by nothing but the boundary
    // registers — the roots the restore path never reinstates, and the
    // reason a `var` fixture cannot see this class (`g` is the one
    // global the observation reads).
    let pre = "var g; var t; \
               if (0) { let a = 0; let b = 0; let s = 0; a.p; b.q; g.q; \
                        Symbol('k'); Object.create(null); } ";
    let observe = format!("{pre} t = g.q * 21; t");
    for (name, completion) in [
        ("a rendered completion", "let s = 7; s"),
        // The two uncoercible completions: the engine completed, the
        // oracle harness's `String(result)` could not coerce the value.
        ("a Symbol completion", "let s = Symbol('k'); s"),
        (
            "a null-prototype completion",
            "let s = Object.create(null); s",
        ),
    ] {
        let (b1, n1) = compile(&format!(
            "{pre} let a = {{ p: 1 }}; let b = {{ q: 2 }}; g = b; {completion}"
        ));
        let (b2, n2) = compile(&observe);
        assert_eq!(n1, n2, "{name}: both cranks intern the same symbols");

        let mut cont = Interp::new();
        cont.link_intrinsics(&n1);
        let o1 = cont.run(&b1);
        assert!(
            cont.is_quiescent(),
            "{name}: crank 1 leaves a boundary ({:?})",
            o1.halt
        );

        let store = Rc::new(RefCell::new(fresh()));
        let mut sleeper = Interp::new();
        sleeper.link_intrinsics(&n1);
        let s1 = sleeper.run(&b1);
        assert_eq!(crank_result(&s1), crank_result(&o1), "{name}: crank 1");
        drop(
            begin_store_session(sleeper, &sig(), &mut *store.borrow_mut())
                .map_err(|(_, e)| e)
                .unwrap_or_else(|e| panic!("{name}: begin: {e:?}")),
        );
        let mut resumed = resume_from_store(&*store.borrow(), &sig())
            .unwrap_or_else(|e| panic!("{name}: resume: {e:?}"));
        let twin = resumed.machine_mut();

        let cont_gc = cont.collect_garbage().unwrap();
        let twin_gc = twin.collect_garbage().unwrap();
        assert_eq!(
            cont_gc.slots_live, twin_gc.slots_live,
            "{name}: the boundary must root the same live set on both twins"
        );
        let co = cont.run(&b2);
        let to = twin.run(&b2);
        assert_eq!(
            (co.completed, co.result.as_str()),
            (true, "42"),
            "{name}: continuous crank 2 ({:?})",
            co.halt
        );
        assert_eq!(
            (to.completed, to.result.as_str()),
            (true, "42"),
            "{name}: resumed crank 2 ({:?})",
            to.halt
        );
        assert_eq!(co.computrons, to.computrons, "{name}: computrons agree");
        assert_eq!(
            cont.write_snapshot(&sig()).expect("continuous snapshots"),
            twin.write_snapshot(&sig()).expect("resumed snapshots"),
            "{name}: continuous and resumed canonical bytes agree after a boundary collection"
        );
    }
}

/// The lazy wake really is lazy against this backend: after a lazy
/// resume of a wide store, a crank touching only one global leaves
/// most slot pages non-resident (grow-only residency means those rows
/// were never read). A quarter of the pages is a generous ceiling for
/// this fixture's one-global working set.
pub fn lazy_working_set_bound<S: HeapStore + 'static>(fresh: impl FnOnce() -> S) {
    let cranks = [
        "var last = { v: 0 }; var t = 0; var i = 0; \
         for (i = 0; i < 3000; i = i + 1) { last = { v: i }; } t = 7;",
        "var last; var i; t + 1",
    ];
    let compiled: Vec<(Vec<u8>, Vec<ironhorse_vm::SymbolName>)> =
        cranks.iter().map(|s| compile(s)).collect();

    let store = Rc::new(RefCell::new(fresh()));
    let mut m = Interp::new();
    m.link_intrinsics(&compiled[0].1);
    assert!(m.run(&compiled[0].0).completed);
    drop(
        begin_store_session(m, &sig(), &mut *store.borrow_mut())
            .map_err(|(_, e)| e)
            .unwrap(),
    );
    let total_pages = slot_page_count(store.borrow().manifest().unwrap().slot_count);
    assert!(total_pages > 12, "fixture must be genuinely wide");

    let mut s2 = resume_from_store_lazy(store.clone(), &sig()).unwrap();
    let o = s2.machine_mut().run(&compiled[1].0);
    assert!(o.completed);
    assert_eq!(o.result, "8");
    let resident = s2.machine().slots.resident_page_count();
    assert!(
        resident * 4 <= total_pages,
        "working-set crank faulted {resident} of {total_pages} pages"
    );
    assert!(!s2.machine().slots.is_fully_resident());
}

/// The central checkpoint invariant against an EMPTY backend: after
/// every checkpoint — full or incremental — the store equals the bound
/// machine's snapshot image, its export byte-equals the machine's own
/// blob, and its root hash is the blob's CAS key.
pub fn checkpoint_acceptance(store: &mut dyn HeapStore) {
    let progs = real_progs();
    let mut m = Interp::new();
    m.link_intrinsics(&progs[0].1);
    assert!(m.run(&progs[0].0).completed);
    let mut session = begin_store_session(m, &sig(), store)
        .map_err(|(_, e)| panic!("begin: {e:?}"))
        .unwrap();
    assert_eq!(session.epoch(), 1);
    assert_eq!(
        store_to_image(store).unwrap(),
        session
            .machine()
            .snapshot_image_for_testing(&sig())
            .expect("gated image")
    );
    assert_eq!(
        export_to_container(store).unwrap(),
        session
            .machine()
            .write_snapshot(&sig())
            .expect("quiescent machine snapshots"),
        "store export byte-equals the machine's own blob"
    );

    assert!(session.machine_mut().run(&progs[1].0).completed);
    let epoch = checkpoint_to_store(&mut session, &sig(), store).expect("incremental");
    assert_eq!(epoch, 2);
    assert_eq!(
        store_to_image(store).unwrap(),
        session
            .machine()
            .snapshot_image_for_testing(&sig())
            .expect("gated image")
    );
    assert_eq!(
        export_to_container(store).unwrap(),
        session
            .machine()
            .write_snapshot(&sig())
            .expect("quiescent machine snapshots")
    );
    assert_eq!(
        root_hash(store).unwrap(),
        hex_sha256(
            &session
                .machine()
                .write_snapshot(&sig())
                .expect("quiescent machine snapshots")
        )
    );
    assert_edges_match_content(store);
}

/// The phase-6 purity lock: the STORED page-edge summaries must equal
/// the summaries recomputed from the store's own content — a pure
/// function of the rows, never of the schedule that produced them.
fn assert_edges_match_content(store: &dyn HeapStore) {
    let image = store_to_image(store).unwrap();
    let stored = store.page_edges().unwrap();
    let n_pages = slot_page_count(image.slots.len() as u32) as usize;
    assert_eq!(stored.len(), n_pages, "one summary per page");
    for (page, stored_targets) in stored.iter().enumerate() {
        let start = page * SLOTS_PER_PAGE as usize;
        let end = image.slots.len().min(start + SLOTS_PER_PAGE as usize);
        let expected = derive_page_edges(page as u32, &image.slots[start..end]);
        assert_eq!(
            stored_targets, &expected,
            "page {page} summary equals content-derived summary"
        );
    }
}

/// The row-6 bar through an EMPTY backend: a machine that slept in the
/// store and woke continues a following crank with the same result AND
/// computron count as one that never suspended.
pub fn resume_equals_uninterrupted(store: &mut dyn HeapStore) {
    let progs = real_progs();
    let mut uninterrupted = Interp::new();
    uninterrupted.link_intrinsics(&progs[0].1);
    assert!(uninterrupted.run(&progs[0].0).completed);
    let ub = uninterrupted.run(&progs[1].0);
    assert!(ub.completed);

    let mut m1 = Interp::new();
    m1.link_intrinsics(&progs[0].1);
    assert!(m1.run(&progs[0].0).completed);
    let s1 = begin_store_session(m1, &sig(), store)
        .map_err(|(_, e)| panic!("begin: {e:?}"))
        .unwrap();
    let epoch = s1.epoch();
    drop(s1); // the suspended worker's machine is gone

    let mut s2 = resume_from_store(store, &sig()).expect("resumes");
    assert_eq!(s2.epoch(), epoch);
    let b2 = s2.machine_mut().run(&progs[1].0);
    assert_eq!(b2.result, ub.result);
    assert_eq!(b2.computrons, ub.computrons, "meter continued");
}

/// Two real-JS cranks with one shared anchored symbol set, compiled
/// fresh (the checkpoint/resume acceptance fixtures).
fn real_progs() -> Vec<(Vec<u8>, Vec<ironhorse_vm::SymbolName>)> {
    [
        "var a = { n: 1 }; var s = 'seed'; a.n + 1",
        "var a; s = s + '-more'; a.n = a.n + 2; a.n",
    ]
    .iter()
    .map(|s| compile(s))
    .collect()
}

/// Shared backend commit contract, including actual close/reopen durability.
/// Supply identity for an in-memory backend; durable backends must close the
/// owned handle and return a newly opened handle on the same medium.
/// Every refusal must preserve both the manifest and complete logical content.
pub fn commit_contract<S: HeapStore>(mut store: S, mut reopen: impl FnMut(S) -> S) -> S {
    use crate::store::{image_to_batch, reseal_batch};
    let mut machine = Interp::new();
    let proof = machine.snapshot_image(&sig()).unwrap();
    let genesis = image_to_batch(&proof, 1, "");
    store.commit(&genesis).expect("genesis commits");
    store = reopen(store);
    assert_eq!(store.manifest().unwrap(), genesis.manifest);
    let before = export_to_container(&store).unwrap();
    assert_eq!(before, crate::image::write_machine(&proof).unwrap());

    // Grow through a page boundary so the missing-row case is mandatory,
    // even when the backend would otherwise retain every old row.
    for _ in 0..SLOTS_PER_PAGE {
        machine.slots.alloc(ironhorse_vm::Slot::undefined());
    }
    let grown = machine.snapshot_image(&sig()).unwrap();
    let successor = image_to_batch(&grown, 2, &genesis.manifest.seal);
    let mut wrong_parent = successor.clone();
    wrong_parent.prev_seal.push('0');
    wrong_parent.manifest.parent_seal = wrong_parent.prev_seal.clone();
    reseal_batch(&mut wrong_parent);
    let mut missing = successor.clone();
    missing.slot_pages.pop();
    missing.page_edges.pop();
    reseal_batch(&mut missing);
    let mut corrupt = successor.clone();
    *corrupt.chunk_extents[0].1.last_mut().unwrap() ^= 1;
    for bad in [genesis.clone(), wrong_parent, missing, corrupt] {
        assert!(store.commit(&bad).is_err(), "invalid commit must refuse");
        store = reopen(store);
        assert_eq!(store.manifest().unwrap(), genesis.manifest);
        assert_eq!(export_to_container(&store).unwrap(), before);
    }
    store
        .commit(&successor)
        .expect("valid successor after refusals");
    store = reopen(store);
    assert_eq!(store.manifest().unwrap(), successor.manifest);
    assert_eq!(
        export_to_container(&store).unwrap(),
        crate::image::write_machine(&grown).unwrap()
    );
    store
}

/// Sparse section protocol locks, shared by all three storage backends.
pub fn sparse_section_acceptance<S: HeapStore>(mut fresh: impl FnMut() -> S) {
    use crate::store::{image_to_batch, reseal_batch, RootLedger};
    use crate::store_sections::{batch_updates, SectionLeaves, SectionUpdate, SmallSection};
    let image_of = |source: &str| {
        let mut machine = Interp::new();
        let (code, names) = compile(source);
        machine.link_intrinsics(&names);
        assert!(machine.run(&code).completed);
        machine.snapshot_image(&sig()).unwrap()
    };
    // The initial sparse NAME update must accept canonical CESU-8, including
    // lone surrogates and supplementary characters, without replacement.
    let populated =
        image_of(r#"var a = [1, 2, 3]; var o = {"\uD800":7,"\uDC00":8,"\uD800\uDC00":9}; 0"#);
    let empty = image_of("0");
    assert!(!populated.arrays.is_empty());
    assert!(empty.arrays.is_empty());
    let first = image_to_batch(&populated, 1, "");
    let mut initial = first.clone();
    initial.small_updates = Some(batch_updates(&initial).unwrap());
    initial.small.clear();
    reseal_batch(&mut initial);
    assert_eq!(
        initial.manifest.seal, first.manifest.seal,
        "the manifest seal binds the same complete state"
    );
    let mut reverse = initial.clone();
    reverse.small_updates.as_mut().unwrap().reverse();
    reseal_batch(&mut reverse);
    assert_eq!(
        reverse.manifest.seal, initial.manifest.seal,
        "canonical update order"
    );
    let mut store = fresh();
    let mut missing = initial.clone();
    missing.small_updates.as_mut().unwrap().pop();
    reseal_batch(&mut missing);
    assert!(store.commit(&missing).is_err());
    assert!(matches!(
        store.manifest(),
        Err(crate::store::StoreError::Empty)
    ));
    store.commit(&reverse).unwrap();
    assert_eq!(&store_to_image(&store).unwrap(), populated.image());

    // Full -> unchanged sparse -> explicit empty table -> full again.
    let mut store = fresh();
    store.commit(&first).unwrap();
    let mut unchanged = image_to_batch(&populated, 2, &first.manifest.seal);
    unchanged.small.clear();
    unchanged.small_updates = Some(Vec::new());
    unchanged.slot_pages.clear();
    unchanged.chunk_extents.clear();
    unchanged.free_segs.clear();
    unchanged.page_edges.clear();
    reseal_batch(&mut unchanged);
    store.commit(&unchanged).unwrap();
    assert_eq!(&store_to_image(&store).unwrap(), populated.image());
    let prior = store.manifest().unwrap();
    let next = image_to_batch(&populated, 3, &prior.seal);
    let meter = batch_updates(&next)
        .unwrap()
        .into_iter()
        .find(|u| u.section == SmallSection::Meter)
        .unwrap();
    let mut duplicate = next.clone();
    duplicate.small.clear();
    duplicate.small_updates = Some(vec![meter.clone(), meter]);
    let mut conflict = next.clone();
    conflict.small_updates = Some(Vec::new());
    let mut malformed = next.clone();
    malformed.small.clear();
    malformed.small_updates = Some(vec![SectionUpdate {
        section: SmallSection::NameFloor,
        bytes: vec![0; 3],
    }]);
    let mut noncanonical = next.clone();
    noncanonical.small.clear();
    noncanonical.small_updates = Some(vec![SectionUpdate {
        section: SmallSection::Arrays,
        bytes: Vec::new(), // Empty arrays require the canonical count header.
    }]);
    for mut bad in [duplicate, conflict, malformed, noncanonical] {
        reseal_batch(&mut bad);
        assert!(store.commit(&bad).is_err());
        assert_eq!(store.manifest().unwrap(), prior);
        assert_eq!(&store_to_image(&store).unwrap(), populated.image());
    }
    let mut clear = image_to_batch(&empty, 3, &prior.seal);
    let updates = batch_updates(&clear).unwrap();
    clear.small.clear();
    clear.small_updates = Some(updates);
    let (pages, exts) = store.leaf_hashes().unwrap();
    let mut ledger = RootLedger::build_from_sections(
        SectionLeaves::from_hashes(store.small_section_hashes().unwrap()),
        pages,
        exts,
        store.free_leaf_hashes().unwrap(),
        &store.page_edges().unwrap(),
    );
    assert_eq!(ledger.root(&prior), prior.root);
    clear.manifest.root = ledger.apply_checkpoint(&clear).unwrap();
    reseal_batch(&mut clear);
    store.commit(&clear).unwrap();
    assert_eq!(&store_to_image(&store).unwrap(), empty.image());
    let restored = resume_from_store(&store, &sig()).unwrap();
    assert_eq!(restored.machine().snapshot_image(&sig()).unwrap(), empty);
    let full = image_to_batch(&populated, 4, &clear.manifest.seal);
    store.commit(&full).unwrap();
    assert_eq!(&store_to_image(&store).unwrap(), populated.image());
}
