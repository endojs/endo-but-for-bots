//! Native runtime cost of the stack-depth prototype patches.
//!
//! Evidence for `STACK-DEPTH-REFACTOR.md` §4.3 and `README.md` § Runtime cost in this
//! directory; not a crate test. To run it, copy this file to
//! `ironhorse-vm/tests/runtime_bench.rs` in each tree being compared (the unpatched tree and
//! one tree per patch group), then in each tree:
//!
//! ```sh
//! CARGO_INCREMENTAL=0 RUST_MIN_STACK=33554432 \
//!   cargo test --release -p ironhorse-vm --test runtime_bench -- --ignored --nocapture --test-threads=1
//! ```
//!
//! One test per workload, so a fixture failure cannot mask the others. Each workload compiles
//! once, checks its result on a warm-up run, then reports the median of 7 runs on a fresh
//! machine (construction and intrinsic linking excluded). Compare `PROTO_METRIC` lines across
//! trees; run each tree more than once and interleave the runs, since a shared host drifts.
use ironhorse_vm::{parse_symbols, Interp};
use std::time::Instant;

fn compile(source: &str) -> (Vec<u8>, Vec<ironhorse_vm::SymbolName>) {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("fixture compiles");
    (bytecode, parse_symbols(&symbols))
}

fn median_run_ms(name: &str, source: &str, expect: &str) {
    let (bytecode, names) = compile(source);
    let mut warm = Interp::new();
    warm.link_intrinsics(&names);
    let o = warm.run(&bytecode);
    assert!(o.completed, "{name}: fixture completes (halt: {:?})", o.halt);
    assert_eq!(o.result, expect, "{name}: fixture result");
    let mut times: Vec<f64> = (0..7)
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
    println!("PROTO_METRIC {name} {:.3}", times[3]);
}

fn median_compile_ms(name: &str, source: &str) {
    match ironhorse_compile::compile_atoms(source) {
        Ok(_) => {}
        Err(e) => panic!("{name}: compile error {e:?}"),
    }
    let mut times: Vec<f64> = (0..7)
        .map(|_| {
            let t0 = Instant::now();
            let r = ironhorse_compile::compile_atoms(source).expect("compiles");
            let dt = t0.elapsed().as_secs_f64() * 1e3;
            std::hint::black_box(r);
            dt
        })
        .collect();
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!("PROTO_METRIC {name} {:.3}", times[3]);
}

macro_rules! run_bench {
    ($fn:ident, $name:literal, $src:expr, $expect:literal) => {
        #[test]
        #[ignore = "benchmark"]
        fn $fn() { median_run_ms($name, $src, $expect); }
    };
}

// A1/A2: pure dispatch loop (no native re-entry).
run_bench!(r01_dispatch, "dispatch",
    "var t = 0; var i = 0; for (i = 0; i < 2000000; i = i + 1) { t = t + (i % 7); } t", "5999995");
// A1: Array.prototype.forEach on a dense array (the thin-dispatch family), 1M callbacks.
run_bench!(r02_foreach, "foreach",
    "var a = []; for (var i = 0; i < 1000; i++) a.push(i); var t = 0; \
     for (var j = 0; j < 1000; j++) { a.forEach(function (x) { t = t + x; }); } t", "499500000");
// A2: native re-entry through an accessor (getter) 1M times.
run_bench!(r03_getter, "getter",
    "var o = { get x() { return 3; } }; var t = 0; \
     for (var i = 0; i < 1000000; i++) { t = t + o.x; } t", "3000000");
// A2: native re-entry through a callback from a native (Array.prototype.map).
run_bench!(r04_map, "map",
    "var a = []; for (var i = 0; i < 1000; i++) a.push(i); var t = 0; \
     for (var j = 0; j < 1000; j++) { t = t + a.map(function (x) { return x + 1; })[999]; } t", "1000000");
// Guest-to-guest recursion (control; stays inside one dispatch loop).
run_bench!(r05_recursion, "recursion",
    "function f(n) { return n <= 0 ? 0 : 1 + f(n - 1); } var t = 0; \
     for (var i = 0; i < 2000; i++) { t = t + f(300); } t", "600000");
// Ordinary property get/set (B1 touches the common MOP path), 1M iterations.
run_bench!(r06_ordinary, "ordinary_props",
    "var o = { x: 1, y: 2 }, total = 0; for (var i = 0; i < 1000000; i++) { o.x += 1; total += o.y; } total + o.x", "3000001");
// B3: JSON.parse of a nested document (6 deep, ~39 KB), 10 round trips.
run_bench!(r07_json_parse, "json_parse",
    "var leaf = '{\"a\":1,\"b\":[1,2,3],\"c\":\"str\",\"d\":null,\"e\":true}'; \
     var s = leaf; for (var d = 0; d < 6; d++) { s = '{\"k\":' + s + ',\"l\":[' + s + ',' + s + ']}'; } \
     var t = 0; for (var i = 0; i < 10; i++) { t = t + JSON.stringify(JSON.parse(s)).length; } t", "393590");
// B4: Array.prototype.flat on a nested array, depth 3, 30k leaves, 100 reps.
run_bench!(r08_flat, "flat",
    "var a = []; for (var i = 0; i < 100; i++) { var b = []; for (var j = 0; j < 10; j++) { var c = []; \
     for (var k = 0; k < 30; k++) c.push(k); b.push(c); } a.push(b); } \
     var t = 0; for (var r = 0; r < 100; r++) { t = t + a.flat(3).length; } t", "3000000");
// B1: trap-absent Proxy chain, 40 layers, 200k gets.
run_bench!(r09_proxy_chain, "proxy_chain",
    "var o = { x: 5 }; var p = o; for (var i = 0; i < 40; i++) { p = new Proxy(p, {}); } \
     var t = 0; for (var j = 0; j < 200000; j++) { t = t + p.x; } t", "1000000");
// B1 (trap handoff): 40 trap-absent layers over one layer with a get trap.
run_bench!(r10_proxy_chain_trap, "proxy_chain_trap",
    "var o = { x: 5 }; var p = new Proxy(o, { get: function (t, k) { return t[k] + 1; } }); \
     for (var i = 0; i < 40; i++) { p = new Proxy(p, {}); } \
     var t = 0; for (var j = 0; j < 200000; j++) { t = t + p.x; } t", "1200000");
// Single trapped Proxy get/set (the existing dispatch bench's proxy shape), 200k.
run_bench!(r11_proxy_single_trap, "proxy_single_trap",
    "var o = { x: 1 }, total = 0; var p = new Proxy(o, { get(t, k, r) { return Reflect.get(t, k, r) }, \
     set(t, k, v, r) { return Reflect.set(t, k, v, r) } }); \
     for (var i = 0; i < 200000; i++) { p.x = p.x + 1; total += p.x; } total", "20000300000");
// B2: instanceof through a chain of bound functions, 20 deep, 400k checks.
run_bench!(r12_bound_instanceof, "bound_instanceof",
    "function F() {} var b = F; for (var i = 0; i < 20; i++) { b = b.bind(null); } \
     var o = new F(); var t = 0; for (var j = 0; j < 400000; j++) { if (o instanceof b) t = t + 1; } t", "400000");

#[test]
#[ignore = "benchmark"]
fn c01_compile_budget_16k() {
    median_compile_ms("compile_budget_16k", &"if(a00000){b00000;}else{c00000;}".repeat(16000));
}
#[test]
#[ignore = "benchmark"]
fn c02_compile_left_chain_1500() {
    let mut chain = String::from("var x = 1");
    for i in 0..1500 { chain.push_str(&format!(" + {}", i % 10)); }
    chain.push(';');
    median_compile_ms("compile_left_chain_1500", &chain);
}
#[test]
#[ignore = "benchmark"]
fn c03_compile_3k_functions() {
    let mut funcs = String::new();
    for i in 0..3000 {
        funcs.push_str(&format!(
            "function f{i}(a, b) {{ var c = a + b; if (c > 1) {{ for (var i = 0; i < c; i++) {{ c = c - 1; }} }} else {{ c = [a, b, {{ k: c }}]; }} return c; }}\n"
        ));
    }
    median_compile_ms("compile_3k_functions", &funcs);
}
#[test]
#[ignore = "benchmark"]
fn c04_compile_nested_if_200() {
    let mut deep = String::from("var a = 1, b = 0; ");
    for _ in 0..200 { deep.push_str("if (a) { "); }
    deep.push_str("b = 1;");
    for _ in 0..200 { deep.push_str(" }"); }
    median_compile_ms("compile_nested_if_200", &deep);
}
