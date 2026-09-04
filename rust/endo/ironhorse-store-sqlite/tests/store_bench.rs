//! The **store-query instrument** for the query-driven GC layer
//! (store seam phase 10): on real machine-shaped SQLite stores across
//! heap sizes, it prices the operations the next phases are designed
//! around —
//!
//! - **checkpoint**: an incremental commit after a small crank, end to
//!   end through WAL + `synchronous=FULL`. Since V6-c the metadata work
//!   is **O(dirty · log n)**: the producer and the backend each hold a
//!   live `RootLedger`, so neither re-reads nor re-hashes the untouched
//!   leaves — before the ledger this arm measured the O(pages) seal
//!   term the old label named (6.8 ms at 939 pages; now ~0.8 ms, flat
//!   across the rung sizes, the residual being the row write + fsync).
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
//!   query + the empty free), not a mass-free. (An array-held fixture's
//!   element references live in the `arrays` side table: since the G1
//!   ledger they SURVIVE a quiescent resume — restored counts root their
//!   pages — but they are still invisible to the STORED page-edge
//!   summaries, so forward reachability from the head would not span the
//!   heap and the arm would price a different mix; the arena-visible
//!   chain keeps both reachability paths doing identical work.)
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

// The scratch-dir guard lives in tests/common/ now (shared by every
// integration binary); declare it before any store so the store drops
// first (Rust drops locals in reverse).
use common::TempDir;

mod common;

#[test]
#[ignore]
fn store_query_cost_across_heap_sizes() {
    let dir = TempDir::new(&format!("ironhorse-store-bench-{}", std::process::id()));

    for &n in &[5_000u32, 20_000, 80_000] {
        // An ARENA-VISIBLE chain: each node is a plain object whose `next`
        // property holds an object reference (an arena edge, recorded in
        // the page-edge summaries), appended at the tail so the head sits
        // on a low page and forward reachability from it spans the heap.
        // Unlike an array-held graph — whose element references live in
        // the `arrays` side table, page-granular ROOTS since the G1
        // ledger but still invisible to the stored page-edge summaries —
        // this keeps forward reachability spanning the heap through the
        // summaries themselves, so the `partial` arm below prices the
        // decision path with both reachability paths doing real work.
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

        // Incremental checkpoint after a one-global crank — O(dirty·log)
        // metadata since V6-c (see the module doc's before/after). The
        // touch crank redeclares crank 1's symbols positionally; pin its result
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
            "slots={:>7} pages={:>5} | checkpoint(O-dirty·log) {:>7.3} ms | \
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

#[test]
#[ignore]
fn generational_indexed_steady_state() {
    use ironhorse_snapshot::machine::{generational_collect, partial_collect};
    // Phase 11's INDEXED regime: seeds answered from the reverse
    // index (`externally_referenced`) and the expansion bounded to
    // the dirty region (`reachable_within`'s region-bounded CTE) —
    // with a fixed small mutation set, the pass stays flat while the
    // old generation grows (the dense-default regime's growth curve
    // lives in gc_bench's generational arm).
    for &n in &[5_000u32, 20_000, 80_000] {
        let build = format!(
            "var keep = 0; var g = 0; var i = 0; var t = 0; \
             for (i = 0; i < {n}; i = i + 1) {{ keep = {{ v: i, w: i }}; }} t = 1; t"
        );
        let churn = "var keep; var g; var i; var t; \
                     for (i = 0; i < 300; i = i + 1) { g = { v: i, w: i }; } \
                     g = 0; keep = { v: -1, w: -1 }; t = 2; t";
        let (b, names) = compile(&build);
        let (bc, _) = compile(churn);

        let mut gen_ms = Vec::new();
        let mut freed_gen = 0u32;
        let mut slots_total = 0u32;
        for round in 0..6 {
            let dir = TempDir::new(&format!(
                "ironhorse-store-bench-gen-{n}-{round}-{}",
                std::process::id()
            ));
            let mut store = SqliteHeapStore::open(dir.join("heap.sqlite")).unwrap();
            let mut m = Interp::new();
            m.link_intrinsics(&names);
            assert!(m.run(&b).completed);
            let mut session = begin_store_session(m, &sig(), &mut store)
                .map_err(|(_, e)| e)
                .expect("begin");
            let _ = partial_collect(&mut session, &store).expect("boundary");
            checkpoint_to_store(&mut session, &sig(), &mut store).expect("ckpt");
            assert!(session.machine_mut().run(&bc).completed);
            checkpoint_to_store(&mut session, &sig(), &mut store).expect("ckpt");
            slots_total = session.machine().slots.capacity();

            let t0 = Instant::now();
            freed_gen = generational_collect(&mut session, &store).expect("gen");
            let ms = t0.elapsed().as_secs_f64() * 1e3;
            if round > 0 {
                gen_ms.push(ms);
            }
        }
        println!(
            "slots={slots_total:>7} | generational (indexed) {:>7.3} ms (freed {freed_gen})",
            median(gen_ms),
        );
    }
}
