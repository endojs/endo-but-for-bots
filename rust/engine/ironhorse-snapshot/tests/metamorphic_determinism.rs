//! The **metamorphic determinism suite** (store seam design, phase 3
//! and design decision 8): one program corpus, executed six ways —
//!
//! 1. uninterrupted;
//! 2. blob suspend/resume between every crank;
//! 3. store-backed, **eager** resume between every crank;
//! 4. store-backed, **lazy** resume between every crank (pages and
//!    extents fault on demand mid-crank);
//! 5. store-backed lazy resume with an **adversarial prefetch**: every
//!    page and extent pre-touched in reverse order before the crank
//!    runs, exercising a fault schedule no real run would produce;
//! 6. one surviving machine checkpointing after every crank, resumed
//!    lazily once at the end.
//!
//! All six must agree on every crank's completion value, on the final
//! cumulative computron count, and on the final canonical blob bytes.
//! This is the enforcement instrument for the design's determinism
//! analysis — faults are content-identical cache fills and commits
//! happen only between cranks, so no residency schedule and no
//! checkpoint cadence may perturb an observable.
//!
//! Fixtures follow the anchored equal-symbol-set discipline the
//! engine-lifecycle suite established (every crank of a scenario uses
//! the same program-symbol set).

use std::cell::RefCell;
use std::rc::Rc;

use ironhorse_snapshot::machine::{
    begin_store_session, checkpoint_to_store, from_snapshot_bytes, resume_from_store,
    resume_from_store_lazy, MachineSnapshot,
};
use ironhorse_snapshot::store::{slot_page_count, chunk_extent_count, HeapStore, MemoryStore};
use ironhorse_snapshot::Signature;
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
    final_computrons: u64,
    final_blob: Vec<u8>,
}

fn run_baseline(compiled: &[(Vec<u8>, Vec<String>)]) -> Baseline {
    let mut m = Interp::new();
    m.link_intrinsics(&compiled[0].1);
    let mut results = Vec::new();
    let mut final_computrons = 0;
    for (bytecode, _) in compiled {
        let o = m.run(bytecode);
        assert!(o.completed, "baseline crank completes (halt: {:?})", o.halt);
        results.push(o.result);
        final_computrons = o.computrons;
    }
    Baseline {
        results,
        final_computrons,
        final_blob: m.write_snapshot(&sig()),
    }
}

fn assert_agrees(
    variant: &str,
    scenario: &str,
    baseline: &Baseline,
    results: &[String],
    final_computrons: u64,
    final_blob: &[u8],
) {
    assert_eq!(
        results, &baseline.results[..],
        "[{scenario}/{variant}] per-crank results agree"
    );
    assert_eq!(
        final_computrons, baseline.final_computrons,
        "[{scenario}/{variant}] final computrons agree"
    );
    assert_eq!(
        final_blob, &baseline.final_blob[..],
        "[{scenario}/{variant}] final canonical blob agrees byte-for-byte"
    );
}

/// Variant 2: blob suspend/resume between every crank.
fn run_blob(compiled: &[(Vec<u8>, Vec<String>)]) -> (Vec<String>, u64, Vec<u8>) {
    let mut m = Interp::new();
    m.link_intrinsics(&compiled[0].1);
    let mut results = Vec::new();
    let mut computrons = 0;
    for (i, (bytecode, _)) in compiled.iter().enumerate() {
        if i > 0 {
            let bytes = m.write_snapshot(&sig());
            m = from_snapshot_bytes(&bytes, &sig()).expect("blob resumes");
        }
        let o = m.run(bytecode);
        results.push(o.result);
        computrons = o.computrons;
    }
    (results, computrons, m.write_snapshot(&sig()))
}

/// How a store-backed variant resumes between cranks.
enum Resume {
    Eager,
    Lazy,
    LazyAdversarialPrefetch,
}

/// Variants 3-5: store-backed sleep/wake between every crank, with the
/// chosen resume mode.
fn run_store(compiled: &[(Vec<u8>, Vec<String>)], mode: Resume) -> (Vec<String>, u64, Vec<u8>) {
    let store = Rc::new(RefCell::new(MemoryStore::new()));
    let mut m = Interp::new();
    m.link_intrinsics(&compiled[0].1);
    let mut results = Vec::new();
    let mut computrons = 0;
    let mut session = None;
    for (i, (bytecode, _)) in compiled.iter().enumerate() {
        if i > 0 {
            drop(m);
            let (m2, s2) = match mode {
                Resume::Eager => resume_from_store(&*store.borrow(), &sig()).expect("resumes"),
                Resume::Lazy | Resume::LazyAdversarialPrefetch => {
                    resume_from_store_lazy(store.clone(), &sig()).expect("resumes lazily")
                }
            };
            m = m2;
            if let Resume::LazyAdversarialPrefetch = mode {
                // Touch every page and extent in reverse order — a
                // fault schedule no organic run produces. Residency
                // order must be observably irrelevant.
                let manifest = store.borrow().manifest().unwrap();
                for page in (0..slot_page_count(manifest.slot_count)).rev() {
                    m.slots.touch_page(page);
                }
                for ext in (0..chunk_extent_count(manifest.chunk_len)).rev() {
                    m.chunks.touch_extent(ext);
                }
            }
            session = Some(s2);
        }
        let o = m.run(bytecode);
        results.push(o.result);
        computrons = o.computrons;
        match session.as_mut() {
            None => {
                session = Some(
                    begin_store_session(&mut m, &sig(), &mut *store.borrow_mut())
                        .expect("begin session"),
                );
            }
            Some(s) => {
                checkpoint_to_store(s, &mut m, &sig(), &mut *store.borrow_mut())
                    .expect("checkpoint");
            }
        }
    }
    (results, computrons, m.write_snapshot(&sig()))
}

/// Variant 6: one surviving machine, checkpoint after every crank, one
/// lazy resume at the end. The resumed machine's blob must equal the
/// survivor's.
fn run_checkpoint_every_crank(compiled: &[(Vec<u8>, Vec<String>)]) -> (Vec<String>, u64, Vec<u8>) {
    let store = Rc::new(RefCell::new(MemoryStore::new()));
    let mut m = Interp::new();
    m.link_intrinsics(&compiled[0].1);
    let mut results = Vec::new();
    let mut computrons = 0;
    let mut session = None;
    for (bytecode, _) in compiled {
        let o = m.run(bytecode);
        results.push(o.result);
        computrons = o.computrons;
        match session.as_mut() {
            None => {
                session = Some(
                    begin_store_session(&mut m, &sig(), &mut *store.borrow_mut())
                        .expect("begin session"),
                );
            }
            Some(s) => {
                checkpoint_to_store(s, &mut m, &sig(), &mut *store.borrow_mut())
                    .expect("checkpoint");
            }
        }
    }
    drop(m);
    let (resumed, _) = resume_from_store_lazy(store.clone(), &sig()).expect("final lazy resume");
    (results, computrons, resumed.write_snapshot(&sig()))
}

fn metamorphic(scenario: &str, cranks: &[&str]) {
    let compiled: Vec<(Vec<u8>, Vec<String>)> = cranks.iter().map(|s| compile(s)).collect();
    let baseline = run_baseline(&compiled);

    let (r, c, b) = run_blob(&compiled);
    assert_agrees("blob", scenario, &baseline, &r, c, &b);

    let (r, c, b) = run_store(&compiled, Resume::Eager);
    assert_agrees("store-eager", scenario, &baseline, &r, c, &b);

    let (r, c, b) = run_store(&compiled, Resume::Lazy);
    assert_agrees("store-lazy", scenario, &baseline, &r, c, &b);

    let (r, c, b) = run_store(&compiled, Resume::LazyAdversarialPrefetch);
    assert_agrees("store-lazy-prefetch", scenario, &baseline, &r, c, &b);

    let (r, c, b) = run_checkpoint_every_crank(&compiled);
    assert_agrees("checkpoint-every-crank", scenario, &baseline, &r, c, &b);
}

#[test]
fn globals_scenario_agrees_six_ways() {
    metamorphic("globals", &["var x = 5;", "x = x + 1;", "x + 10"]);
}

#[test]
fn strings_scenario_agrees_six_ways() {
    metamorphic(
        "strings",
        &["var s = 'seed';", "s = s + '-grow';", "s = s + s;", "s"],
    );
}

#[test]
fn objects_scenario_agrees_six_ways() {
    metamorphic(
        "objects",
        &[
            "var o = { a: 1, b: 2 };",
            "o.a = o.a + o.b;",
            "o.b = o.a * 10;",
            "o.a + o.b",
        ],
    );
}

#[test]
fn free_list_scenario_agrees_six_ways() {
    metamorphic(
        "free-list",
        &[
            "var o = { a: 1, b: 2, c: 3, d: 0 };",
            "o.a; o.c; o.d; delete o.b;",
            "o.a; o.b; o.c; o.d = 4;",
            "o.b; o.a + o.c + o.d",
        ],
    );
}

/// A heap spanning several pages and extents, so lazy runs genuinely
/// fault multiple rows mid-crank and the adversarial prefetch touches
/// a nontrivial space.
#[test]
fn wide_heap_scenario_agrees_six_ways() {
    metamorphic(
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

/// The lazy wake really is lazy: after a lazy resume of the wide-heap
/// store, a crank touching only one global leaves most slot pages
/// non-resident (grow-only residency means those rows were never
/// read). This pins "wake cost proportional to the working set" as an
/// observable property of the implementation, not a hope.
#[test]
fn lazy_resume_faults_only_the_working_set() {
    let cranks = [
        "var last = { v: 0 }; var t = 0; var i = 0; \
         for (i = 0; i < 3000; i = i + 1) { last = { v: i }; } t = 7;",
        "var last; var i; t + 1",
    ];
    let compiled: Vec<(Vec<u8>, Vec<String>)> = cranks.iter().map(|s| compile(s)).collect();

    let store = Rc::new(RefCell::new(MemoryStore::new()));
    let mut m = Interp::new();
    m.link_intrinsics(&compiled[0].1);
    assert!(m.run(&compiled[0].0).completed);
    begin_store_session(&mut m, &sig(), &mut *store.borrow_mut()).unwrap();
    let total_pages = slot_page_count(store.borrow().manifest().unwrap().slot_count);
    assert!(total_pages > 12, "fixture must be genuinely wide");
    drop(m);

    let (mut m2, _) = resume_from_store_lazy(store.clone(), &sig()).unwrap();
    let o = m2.run(&compiled[1].0);
    assert!(o.completed);
    assert_eq!(o.result, "8");
    assert!(
        !m2.slots.is_fully_resident(),
        "a working-set crank must not have faulted the whole heap"
    );
}
