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
//! - **partial**: `partial_collect` at a clean checkpoint boundary, split
//!   into its four phases — the summary-count gate, root enumeration (the
//!   O(live) side-table walk), the store decision query (page edges + BFS,
//!   no row-content reads), and the page free (O(garbage reclaimed)). All
//!   four are timed in one warm round, so the free term is measured rather
//!   than left to subtraction, and no cold sample is printed beside a warm
//!   median.
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
    // partial collector's hard case). Read PAGE-level freed counts
    // with the allocation stride in mind (wave-3 observation): when
    // an object's slot stride does not divide the 256-slot page,
    // consecutive allocations straddle page boundaries and chain
    // page p -> p+1 (plus the prototype edge to page 0), and
    // page-conservative collection then frees far less than an
    // aligned stride would — deterministic, and identical across
    // backends.
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
        // list.) Every round runs the SAME four phases `partial_collect`
        // runs — the summary-count gate, root enumeration (the O(live)
        // side-table walk), the store decision query, and the page free
        // (the O(garbage reclaimed) term) — timing all four in ONE round
        // so the terms are comparable and the dominant free term is
        // MEASURED, not left to subtraction. Round 0 is a discarded
        // warmup (first-touch faults/caches); the medians are over the
        // warm rounds only, so no cold sample is printed beside a warm
        // one. `ref_freed` locks the inline replication to the public
        // collector's result.
        let ref_freed = {
            let mut store = MemoryStore::new();
            let mut m = Interp::new();
            m.link_intrinsics(&names);
            assert!(m.run(&b).completed);
            let mut session = begin_store_session(m, &sig(), &mut store)
                .map_err(|(_, e)| e)
                .unwrap();
            partial_collect(&mut session, &store).unwrap()
        };
        let mut gate_ms = Vec::new();
        let mut enum_ms = Vec::new();
        let mut query_ms = Vec::new();
        let mut free_ms = Vec::new();
        let mut partial_ms = Vec::new();
        for round in 0..6 {
            let mut store = MemoryStore::new();
            let mut m = Interp::new();
            m.link_intrinsics(&names);
            assert!(m.run(&b).completed);
            let mut session = begin_store_session(m, &sig(), &mut store)
                .map_err(|(_, e)| e)
                .unwrap();
            let total = slot_page_count(store.manifest().unwrap().slot_count);

            // Phase 1 — the summary-count gate.
            let t0 = Instant::now();
            let found = store.summary_page_count().unwrap();
            let gate = t0.elapsed().as_secs_f64() * 1e3;
            assert_eq!(found, total, "gate agrees with geometry");

            // Phase 2 — root enumeration (gc roots + side-table ref pages).
            let t1 = Instant::now();
            let mut roots: std::collections::BTreeSet<u32> = std::collections::BTreeSet::new();
            for r in session.machine().gc_roots() {
                if !r.is_null() {
                    roots.insert(r.0 / ironhorse_vm::SLOTS_PER_PAGE);
                }
            }
            for (p, hit) in session
                .machine()
                .side_table_ref_page_bits()
                .into_iter()
                .enumerate()
            {
                if hit {
                    roots.insert(p as u32);
                }
            }
            let roots: Vec<u32> = roots.into_iter().collect();
            let enum_p = t1.elapsed().as_secs_f64() * 1e3;

            // Phase 3 — the store reachability query.
            let t2 = Instant::now();
            let reached = store.reachable_page_set(&roots).unwrap();
            let query = t2.elapsed().as_secs_f64() * 1e3;

            // Phase 4 — the page free (the dominant, O(garbage) term).
            let dead: Vec<u32> = (0..total).filter(|p| !reached.contains(p)).collect();
            let t3 = Instant::now();
            let freed = session.machine_mut().free_pages(&dead);
            let free_p = t3.elapsed().as_secs_f64() * 1e3;
            assert_eq!(freed, ref_freed, "inline phases match partial_collect");

            if round == 0 {
                continue; // warmup
            }
            gate_ms.push(gate);
            enum_ms.push(enum_p);
            query_ms.push(query);
            free_ms.push(free_p);
            partial_ms.push(gate + enum_p + query + free_p);
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
             partial {:>7.3} ms (freed {}; gate {:.3}, enum {:.3}, query {:.3}, free {:.3} ms) | \
             free-list {:>7} | collect/slot {:>6.1} ns",
            slots_total,
            slot_page_count(slots_total),
            median(first_ms),
            median(steady_ms),
            median(partial_ms),
            ref_freed,
            median(gate_ms),
            median(enum_ms),
            median(query_ms),
            median(free_ms),
            free_len,
            sweep_ns_per_slot,
        );
    }
}

#[test]
#[ignore]
fn generational_steady_state_cost() {
    use ironhorse_snapshot::machine::{
        begin_store_session, checkpoint_to_store, generational_collect, partial_collect,
    };
    use ironhorse_snapshot::store::MemoryStore;
    // Phase 11's bar: with a SMALL mutation set, the generational
    // pass's decision cost is bounded by the mutated region — near
    // flat across heap sizes — while the full partial pass's decision
    // cost grows with the page count. The same small churn crank runs
    // at every heap size; only the old-generation size varies.
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
        let mut part_ms = Vec::new();
        let mut freed_gen = 0u32;
        let mut slots_total = 0u32;
        for _ in 0..5 {
            let mut store = MemoryStore::new();
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
            let t0 = std::time::Instant::now();
            freed_gen = generational_collect(&mut session, &store).expect("gen");
            gen_ms.push(t0.elapsed().as_secs_f64() * 1e3);

            // The full-pass comparison runs on a TWIN state (same
            // build, same churn) so neither timing sees the other's
            // reclamation.
            let mut store2 = MemoryStore::new();
            let mut m2 = Interp::new();
            m2.link_intrinsics(&names);
            assert!(m2.run(&b).completed);
            let mut s2 = begin_store_session(m2, &sig(), &mut store2)
                .map_err(|(_, e)| e)
                .expect("begin");
            let _ = partial_collect(&mut s2, &store2).expect("boundary");
            checkpoint_to_store(&mut s2, &sig(), &mut store2).expect("ckpt");
            assert!(s2.machine_mut().run(&bc).completed);
            checkpoint_to_store(&mut s2, &sig(), &mut store2).expect("ckpt");
            let t1 = std::time::Instant::now();
            let _ = partial_collect(&mut s2, &store2).expect("partial");
            part_ms.push(t1.elapsed().as_secs_f64() * 1e3);
        }
        println!(
            "slots={slots_total:>7} | generational {:>7.3} ms (freed {freed_gen}) | full partial {:>7.3} ms",
            median(gen_ms),
            median(part_ms),
        );
        // Dense-default regime (MemoryStore): both passes read the
        // whole edge table, so both grow with the page count and the
        // generational win is a constant factor. The INDEXED regime —
        // seeds from the reverse index, expansion bounded to the
        // dirty region — is measured in the SQLite store_bench's
        // generational arm, where the pass stays flat.
    }
}

/// The phase-12 gate instrument: how much of a post-compaction
/// checkpoint is the SLIDE — the extents rewritten only because
/// surviving chunk bytes moved down over reclaimed space. Identity-
/// keyed chunk rows (compaction as row moves) would reduce those
/// rewrites to metadata updates; the phase-7 incremental-dirt cut
/// already keeps a NO-move collection's checkpoint clean, so this arm
/// measures exactly the residual win that would justify the deep
/// redesign (store schema + slot→chunk encoding + compactor together,
/// per the design's honest note).
///
/// Two rounds on the same shape: garbage allocated BEHIND the
/// survivors (front of the chunk space — compaction slides everything
/// live), then garbage AFTER them (tail — nothing moves). The delta
/// between the two checkpoints' extent-row counts is the slide cost.
#[test]
#[ignore]
fn compaction_slide_checkpoint_cost() {
    use ironhorse_snapshot::machine::checkpoint_to_store;
    use ironhorse_snapshot::store::{HeapStore, MemoryStore, CHUNK_EXTENT_BYTES};

    for &n in &[500u32, 2_000, 8_000] {
        // `junk` strings first (low chunk offsets), `keep` strings
        // after them (higher offsets): dropping junk and collecting
        // slides every keep chunk down. The reverse order (keep
        // first) frees the tail: same reclaim, zero movement.
        // Plain literals only: a `'…' + i` concat would interleave
        // intermediate garbage between the survivors and force a slide
        // in BOTH rounds (measured before this shape was chosen —
        // realistic string BUILDING makes every compaction slide-heavy,
        // which is the phase-12 demand signal in itself).
        let front = format!(
            "var junk = 0; var keep = 0; var i = 0; var t = 0; \
             junk = []; keep = []; \
             for (i = 0; i < {n}; i = i + 1) {{ junk[i] = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; }} \
             for (i = 0; i < {n}; i = i + 1) {{ keep[i] = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'; }} \
             junk = 0; t = 7;"
        );
        let tail = format!(
            "var junk = 0; var keep = 0; var i = 0; var t = 0; \
             keep = []; junk = []; \
             for (i = 0; i < {n}; i = i + 1) {{ keep[i] = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'; }} \
             for (i = 0; i < {n}; i = i + 1) {{ junk[i] = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; }} \
             junk = 0; t = 7;"
        );
        let mut row = |label: &str, source: &str| {
            let (b, names) = compile(source);
            let mut m = Interp::new();
            m.link_intrinsics(&names);
            assert!(m.run(&b).completed);
            let mut store = MemoryStore::new();
            let mut session = begin_store_session(m, &sig(), &mut store)
                .map_err(|(_, e)| e)
                .unwrap();
            let extents_before =
                (store.manifest().unwrap().chunk_len as usize).div_ceil(CHUNK_EXTENT_BYTES as usize);
            session.machine_mut().collect_garbage();
            let t0 = Instant::now();
            checkpoint_to_store(&mut session, &sig(), &mut store).unwrap();
            let ms = t0.elapsed().as_secs_f64() * 1e3;
            let stats = store.last_commit_stats();
            let extents_after =
                (store.manifest().unwrap().chunk_len as usize).div_ceil(CHUNK_EXTENT_BYTES as usize);
            println!(
                "chunks n={n:>5} {label}: extents {extents_before:>4}→{extents_after:>4} | \
                 extent rows written {:>4} | slot pages written {:>4} | checkpoint {ms:>7.3} ms",
                stats.chunk_extents_written, stats.slot_pages_written,
            );
            stats.chunk_extents_written
        };
        let moved = row("front-garbage (slide)", &front);
        let unmoved = row("tail-garbage  (no-op)", &tail);
        println!(
            "chunks n={n:>5} SLIDE COST: {} extent rows are pure movement rewrite\n",
            moved.saturating_sub(unmoved),
        );
    }
}
