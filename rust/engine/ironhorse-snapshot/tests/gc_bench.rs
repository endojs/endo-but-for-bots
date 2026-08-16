//! The **GC scaling instrument** for the O(heap)-touchpoint work
//! (`designs/ironhorse-snapshot-store-seam.md` § the residual O(heap)
//! touchpoints): puts numbers on the collectors the next phases aim to
//! shrink, across heap sizes, so table/query-driven designs have a
//! baseline to beat.
//!
//! Per heap size it prints:
//! - **full-first**: `collect_garbage` with real garbage to sweep and
//!   compact (reclaim + mark of the live graph) — the O(heap) mark.
//! - **full-steady**: an immediately following collect (mark-dominated,
//!   nothing to reclaim) — the floor the generational design must beat.
//! - **partial**: `partial_collect` at a clean checkpoint boundary —
//!   the summary-driven collector's metadata-scale query (page edges +
//!   BFS + side-table roots), no row-content reads.
//! - **sweep/slot**: steady-state sweep cost per record with a LARGE
//!   free list resident — linear since the free-membership bitmap
//!   (the review fix; the prior `Vec::contains` sweep was quadratic in
//!   free-list length).
//!
//! `#[ignore]`d; run explicitly in release mode:
//!
//! ```sh
//! cargo test --release -p ironhorse-snapshot --test gc_bench -- --ignored --nocapture
//! ```

use std::time::Instant;

use ironhorse_snapshot::machine::{begin_store_session, partial_collect};
use ironhorse_snapshot::store::{slot_page_count, HeapStore, MemoryStore};
use ironhorse_snapshot::Signature;
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
fn gc_cost_across_heap_sizes() {
    // Live structure (an array of objects) plus an equal volume of
    // dropped garbage, scaled by the loop count. Three slots per
    // element keeps the live graph side-table-referenced (the
    // partial collector's hard case).
    for &n in &[5_000u32, 20_000, 80_000] {
        let build = format!(
            "var arr = []; var g = 0; var i = 0; \
             for (i = 0; i < {n}; i = i + 1) {{ arr[i] = {{ v: i, w: i }}; }} \
             for (i = 0; i < {n}; i = i + 1) {{ g = {{ v: i, w: i }}; }} \
             g = 0;"
        );
        let (b, names) = compile(&build);

        // full-first / full-steady on a fresh machine per round.
        let mut first_ms = Vec::new();
        let mut steady_ms = Vec::new();
        let mut slots_total = 0u32;
        for _ in 0..5 {
            let mut m = Interp::new();
            m.link_intrinsics(&names);
            assert!(m.run(&b).completed);
            slots_total = m.slots.capacity();
            let t0 = Instant::now();
            let s1 = m.collect_garbage();
            first_ms.push(t0.elapsed().as_secs_f64() * 1e3);
            assert!(s1.slots_reclaimed > n, "garbage swept: {s1:?}");
            let t1 = Instant::now();
            m.collect_garbage();
            steady_ms.push(t1.elapsed().as_secs_f64() * 1e3);
        }

        // partial_collect at a clean boundary, store-backed. (One
        // machine per round: partial collection mutates the free
        // list.)
        let mut partial_ms = Vec::new();
        let mut freed_last = 0;
        for _ in 0..5 {
            let mut store = MemoryStore::new();
            let mut m = Interp::new();
            m.link_intrinsics(&names);
            assert!(m.run(&b).completed);
            let mut session = begin_store_session(m, &sig(), &mut store)
                .map_err(|(_, e)| e)
                .unwrap();
            let t0 = Instant::now();
            freed_last = partial_collect(&mut session, &store).unwrap();
            partial_ms.push(t0.elapsed().as_secs_f64() * 1e3);
        }

        // Steady-state sweep with a large resident free list: after
        // the first collect built the free list, time another collect
        // and report per-record cost.
        let mut m = Interp::new();
        m.link_intrinsics(&names);
        assert!(m.run(&b).completed);
        m.collect_garbage();
        let free_len = m.slots.free_list().len();
        let t0 = Instant::now();
        m.collect_garbage();
        let sweep_ns_per_slot = t0.elapsed().as_secs_f64() * 1e9 / m.slots.capacity() as f64;

        println!(
            "slots={:>7} pages={:>5} | full-first {:>8.3} ms | full-steady {:>8.3} ms | \
             partial {:>7.3} ms (freed {}) | free-list {:>7} | collect/slot {:>6.1} ns",
            slots_total,
            slot_page_count(slots_total),
            median(first_ms),
            median(steady_ms),
            median(partial_ms),
            freed_last,
            free_len,
            sweep_ns_per_slot,
        );
    }
}
