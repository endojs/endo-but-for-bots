//! The **store-query instrument** for the query-driven GC layer
//! (store seam phase 10): on real machine-shaped SQLite stores across
//! heap sizes, it prices the operations the next phases are designed
//! around —
//!
//! - **checkpoint**: an incremental commit after a small crank (the
//!   O(dirty) write path, end to end through WAL + `synchronous=FULL`).
//! - **reach-dense**: `reachable_pages` — read the WHOLE edge set into
//!   Rust, BFS there (O(pages) transfer regardless of the answer).
//! - **reach-cte**: `reachable_pages_sql` — the recursive CTE over the
//!   normalized `edge_pairs`, transfer proportional to the answer.
//! - **rev-edge**: one `pages_referencing` point query (the reverse
//!   lookup the generational mark issues per dirtied page).
//!
//! `#[ignore]`d; run explicitly in release mode from the repo root:
//!
//! ```sh
//! cargo test --release -p ironhorse-store-sqlite --test store_bench -- --ignored --nocapture
//! ```

use std::cell::RefCell;
use std::rc::Rc;
use std::time::Instant;

use ironhorse_snapshot::machine::{begin_store_session, checkpoint_to_store, resume_from_store_lazy};
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

#[test]
#[ignore]
fn store_query_cost_across_heap_sizes() {
    let dir = std::env::temp_dir().join(format!("ironhorse-store-bench-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    for &n in &[5_000u32, 20_000, 80_000] {
        let build = format!(
            "var arr = []; var t = 0; var i = 0; \
             for (i = 0; i < {n}; i = i + 1) {{ arr[i] = {{ v: i, w: i }}; }} t = 7;"
        );
        let touch = "var arr; var t; var i; var v; var w; t = t + 1;";
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

        // Incremental checkpoint after a one-global crank.
        let mut commit_ms = Vec::new();
        let mut session = resume_from_store_lazy(store.clone(), &sig()).unwrap();
        for _ in 0..5 {
            assert!(session.machine_mut().run(&b2).completed);
            let t0 = Instant::now();
            checkpoint_to_store(&mut session, &sig(), &mut *store.borrow_mut()).unwrap();
            commit_ms.push(t0.elapsed().as_secs_f64() * 1e3);
        }
        drop(session);

        // Reachability, both paths, same roots (the boot/global page).
        let dense_ms: Vec<f64> = (0..5)
            .map(|_| {
                let t0 = Instant::now();
                let r = reachable_pages(&*store.borrow(), [0u32]).unwrap();
                assert!(!r.is_empty());
                t0.elapsed().as_secs_f64() * 1e3
            })
            .collect();
        let cte_ms: Vec<f64> = (0..5)
            .map(|_| {
                let t0 = Instant::now();
                let r = store.borrow().reachable_pages_sql(&[0]).unwrap();
                assert!(!r.is_empty());
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

        println!(
            "slots={:>7} pages={:>5} | checkpoint {:>7.3} ms | reach-dense {:>7.3} ms | \
             reach-cte {:>7.3} ms | rev-edge {:>7.1} us",
            manifest.slot_count,
            pages,
            median(commit_ms),
            median(dense_ms),
            median(cte_ms),
            median(rev_us),
        );
        Rc::try_unwrap(store)
            .ok()
            .expect("sole owner")
            .into_inner()
            .close()
            .unwrap();
    }
    let _ = std::fs::remove_dir_all(&dir);
}
