//! The **store-query instrument** for the query-driven GC layer
//! (store seam phase 10): on real machine-shaped SQLite stores across
//! heap sizes, it prices the operations the next phases are designed
//! around —
//!
//! - **checkpoint**: an incremental commit after a small crank. Only the
//!   dirtied rows are written, but the seal re-reads every leaf hash and
//!   recombines the root, so the metadata work is **O(pages)** per commit
//!   (end to end through WAL + `synchronous=FULL`); the label reflects
//!   that, not the O(dirty) row write.
//! - **reach-full**: reachability from the boot/global root over an
//!   ARENA-VISIBLE graph, both paths. `reachable_pages` reads the whole
//!   edge set into Rust and BFSes there; `reachable_pages_sql` runs the
//!   recursive CTE in SQLite. The fixture is a heap-spanning object chain
//!   (below), so the answer is the whole page graph and scales with the
//!   heap — both paths do real, comparable work: the CTE has no free lunch
//!   when the answer *is* the graph.
//! - **reach-small**: the same two paths for a bounded root whose answer
//!   is a single page regardless of heap size. Here the paths diverge —
//!   the CTE returns O(answer) rows while the dense path still marshals the
//!   entire edge set across the boundary — which is the "transfer ∝ answer"
//!   property the generational mark relies on. The two `reach` arms are the
//!   big-answer/small-answer pair.
//! - **rev-edge**: one `pages_referencing` point query (the reverse
//!   lookup the generational mark issues per dirtied page, O(in-degree)).
//! - **partial(cte)**: end-to-end `partial_collect` on a cold lazy resume.
//!   The fixture chain is arena-visible and rooted from a live global, so
//!   a resumed machine finds it wholly reachable and frees ~nothing: the
//!   arm prices the DECISION path (dirty gate + summary count + reachability
//!   query + the empty free), not a mass-free. (An array-held fixture would
//!   be invisible to the arena summaries — side-table references do not
//!   survive the quiescent resume — so a resumed machine would read it as
//!   maximal garbage and this arm would price an O(heap) sweep instead.)
//!
//! `#[ignore]`d; run explicitly in release mode from the repo root:
//!
//! ```sh
//! cargo test --release -p ironhorse-store-sqlite --test store_bench -- --ignored --nocapture
//! ```

use std::cell::RefCell;
use std::rc::Rc;
use std::time::Instant;

use ironhorse_snapshot::machine::{
    begin_store_session, checkpoint_to_store, partial_collect, resume_from_store_lazy,
};
use ironhorse_snapshot::store::{reachable_pages, slot_page_count, HeapStore};
use ironhorse_snapshot::Signature;
use ironhorse_store_sqlite::SqliteHeapStore;
use ironhorse_vm::{parse_symbols, Interp};

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

fn compile(source: &str) -> (Vec<u8>, Vec<String>) {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("fixture compiles");
    (bytecode, parse_symbols(&symbols))
}

fn median(mut times: Vec<f64>) -> f64 {
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    times[times.len() / 2]
}

/// A pid-keyed temp directory that removes itself on drop, so a FAILING
/// assertion (an unwinding panic) cleans up too — the end-of-test
/// `remove_dir_all` alone runs only on the success path. Declared before
/// any store so the store drops first (Rust drops locals in reverse).
struct TempDir {
    path: std::path::PathBuf,
}

impl TempDir {
    fn new(name: &str) -> TempDir {
        let path = std::env::temp_dir().join(format!("{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        TempDir { path }
    }

    fn join(&self, name: impl AsRef<std::path::Path>) -> std::path::PathBuf {
        self.path.join(name)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

#[test]
#[ignore]
fn store_query_cost_across_heap_sizes() {
    let dir = TempDir::new("ironhorse-store-bench");

    for &n in &[5_000u32, 20_000, 80_000] {
        // An ARENA-VISIBLE chain: each node is a plain object whose `next`
        // property holds an object reference (an arena edge, recorded in
        // the page-edge summaries), appended at the tail so the head sits
        // on a low page and forward reachability from it spans the heap.
        // Unlike an array-held graph — whose element references live in the
        // `arrays` side table, invisible to the summaries and gone after a
        // quiescent resume — this survives a cold resume and keeps the
        // whole graph reachable, which is what lets the `partial` arm below
        // price the decision path rather than a mass-free.
        let build = format!(
            "var head = {{ v: 0 }}; var t = head; var i = 0; \
             for (i = 0; i < {n}; i = i + 1) {{ t.next = {{ v: i }}; t = t.next; }} t = 7;"
        );
        // The wake crank redeclares crank 1's global + property-key symbols
        // in order (ids are positional) then dirties one global.
        let touch = "var head; var t; var i; var v; var next; t = t + 1;";
        let (b1, names) = compile(&build);
        let (b2, _) = compile(touch);

        let store = Rc::new(RefCell::new(
            SqliteHeapStore::open(dir.join(format!("heap-{n}.sqlite"))).unwrap(),
        ));
        let mut m = Interp::new();
        m.link_intrinsics(&names);
        assert!(m.run(&b1).completed);
        drop(
            begin_store_session(m, &sig(), &mut *store.borrow_mut())
                .map_err(|(_, e)| e)
                .unwrap(),
        );
        let manifest = store.borrow().manifest().unwrap();
        let pages = slot_page_count(manifest.slot_count);

        // Incremental checkpoint after a one-global crank. O(pages) in the
        // seal even though only the dirtied rows are written. The touch
        // crank redeclares crank 1's symbols positionally; pin its result
        // (`t` starts at 7 and increments 8, 9, … each round) so a future
        // edit that misaligns the redeclaration fails loudly here instead
        // of quietly mistiming a wrong crank.
        let mut commit_ms = Vec::new();
        let mut session = resume_from_store_lazy(store.clone(), &sig()).unwrap();
        for k in 0..5 {
            let o = session.machine_mut().run(&b2);
            assert_eq!(o.result, (8 + k).to_string(), "touch crank result (symbol alignment)");
            let t0 = Instant::now();
            checkpoint_to_store(&mut session, &sig(), &mut *store.borrow_mut()).unwrap();
            commit_ms.push(t0.elapsed().as_secs_f64() * 1e3);
        }
        drop(session);

        // Full-graph reachability, both paths, from the boot/global root:
        // the answer is the whole arena-visible chain, so it scales with
        // the heap and dense/CTE do comparable work (and must AGREE).
        let full_answer = reachable_pages(&*store.borrow(), [0u32]).unwrap().len();
        let cte_full_answer = store.borrow().reachable_pages_sql(&[0]).unwrap().len();
        assert_eq!(full_answer, cte_full_answer, "dense and CTE agree on the full answer");
        let dense_full_ms: Vec<f64> = (0..5)
            .map(|_| {
                let t0 = Instant::now();
                let r = reachable_pages(&*store.borrow(), [0u32]).unwrap();
                assert_eq!(r.len(), full_answer);
                t0.elapsed().as_secs_f64() * 1e3
            })
            .collect();
        let cte_full_ms: Vec<f64> = (0..5)
            .map(|_| {
                let t0 = Instant::now();
                let r = store.borrow().reachable_pages_sql(&[0]).unwrap();
                assert_eq!(r.len(), full_answer);
                t0.elapsed().as_secs_f64() * 1e3
            })
            .collect();

        // Small-answer reachability, both paths, from a bounded (out-of-
        // range, so edgeless) root: the CTE returns a single row while the
        // dense path still reads the ENTIRE edge set to answer it. This is
        // the transfer-∝-answer contrast — the CTE tracks the answer, the
        // dense path tracks the heap.
        let small_root = [pages + 7];
        let small_answer = store.borrow().reachable_pages_sql(&small_root).unwrap().len();
        let dense_small_ms: Vec<f64> = (0..5)
            .map(|_| {
                let t0 = Instant::now();
                let r = reachable_pages(&*store.borrow(), small_root).unwrap();
                assert_eq!(r.len(), small_answer);
                t0.elapsed().as_secs_f64() * 1e3
            })
            .collect();
        let cte_small_ms: Vec<f64> = (0..5)
            .map(|_| {
                let t0 = Instant::now();
                let r = store.borrow().reachable_pages_sql(&small_root).unwrap();
                assert_eq!(r.len(), small_answer);
                t0.elapsed().as_secs_f64() * 1e3
            })
            .collect();
        let rev_us: Vec<f64> = (0..25)
            .map(|k| {
                let t0 = Instant::now();
                let _ = store.borrow().pages_referencing(k % pages).unwrap();
                t0.elapsed().as_secs_f64() * 1e6
            })
            .collect();

        // End-to-end partial_collect on this backend — its decision
        // queries run as the COUNT/CTE overrides. The chain is arena-
        // visible and live, so a cold-resumed machine finds it wholly
        // reachable and frees ~nothing: this prices the gate + query +
        // (empty) free path, NOT the O(garbage) sweep a side-table-only
        // fixture would trigger on resume.
        let mut freed_last = 0;
        let partial_ms: Vec<f64> = (0..5)
            .map(|_| {
                let mut s2 = resume_from_store_lazy(store.clone(), &sig()).unwrap();
                let t0 = Instant::now();
                freed_last = partial_collect(&mut s2, &*store.borrow()).unwrap();
                t0.elapsed().as_secs_f64() * 1e3
            })
            .collect();

        println!(
            "slots={:>7} pages={:>5} | checkpoint(O-pages) {:>7.3} ms | \
             reach-full ({:>4}p) dense {:>7.3} / cte {:>7.3} ms | \
             reach-small ({}p) dense {:>7.3} / cte {:>7.3} ms | \
             rev-edge {:>7.1} us | partial(cte) {:>7.3} ms (freed {})",
            manifest.slot_count,
            pages,
            median(commit_ms),
            full_answer,
            median(dense_full_ms),
            median(cte_full_ms),
            small_answer,
            median(dense_small_ms),
            median(cte_small_ms),
            median(rev_us),
            median(partial_ms),
            freed_last,
        );
        Rc::try_unwrap(store)
            .ok()
            .expect("sole owner")
            .into_inner()
            .close()
            .unwrap();
    }
}
