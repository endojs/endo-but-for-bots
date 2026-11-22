//! Serial release micro roster for interpreter fast paths.
//!
//! Each workload isolates one hot interpreter path (integer and float
//! arithmetic, relational loops, property get/set, array and typed-array
//! element access, string concatenation and indexing, calls, closures,
//! method calls, collections, JSON, prototype methods, constructors). The
//! `_fn` twins run the same loop over function locals instead of
//! global-object `var`s.
//!
//! Ignored under plain `cargo test`; run it explicitly in release:
//!
//! ```sh
//! cargo test --release -p ironhorse-vm --test porffor_micro_bench -- \
//!   --ignored --nocapture --test-threads=1
//! ```
//!
//! Environment: `MICRO_ONLY=<name>[,<name>...]` runs only those workloads; `MICRO_SAMPLES=<n>`
//! sets the timed samples after one warm-up (default 5, and 0 runs only the
//! warm-up, which suits instruction counting); `MICRO_DISASM=1` prints the
//! bytecode; `MICRO_PLAIN=1` turns dispatch fusion off
//! ([`Interp::set_dispatch_fusion`]), so one binary measures both. Built
//! with the `dispatch-census` feature, the roster also prints each
//! workload's most frequent straight-line opcode n-grams (`CENSUS` lines,
//! from the warm-up run). Every run asserts the expected result and that the computrons,
//! dispatch count and raw meter index are identical across samples. The
//! `MICRO` lines carry those totals so two builds can be diffed for cost
//! invariance.
use ironhorse_vm::{parse_symbols, Interp};
use std::time::Instant;

const WORKLOADS: &[(&str, &str, &str)] = &[
    (
        "int_loop",
        "var t = 0; for (var i = 0; i < 1000000; i++) { t = (t + i * 3 - (i >> 1)) | 0; } t",
        "163516864",
    ),
    (
        "float_arith",
        "var x = 0.5; var s = 0; for (var i = 0; i < 300000; i++) { x = x * 1.000001 + 0.25; s = s + x / 3.5; } s > 0 ? 1 : 0",
        "1",
    ),
    (
        "prop_getset",
        "var o = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 }; for (var i = 0; i < 300000; i++) { o.f = o.a + o.e; o.a = o.f - o.e + 1; } o.a",
        "300001",
    ),
    (
        "array_rw_push",
        "var a = []; for (var i = 0; i < 100000; i++) { a.push(i); } var s = 0; for (var j = 0; j < 3; j++) { for (var i = 0; i < a.length; i++) { a[i] = a[i] + 1; s += a[i]; } } s",
        "15000450000",
    ),
    (
        "string_concat",
        "var s = ''; for (var i = 0; i < 5000; i++) { s += 'ab'; } s.length",
        "10000",
    ),
    (
        "string_charcode",
        "var s = 'abcdefghijklmnopqrstuvwxyz0123456789'; s = s + s + s + s; var t = 0; for (var i = 0; i < 200000; i++) { t += s.charCodeAt(i % s.length); } t",
        "18733590",
    ),
    (
        "string_index",
        "var s = 'abcdefghijklmnopqrstuvwxyz0123456789'; s = s + s + s + s; var t = 0; for (var i = 0; i < 200000; i++) { if (s[i % 144] === 'a') t++; } t",
        "5556",
    ),
    (
        "func_calls",
        "function add(a, b) { return a + b; } var t = 0; for (var i = 0; i < 300000; i++) { t = add(t, i) % 1000003; } t",
        "715003",
    ),
    (
        "closures",
        "function mk(k) { return function (x) { return x + k; }; } var f = mk(3); var t = 0; for (var i = 0; i < 300000; i++) { t = f(t) % 1000003; } t",
        "900000",
    ),
    (
        "method_calls",
        "function P(x) { this.x = x; } P.prototype.inc = function (d) { this.x = this.x + d; return this; }; var p = new P(0); for (var i = 0; i < 300000; i++) { p.inc(2); } p.x",
        "600000",
    ),
    (
        "map_set",
        "var m = new Map(); var st = new Set(); for (var i = 0; i < 50000; i++) { m.set(i, i * 2); st.add(i & 1023); } var s = 0; for (var i = 0; i < 50000; i++) { s += m.get(i); } s + st.size",
        "2499951024",
    ),
    (
        "typed_array",
        "var a = new Int32Array(10000); var s = 0; for (var r = 0; r < 20; r++) { for (var i = 0; i < 10000; i++) { a[i] = a[i] + i; s = (s + a[i]) | 0; } } s",
        "1909015408",
    ),
    (
        "json",
        "var o = { a: [1, 2, 3, { b: 'xyz', c: true }], d: 'hello world', e: 12.5 }; var n = 0; for (var i = 0; i < 5000; i++) { n += JSON.parse(JSON.stringify(o)).a.length; } n",
        "20000",
    ),
    // Function-scoped twins: locals instead of global-object `var`s.
    (
        "int_loop_fn",
        "(function () { var t = 0; for (var i = 0; i < 1000000; i++) { t = (t + i * 3 - (i >> 1)) | 0; } return t; })()",
        "163516864",
    ),
    (
        "empty_loop_fn",
        "(function () { var i = 0; for (i = 0; i < 1000000; i++) { } return i; })()",
        "1000000",
    ),
    (
        "prop_getset_fn",
        "(function () { var o = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 }; for (var i = 0; i < 300000; i++) { o.f = o.a + o.e; o.a = o.f - o.e + 1; } return o.a; })()",
        "300001",
    ),
    (
        "array_rw_fn",
        "(function () { var a = []; for (var i = 0; i < 100000; i++) { a.push(i); } var s = 0; for (var j = 0; j < 3; j++) { for (var i = 0; i < a.length; i++) { a[i] = a[i] + 1; s += a[i]; } } return s; })()",
        "15000450000",
    ),
    (
        "string_charcode_fn",
        "(function () { var s = 'abcdefghijklmnopqrstuvwxyz0123456789'; s = s + s + s + s; var t = 0; for (var i = 0; i < 200000; i++) { t += s.charCodeAt(i % 144); } return t; })()",
        "18733590",
    ),
    (
        "func_calls_fn",
        "(function () { function add(a, b) { return a + b; } var t = 0; for (var i = 0; i < 300000; i++) { t = add(t, i) % 1000003; } return t; })()",
        "715003",
    ),
    (
        "method_calls_fn",
        "(function () { function P(x) { this.x = x; } P.prototype.inc = function (d) { this.x = this.x + d; return this; }; var p = new P(0); for (var i = 0; i < 300000; i++) { p.inc(2); } return p.x; })()",
        "600000",
    ),
    (
        "typed_array_fn",
        "(function () { var a = new Int32Array(10000); var s = 0; for (var r = 0; r < 20; r++) { for (var i = 0; i < 10000; i++) { a[i] = a[i] + i; s = (s + a[i]) | 0; } } return s; })()",
        "1909015408",
    ),
    // Property and array access shapes the roster above lacks: a method
    // found two prototypes up, index stores that create elements (not
    // `push`), out-of-range index reads, and a constructor creating own
    // properties.
    (
        "proto_method_fn",
        "(function () { class A { constructor() { this.v = 1; } get1() { return this.v; } } class B extends A {} class C extends B {} var c = new C(); var t = 0; for (var i = 0; i < 300000; i++) { t += c.get1(); } return t; })()",
        "300000",
    ),
    (
        "array_fill_sum_fn",
        "(function () { var a = []; for (var i = 0; i < 100000; i++) { a[i] = i; } var s = 0; for (var j = 0; j < 3; j++) { for (var i = 0; i < 100000; i++) { s += a[i]; } } return s; })()",
        "14999850000",
    ),
    (
        "array_hole_fn",
        "(function () { var a = [1, 2, 3]; var t = 0; for (var i = 0; i < 300000; i++) { if (a[i & 7] === undefined) t++; } return t; })()",
        "187500",
    ),
    (
        "ctor_fn",
        "(function () { function P(x, y) { this.x = x; this.y = y; this.z = x + y; } var t = 0; for (var i = 0; i < 100000; i++) { var p = new P(i, 1); t += p.z; } return t; })()",
        "5000050000",
    ),
];

#[test]
#[ignore = "serial micro timing roster"]
fn porffor_micro() {
    assert!(!cfg!(debug_assertions));
    let only = std::env::var("MICRO_ONLY").ok();
    let samples: usize = std::env::var("MICRO_SAMPLES")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(5);
    let disasm = std::env::var("MICRO_DISASM").is_ok();
    let plain = std::env::var("MICRO_PLAIN").is_ok();
    for (name, source, expected) in WORKLOADS {
        if only
            .as_deref()
            .is_some_and(|o| !o.split(',').any(|n| n == *name))
        {
            continue;
        }
        let (code, symbols) = ironhorse_compile::compile_atoms(source).expect("compiles");
        let symbols = parse_symbols(&symbols);
        if disasm {
            for (pc, op) in ironhorse_vm::disassemble(&code) {
                println!("DISASM {pc:5} {op}");
            }
        }
        let mut times = Vec::new();
        let mut totals = None;
        for round in 0..=samples {
            let mut vm = Interp::new();
            if plain {
                vm.set_dispatch_fusion(false);
            }
            vm.link_intrinsics(&symbols);
            let start = Instant::now();
            let outcome = vm.run(&code);
            let ms = start.elapsed().as_secs_f64() * 1e3;
            assert!(outcome.completed, "{name}: {:?}", outcome.halt);
            assert_eq!(outcome.result, *expected, "{name}");
            let run_totals = (
                outcome.computrons_this_run,
                outcome.dispatched_this_run,
                vm.meter_index(),
            );
            if let Some(previous) = totals {
                assert_eq!(run_totals, previous, "{name}: cost drifted across samples");
            }
            totals = Some(run_totals);
            if round > 0 {
                times.push(ms);
            }
            #[cfg(feature = "dispatch-census")]
            if round == 0 {
                print_census(name, &vm, outcome.dispatched_this_run);
            }
        }
        let (computrons, dispatched, raw) = totals.expect("at least one run");
        if times.is_empty() {
            println!("MICRO {name} computrons={computrons} dispatched={dispatched} raw={raw}");
            continue;
        }
        times.sort_by(f64::total_cmp);
        let median = times[times.len() / 2];
        println!(
            "MICRO {name} median_ms={median:.3} min_ms={:.3} max_ms={:.3} computrons={computrons} dispatched={dispatched} raw={raw} ns_per_op={:.2}",
            times[0],
            times[times.len() - 1],
            median * 1e6 / dispatched as f64
        );
    }
}

/// The `CENSUS <workload> <n> <count> <share> <ops>` lines: the 12 most
/// frequent straight-line n-grams for each length, with their share of the
/// run's dispatches.
#[cfg(feature = "dispatch-census")]
fn print_census(name: &str, vm: &Interp, dispatched: u64) {
    for n in 2..=ironhorse_vm::cost::CENSUS_MAX_GRAM {
        for row in vm.cost_recorder().census(n).into_iter().take(12) {
            println!(
                "CENSUS {name} {n} {} {:.4} {}",
                row.count,
                row.count as f64 * n as f64 / dispatched as f64,
                row.ops.join(",")
            );
        }
    }
}
