//! The **backend-parameterized store acceptance suite** (store seam
//! design, decision 8): the metamorphic determinism runner (seven execution ways),
//! the lazy working-set bound, and the checkpoint acceptance locks,
//! generic over the [`HeapStore`] under test so every backend —
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

use std::cell::RefCell;
use std::rc::Rc;

use crate::machine::{
    begin_store_session, checkpoint_to_store, from_snapshot_bytes, resume_from_store,
    resume_from_store_lazy, MachineSnapshot, StoreSession,
};
use crate::store::{
    chunk_extent_count, derive_page_edges, export_to_container, root_hash, slot_page_count,
    store_to_image, HeapStore, SLOTS_PER_PAGE,
};
use crate::sha256::hex_sha256;
use crate::Signature;
use ironhorse_vm::{parse_symbols, Interp};

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

fn compile(source: &str) -> (Vec<u8>, Vec<String>) {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("fixture compiles");
    (bytecode, parse_symbols(&symbols))
}

struct Baseline {
    results: Vec<String>,
    /// Cumulative computrons AFTER EVERY CRANK, not just the last: a
    /// mid-run meter divergence that reconverges by the final crank
    /// must still fail (the collaborator review's finding).
    computrons: Vec<u64>,
    final_blob: Vec<u8>,
}

fn run_baseline(scenario: &str, compiled: &[(Vec<u8>, Vec<String>)]) -> Baseline {
    let mut m = Interp::new();
    m.link_intrinsics(&compiled[0].1);
    let mut results = Vec::new();
    let mut computrons = Vec::new();
    for (i, (bytecode, _)) in compiled.iter().enumerate() {
        let o = m.run(bytecode);
        assert!(
            o.completed,
            "{scenario} baseline crank {} completes (halt: {:?})",
            i + 1,
            o.halt
        );
        results.push(o.result);
        computrons.push(o.computrons);
    }
    Baseline {
        results,
        computrons,
        final_blob: m.write_snapshot(&sig()).expect("quiescent machine snapshots"),
    }
}

fn assert_agrees(
    variant: &str,
    scenario: &str,
    baseline: &Baseline,
    results: &[String],
    computrons: &[u64],
    final_blob: &[u8],
) {
    assert_eq!(
        results, &baseline.results[..],
        "[{scenario}/{variant}] per-crank results agree"
    );
    assert_eq!(
        computrons, &baseline.computrons[..],
        "[{scenario}/{variant}] per-crank computron vector agrees"
    );
    assert_eq!(
        final_blob, &baseline.final_blob[..],
        "[{scenario}/{variant}] final canonical blob agrees byte-for-byte"
    );
}

/// Variant 2: blob suspend/resume between every crank.
fn run_blob(compiled: &[(Vec<u8>, Vec<String>)]) -> (Vec<String>, Vec<u64>, Vec<u8>) {
    let mut m = Interp::new();
    m.link_intrinsics(&compiled[0].1);
    let mut results = Vec::new();
    let mut computrons = Vec::new();
    for (i, (bytecode, _)) in compiled.iter().enumerate() {
        if i > 0 {
            let bytes = m.write_snapshot(&sig()).expect("quiescent machine snapshots");
            m = from_snapshot_bytes(&bytes, &sig()).expect("blob resumes");
        }
        let o = m.run(bytecode);
        results.push(o.result);
        computrons.push(o.computrons);
    }
    (results, computrons, m.write_snapshot(&sig()).expect("quiescent machine snapshots"))
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
    /// (store seam phase 8, the Decision-3 amendment), including the
    /// commit-then-evict-then-refault ordering the phase-8 review
    /// found unexercised (stale attach-time leaves). The arm asserts
    /// eviction genuinely happened, so a future guard change cannot
    /// silently degrade it into a prefetch duplicate.
    LazyAdversarialEvict,
}

/// Variants 3-6: store-backed sleep/wake between every crank, with the
/// chosen resume mode, against a fresh backend from the caller.
fn run_store<S: HeapStore + 'static>(
    store: S,
    compiled: &[(Vec<u8>, Vec<String>)],
    mode: Resume,
) -> (Vec<String>, Vec<u64>, Vec<u8>) {
    let store = Rc::new(RefCell::new(store));
    let mut results = Vec::new();
    let mut computrons = Vec::new();

    // Crank 1 on a fresh machine, then bind.
    let mut m = Interp::new();
    m.link_intrinsics(&compiled[0].1);
    let o = m.run(&compiled[0].0);
    results.push(o.result);
    computrons.push(o.computrons);
    let mut session = begin_store_session(m, &sig(), &mut *store.borrow_mut())
        .map_err(|(_, e)| e)
        .expect("begin session");

    let mut evictions = 0u32;
    for (bytecode, _) in compiled.iter().skip(1) {
        drop(session);
        session = match mode {
            Resume::Eager => resume_from_store(&*store.borrow(), &sig()).expect("resumes"),
            Resume::Lazy | Resume::LazyAdversarialPrefetch | Resume::LazyAdversarialEvict => {
                resume_from_store_lazy(store.clone(), &sig()).expect("resumes lazily")
            }
        };
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
        let o = session.machine_mut().run(bytecode);
        results.push(o.result);
        computrons.push(o.computrons);
        checkpoint_to_store(&mut session, &sig(), &mut *store.borrow_mut()).expect("checkpoint");
        if let Resume::LazyAdversarialEvict = mode {
            // Evict AFTER the session's own checkpoint too: the rows
            // this commit rewrote are clean again — evictable — and
            // their re-faults must verify against the leaves the
            // commit refreshed (frozen attach-time leaves would
            // misdiagnose exactly this healthy re-fault as a corrupt
            // store — the phase-8 review finding). The final
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
    (results, computrons, session.machine().write_snapshot(&sig()).expect("quiescent machine snapshots"))
}

/// Variant 7: one surviving machine, checkpoint after every crank, one
/// lazy resume at the end. The resumed machine's blob must equal the
/// survivor's.
fn run_checkpoint_every_crank<S: HeapStore + 'static>(
    store: S,
    compiled: &[(Vec<u8>, Vec<String>)],
) -> (Vec<String>, Vec<u64>, Vec<u8>) {
    let store = Rc::new(RefCell::new(store));
    let mut results = Vec::new();
    let mut computrons = Vec::new();

    let mut m = Interp::new();
    m.link_intrinsics(&compiled[0].1);
    let o = m.run(&compiled[0].0);
    results.push(o.result);
    computrons.push(o.computrons);
    let mut session: StoreSession = begin_store_session(m, &sig(), &mut *store.borrow_mut())
        .map_err(|(_, e)| e)
        .expect("begin session");

    for (bytecode, _) in compiled.iter().skip(1) {
        let o = session.machine_mut().run(bytecode);
        results.push(o.result);
        computrons.push(o.computrons);
        checkpoint_to_store(&mut session, &sig(), &mut *store.borrow_mut()).expect("checkpoint");
    }
    drop(session);
    let resumed = resume_from_store_lazy(store.clone(), &sig()).expect("final lazy resume");
    (results, computrons, resumed.machine().write_snapshot(&sig()).expect("quiescent machine snapshots"))
}

fn metamorphic<S: HeapStore + 'static>(
    fresh: &mut dyn FnMut() -> S,
    scenario: &str,
    cranks: &[&str],
) {
    let compiled: Vec<(Vec<u8>, Vec<String>)> = cranks.iter().map(|s| compile(s)).collect();
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

/// The full seven-way metamorphic determinism suite against a
/// backend: five real-JS scenarios, each executed uninterrupted /
/// blob / store-eager / store-lazy / adversarial-prefetch /
/// adversarial-evict / checkpoint-every-crank, agreeing on per-crank
/// results, per-crank computrons, and final canonical blob bytes.
/// `fresh` must return an EMPTY store; it is called once per
/// store-backed variant.
///
/// Fixtures follow the anchored equal-symbol-set discipline (every
/// crank of a scenario uses the same program-symbol set).
/// A carry scenario. Every crank of a scenario must reference the same
/// program-symbol SET (the suite's anchored discipline: the baseline
/// links intrinsics once, from crank 1's names, and runs the rest
/// unrelinked, so a name first seen in crank 2 resolves to nothing).
/// Setup and observation naturally use different members, so each
/// crank carries the same dead `if (0)` mention block ahead of its
/// own body -- compiling interns those names without executing
/// anything, and the block is identical in every variant, so it
/// cannot itself introduce a divergence.
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
    // Enforce the discipline rather than letting it surface as a
    // baffling `TypeError` three layers down: symbol ids are
    // POSITIONAL, so one name interned by only some cranks shifts
    // every id after it and the unrelinked baseline resolves garbage.
    let anchor = compile(cranks[0]).1;
    for (i, crank) in cranks.iter().enumerate().skip(1) {
        let names = compile(crank).1;
        assert_eq!(
            names, anchor,
            "{scenario} crank {} must intern exactly crank 1's program symbols, in order \
             (add the ones it is missing to the scenario's mention block)",
            i + 1
        );
    }
    metamorphic(fresh, scenario, &cranks);
}

pub fn metamorphic_suite<S: HeapStore + 'static>(mut fresh: impl FnMut() -> S) {
    metamorphic(&mut fresh, "globals", &["var x = 5;", "x = x + 1;", "x + 10"]);
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
    let compiled: Vec<(Vec<u8>, Vec<String>)> = cranks.iter().map(|s| compile(s)).collect();

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
        session.machine().snapshot_image(&sig())
    );
    assert_eq!(
        export_to_container(store).unwrap(),
        session.machine().write_snapshot(&sig()).expect("quiescent machine snapshots"),
        "store export byte-equals the machine's own blob"
    );

    assert!(session.machine_mut().run(&progs[1].0).completed);
    let epoch = checkpoint_to_store(&mut session, &sig(), store).expect("incremental");
    assert_eq!(epoch, 2);
    assert_eq!(
        store_to_image(store).unwrap(),
        session.machine().snapshot_image(&sig())
    );
    assert_eq!(
        export_to_container(store).unwrap(),
        session.machine().write_snapshot(&sig()).expect("quiescent machine snapshots")
    );
    assert_eq!(
        root_hash(store).unwrap(),
        hex_sha256(&session.machine().write_snapshot(&sig()).expect("quiescent machine snapshots"))
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
fn real_progs() -> Vec<(Vec<u8>, Vec<String>)> {
    ["var a = { n: 1 }; var s = 'seed'; a.n + 1", "var a; s = s + '-more'; a.n = a.n + 2; a.n"]
        .iter()
        .map(|s| compile(s))
        .collect()
}
