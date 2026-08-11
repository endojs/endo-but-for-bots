//! The **wake-latency instrument** the store seam's phase-5 bar names:
//! eager vs lazy resume on a wide heap, measuring attach plus a
//! one-global wake crank. `#[ignore]`d; run explicitly in release mode:
//!
//! ```sh
//! cargo test --release -p ironhorse-snapshot --test wake_latency_bench -- --ignored --nocapture
//! ```
//!
//! The claim under measurement: lazy wake cost is proportional to the
//! wake crank's working set, not the heap. The instrument prints both
//! medians and their ratio; the operator compares across heap sizes
//! (the fixture loop count scales the heap).

use std::cell::RefCell;
use std::rc::Rc;
use std::time::Instant;

use ironhorse_snapshot::machine::{begin_store_session, resume_from_store, resume_from_store_lazy};
use ironhorse_snapshot::store::{HeapStore, MemoryStore};
use ironhorse_snapshot::Signature;
use ironhorse_vm::{parse_symbols, Interp};

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

fn compile(source: &str) -> (Vec<u8>, Vec<String>) {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("fixture compiles");
    (bytecode, parse_symbols(&symbols))
}

#[test]
#[ignore]
fn wake_latency_eager_vs_lazy() {
    // A wide heap: tens of thousands of objects and a multi-extent
    // string space, then a wake crank touching ONE global.
    let build = "var last = { v: 0 }; var t = 0; var i = 0; var s = 'x'; \
                 for (i = 0; i < 60000; i = i + 1) { last = { v: i }; } \
                 for (i = 0; i < 13; i = i + 1) { s = s + s; } t = 7;";
    let wake = "var last; var i; var s; t + 1";
    let (b1, names) = compile(build);
    let (b2, _) = compile(wake);

    let store = Rc::new(RefCell::new(MemoryStore::new()));
    let mut m = Interp::new();
    m.link_intrinsics(&names);
    assert!(m.run(&b1).completed);
    drop(
        begin_store_session(m, &sig(), &mut *store.borrow_mut())
            .map_err(|(_, e)| e)
            .unwrap(),
    );
    let manifest = store.borrow().manifest().unwrap();
    println!(
        "heap: {} slots, {} chunk bytes",
        manifest.slot_count, manifest.chunk_len
    );

    let median = |mut times: Vec<f64>| -> f64 {
        times.sort_by(|a, b| a.partial_cmp(b).unwrap());
        times[times.len() / 2]
    };

    let eager: Vec<f64> = (0..5)
        .map(|_| {
            let t0 = Instant::now();
            let mut s2 = resume_from_store(&*store.borrow(), &sig()).unwrap();
            let o = s2.machine_mut().run(&b2);
            assert_eq!(o.result, "8");
            t0.elapsed().as_secs_f64() * 1e3
        })
        .collect();
    let lazy: Vec<f64> = (0..5)
        .map(|_| {
            let t0 = Instant::now();
            let mut s2 = resume_from_store_lazy(store.clone(), &sig()).unwrap();
            let o = s2.machine_mut().run(&b2);
            assert_eq!(o.result, "8");
            t0.elapsed().as_secs_f64() * 1e3
        })
        .collect();
    let (e, l) = (median(eager), median(lazy));
    println!("eager wake median: {e:.3} ms");
    println!("lazy  wake median: {l:.3} ms");
    println!("lazy/eager ratio:  {:.3}", l / e);
}
