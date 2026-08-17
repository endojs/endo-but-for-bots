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
        // list.) The split rounds replicate the collector's three
        // phases — root enumeration (the O(live) side-table walk),
        // the store decision query, the page free — so the numbers
        // say WHICH term dominates at each size.
        let mut partial_ms = Vec::new();
        let mut enum_ms = Vec::new();
        let mut query_ms = Vec::new();
        let mut freed_last = 0;
        for round in 0..5 {
            let mut store = MemoryStore::new();
            let mut m = Interp::new();
            m.link_intrinsics(&names);
            assert!(m.run(&b).completed);
            let mut session = begin_store_session(m, &sig(), &mut store)
                .map_err(|(_, e)| e)
                .unwrap();
            if round == 0 {
                // Phase split, measured on the round whose end-to-end
                // time is discarded (the split itself perturbs it).
                let interp = session.machine();
                let t0 = Instant::now();
                let mut roots: std::collections::BTreeSet<u32> = std::collections::BTreeSet::new();
                for r in interp.gc_roots() {
                    if !r.is_null() {
                        roots.insert(r.0 / ironhorse_vm::SLOTS_PER_PAGE);
                    }
                }
                for r in interp.side_table_ref_slots() {
                    if !r.is_null() {
                        roots.insert(r.0 / ironhorse_vm::SLOTS_PER_PAGE);
                    }
                }
                enum_ms.push(t0.elapsed().as_secs_f64() * 1e3);
                let roots: Vec<u32> = roots.into_iter().collect();
                let t1 = Instant::now();
                let reached = store.reachable_page_set(&roots).unwrap();
                query_ms.push(t1.elapsed().as_secs_f64() * 1e3);
                assert!(!reached.is_empty());
                continue;
            }
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
             partial {:>7.3} ms (freed {}; enum {:.3} ms, query {:.3} ms) | \
             free-list {:>7} | collect/slot {:>6.1} ns",
            slots_total,
            slot_page_count(slots_total),
            median(first_ms),
            median(steady_ms),
            median(partial_ms),
            freed_last,
            enum_ms[0],
            query_ms[0],
            free_len,
            sweep_ns_per_slot,
        );
    }
}
