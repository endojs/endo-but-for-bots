//! Growth-class gates for F044/F045. Run in release mode on the nightly lane.
//! Raw total times (not time per element) and computrons must both grow by
//! less than 2.5x per input doubling. Known regressions intentionally fail.
use ironhorse_vm::{parse_symbols, Interp};
use std::time::Instant;

fn sample(source: &str, expected: &str) -> (f64, u64) {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).expect("fixture compiles");
    let names = parse_symbols(&symbols);
    let mut times = Vec::new();
    let mut meter = None;
    for round in 0..8 {
        let mut machine = Interp::new();
        machine.link_intrinsics(&names);
        let start = Instant::now();
        let outcome = machine.run(&code);
        let elapsed = start.elapsed().as_secs_f64();
        assert!(outcome.completed, "{:?}", outcome.halt);
        assert_eq!(outcome.result, expected);
        if let Some(previous) = meter {
            assert_eq!(outcome.computrons, previous, "deterministic meter");
        }
        meter = Some(outcome.computrons);
        if round > 0 {
            times.push(elapsed);
        }
    }
    times.sort_by(f64::total_cmp);
    (times[3], meter.unwrap())
}

#[test]
#[ignore = "growth-class benchmark: nightly release lane"]
fn time_and_computrons_scale_together() {
    assert!(!cfg!(debug_assertions), "scaling requires --release");
    let mut failures = Vec::new();
    for (name, sizes) in [
        ("char_code_at", [4096, 8192, 16384, 32768]),
        ("map_set", [1000, 2000, 4000, 8000]),
        ("for_in", [2000, 4000, 8000, 16000]),
        ("string_for_of", [16384, 32768, 65536, 131072]),
    ] {
        let mut previous: Option<(f64, u64)> = None;
        for n in sizes {
            let (source, expected) = match name {
                "char_code_at" => (format!("var s = 'x'.repeat({n}); var sum = 0; for (var i = 0; i < {n}; i++) {{ sum += s.charCodeAt(i); }} sum"), (n * 120).to_string()),
                "map_set" => (format!("var m = new Map(); for (var i = 0; i < {n}; i++) {{ m.set(i, i); }} m.size"), n.to_string()),
                "for_in" => (format!("var o = {{}}; for (var i = 0; i < {n}; i++) {{ o['k' + i] = i; }} var count = 0; for (var k in o) {{ count++; }} count"), n.to_string()),
                "string_for_of" => (format!("var s = 'x'.repeat({n}); var count = 0; for (var c of s) {{ count++; }} count"), n.to_string()),
                _ => unreachable!(),
            };
            let current = sample(&source, &expected);
            println!(
                "SCALING {name} n={n} seconds={:.9} computrons={}",
                current.0, current.1
            );
            if let Some(old) = previous {
                let time_ratio = current.0 / old.0;
                let meter_ratio = current.1 as f64 / old.1 as f64;
                println!("SCALING_RATIO {name} n={n} time={time_ratio:.3} meter={meter_ratio:.3}");
                if time_ratio >= 2.5 || meter_ratio >= 2.5 {
                    failures.push(format!("{name} n={n}: time={time_ratio:.3}x meter={meter_ratio:.3}x; both must be <2.5x"));
                }
            }
            previous = Some(current);
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
