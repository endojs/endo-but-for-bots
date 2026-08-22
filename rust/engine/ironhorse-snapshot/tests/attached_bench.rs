//! The **attached-mode instrument** — the design's deferred
//! attached-mode benchmark (`designs/ironhorse-snapshot-store-seam.md`
//! § remaining): what does running ON a store-backed machine cost,
//! separated into the two prices a supervisor actually pays:
//!
//! - **attached-resident**: every page already faulted — the residual
//!   per-dispatch cost of the lazy arenas' residency branches against
//!   a detached machine (the steady-state tax).
//! - **attached-faulting**: a cold lazy resume running the same crank,
//!   so faults interleave with dispatch (the first-crank tax; compare
//!   with `wake_latency_bench`, which isolates the wake itself).
//!
//! `#[ignore]`d; run explicitly in release mode:
//!
//! ```sh
//! cargo test --release -p ironhorse-snapshot --test attached_bench -- --ignored --nocapture
//! ```
//!
//! The instrument prints medians and ratios; the phase-3 gate's
//! detached half lives in `ironhorse-vm/tests/dispatch_bench.rs` and
//! is unaffected by attachment (detached machines pay one
//! always-false branch).

use std::cell::RefCell;
use std::rc::Rc;
use std::time::Instant;

use ironhorse_snapshot::machine::{begin_store_session, resume_from_store_lazy};
use ironhorse_snapshot::store::{chunk_extent_count, slot_page_count, HeapStore, MemoryStore};
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
fn attached_vs_detached_hot_crank() {
    // Build a mid-sized heap (so faults are real work in the cold
    // arm), then a dispatch-heavy, allocation-light hot crank that
    // re-runs identically: property reads + integer arithmetic over a
    // spread of objects. Crank 2 redeclares crank 1's symbol order.
    let build = "var acc = 0; var o = { a: 1, b: 2 }; var i = 0; var arr = []; \
                 for (i = 0; i < 20000; i = i + 1) { arr[i] = { a: i, b: 1 }; }";
    let hot = "var acc; var o; var a; var b; var i; var arr; \
               acc = 0; \
               for (i = 0; i < 20000; i = i + 1) { acc = acc + o.a + o.b; } \
               acc";
    let (b_build, names) = compile(build);
    let (b_hot, _) = compile(hot);
    const ROUNDS: usize = 9;

    // Arm 1: detached (no store anywhere).
    let mut detached = Interp::new();
    detached.link_intrinsics(&names);
    assert!(detached.run(&b_build).completed);
    let detached_ms: Vec<f64> = (0..ROUNDS)
        .map(|_| {
            let t0 = Instant::now();
            let o = detached.run(&b_hot);
            assert_eq!(o.result, "60000");
            t0.elapsed().as_secs_f64() * 1e3
        })
        .collect();

    // Store fixture for the attached arms.
    let store = Rc::new(RefCell::new(MemoryStore::new()));
    let mut m = Interp::new();
    m.link_intrinsics(&names);
    assert!(m.run(&b_build).completed);
    drop(
        begin_store_session(m, &sig(), &mut *store.borrow_mut())
            .map_err(|(_, e)| e)
            .unwrap(),
    );
    let manifest = store.borrow().manifest().unwrap();
    println!(
        "heap: {} slots ({} pages), {} chunk bytes ({} extents)",
        manifest.slot_count,
        slot_page_count(manifest.slot_count),
        manifest.chunk_len,
        chunk_extent_count(manifest.chunk_len),
    );

    // Arm 2: attached-resident — one lazy session, everything
    // pre-faulted, then the same hot rounds on the SAME machine.
    let mut resident = resume_from_store_lazy(store.clone(), &sig()).unwrap();
    {
        let m = resident.machine();
        for page in 0..slot_page_count(manifest.slot_count) {
            m.slots.touch_page(page);
        }
        for ext in 0..chunk_extent_count(manifest.chunk_len) {
            m.chunks.touch_extent(ext);
        }
    }
    let resident_ms: Vec<f64> = (0..ROUNDS)
        .map(|_| {
            let t0 = Instant::now();
            let o = resident.machine_mut().run(&b_hot);
            assert_eq!(o.result, "60000");
            t0.elapsed().as_secs_f64() * 1e3
        })
        .collect();

    // Arm 3: attached-faulting — a FRESH cold lazy resume per round,
    // faults interleaved with the crank's own dispatch. The clock starts
    // AFTER `resume_from_store_lazy` returns: the resume's attach/validate
    // cost is the wake latency `wake_latency_bench` already isolates, so
    // timing it here too would fold that whole tax into the "faulting"
    // number (it dominated the old measurement). What remains under the
    // clock is exactly the first-crank tax — the page/extent faults that
    // interleave with this crank's own dispatch.
    let faulting_ms: Vec<f64> = (0..ROUNDS)
        .map(|_| {
            let mut s2 = resume_from_store_lazy(store.clone(), &sig()).unwrap();
            let t0 = Instant::now();
            let o = s2.machine_mut().run(&b_hot);
            assert_eq!(o.result, "60000");
            t0.elapsed().as_secs_f64() * 1e3
        })
        .collect();

    let (d, r, f) = (median(detached_ms), median(resident_ms), median(faulting_ms));
    println!("detached hot crank median:          {d:.3} ms");
    println!("attached-resident hot crank median: {r:.3} ms  (x{:.3} of detached)", r / d);
    println!("attached-faulting hot crank median: {f:.3} ms  (x{:.3} of detached)", f / d);
}
