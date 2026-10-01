//! The **call and re-entry benchmark** behind the dispatch-split gate of
//! `STACK-DEPTH-REFACTOR.md` §4.3 (A2): the paths that a split of the
//! dispatch loop restructures, which `dispatch_bench`'s straight-line loops
//! do not cross. `#[ignore]`d: run explicitly, in release mode, on the trees
//! being compared —
//!
//! ```sh
//! cargo test --release -p ironhorse-snapshot --test reentry_bench -- --ignored --nocapture
//! ```
//!
//! Four workloads: guest-to-guest calls (the XS comparison's `calls`
//! fixture, fifty times longer), guest recursion, a native that calls back
//! into the guest (`Array.prototype.forEach`), and an accessor read that
//! re-enters the dispatch loop. Each reports the median of five runs on a
//! fresh detached machine.

mod bench_support;

use ironhorse_vm::{parse_symbols, Interp};
use std::time::Instant;

fn compile(source: &str) -> (Vec<u8>, Vec<ironhorse_vm::SymbolName>) {
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
fn call_and_reentry_bench() {
    let calls = median_ms(
        "function f(x) { return x + 1; } var n = 0; \
         for (var i = 0; i < 1000000; i++) n = f(n); n",
        "1000000",
    );
    let recursion = median_ms(
        "function f(n) { return n <= 0 ? 0 : 1 + f(n - 1); } var t = 0; \
         for (var i = 0; i < 2000; i++) { t = t + f(300); } t",
        "600000",
    );
    let callbacks = median_ms(
        "var a = []; for (var i = 0; i < 1000; i++) a.push(i); var t = 0; \
         for (var j = 0; j < 1000; j++) { a.forEach(function (x) { t = t + x; }); } t",
        "499500000",
    );
    let getter = median_ms(
        "var o = { get x() { return 3; } }; var t = 0; \
         for (var i = 0; i < 1000000; i++) { t = t + o.x; } t",
        "3000000",
    );
    for (name, value) in [
        ("calls_ms", calls),
        ("recursion_ms", recursion),
        ("callbacks_ms", callbacks),
        ("getter_ms", getter),
    ] {
        bench_support::report(name, value);
    }
    println!(
        "BENCH calls_ms={calls:.2} recursion_ms={recursion:.2} callbacks_ms={callbacks:.2} \
         getter_ms={getter:.2}"
    );
}
