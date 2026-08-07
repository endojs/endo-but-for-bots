//! The **detached hot-path benchmark** behind the store seam's phase-3
//! gate (design § Lazy reification: "zero measurable regression
//! detached"). `#[ignore]`d: run explicitly, in release mode, on the
//! trees being compared —
//!
//! ```sh
//! cargo test --release -p ironhorse-snapshot --test dispatch_bench -- --ignored --nocapture
//! ```
//!
//! Three workloads stress the three read paths the lazy mechanization
//! touched: pure dispatch (arithmetic/branch loop), slot traffic
//! (property get/set loop through `SlotArena::get`/`get_mut`), and
//! chunk traffic (string concat + compare through the `ChunkSlice`
//! guards). Each workload reports the median of five runs on a fresh
//! detached machine; the comparison across trees is done by the
//! operator (or CI) running the same file on both.

use ironhorse_vm::{parse_symbols, Interp};
use std::time::Instant;

fn compile(source: &str) -> (Vec<u8>, Vec<String>) {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("fixture compiles");
    (bytecode, parse_symbols(&symbols))
}

fn median_ms(source: &str, expect: &str) -> f64 {
    let (bytecode, names) = compile(source);
    // Warm-up + correctness check.
    let mut warm = Interp::new();
    warm.link_intrinsics(&names);
    let o = warm.run(&bytecode);
    assert!(o.completed, "bench fixture completes (halt: {:?})", o.halt);
    assert_eq!(o.result, expect, "bench fixture result");

    let mut times: Vec<f64> = (0..5)
        .map(|_| {
            let mut m = Interp::new();
            m.link_intrinsics(&names);
            let t0 = Instant::now();
            let o = m.run(&bytecode);
            let dt = t0.elapsed().as_secs_f64() * 1e3;
            assert!(o.completed);
            dt
        })
        .collect();
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    times[2]
}

#[test]
#[ignore = "benchmark: run explicitly in --release on the trees being compared"]
fn detached_hot_path_bench() {
    let dispatch = median_ms(
        "var t = 0; var i = 0; for (i = 0; i < 2000000; i = i + 1) { t = t + (i % 7); } t",
        "5999995",
    );
    let slots = median_ms(
        "var o = { a: 0, b: 1 }; var i = 0; \
         for (i = 0; i < 500000; i = i + 1) { o.a = o.a + 1; o.b = o.b + 2; } o.a",
        "500000",
    );
    let chunks = median_ms(
        "var s = 'abcdefgh'; var t = ''; var n = 0; var i = 0; \
         for (i = 0; i < 40000; i = i + 1) { t = s + 'x'; if (t == s) { n = n + 1; } } n",
        "0",
    );
    println!("BENCH dispatch_ms={dispatch:.2} slots_ms={slots:.2} chunks_ms={chunks:.2}");
}
