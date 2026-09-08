//! F065 before/after compiler instrumentation. Run serially in release mode.
use ironhorse_compile::{compile_atoms_goal, parse_computrons, Goal};
use std::hint::black_box;
use std::time::Instant;

#[test]
#[ignore = "compiler growth benchmark: nightly release lane"]
fn compiler_growth() {
    assert!(!cfg!(debug_assertions), "benchmark requires --release");
    let mut failures = Vec::new();
    for (shape, sizes, goal, strict) in [
        (
            "branches",
            &[4000usize, 8000, 16000, 32000][..],
            Goal::Script,
            false,
        ),
        (
            "eval_declarations",
            &[2000usize, 4000, 8000][..],
            Goal::Eval,
            false,
        ),
        (
            "script_declarations",
            &[2000usize, 4000, 8000][..],
            Goal::Script,
            false,
        ),
        (
            "strict_eval_declarations",
            &[2000usize, 4000, 8000][..],
            Goal::Eval,
            true,
        ),
        (
            "function_declarations",
            &[2000usize, 4000, 8000][..],
            Goal::Script,
            false,
        ),
    ] {
        let mut previous: Option<(f64, u64)> = None;
        for &n in sizes {
            let mut source = if shape == "branches" {
                // Fixed-length names keep this at ~1 MB at 32k branches without
                // making the symbol-count limit part of the measured workload.
                "if(a00000){b00000;}else{c00000;}".repeat(n)
            } else {
                (0..n).map(|i| format!("var v{i} = {i};\n")).collect()
            };
            if shape == "function_declarations" {
                source = format!("(function() {{ {source} }})");
            }
            let meter = parse_computrons(&source, strict).expect("fixture parses");
            let mut times = Vec::new();
            let mut expected = None;
            for round in 0..4 {
                let start = Instant::now();
                let result =
                    compile_atoms_goal(black_box(&source), goal, strict).expect("fixture compiles");
                let elapsed = start.elapsed().as_secs_f64();
                assert!(!result.0.is_empty());
                if let Some(ref bytes) = expected {
                    assert_eq!(
                        &result, bytes,
                        "deterministic complete bytecode and symbols"
                    );
                } else {
                    expected = Some(result);
                }
                if round > 0 {
                    times.push(elapsed);
                }
            }
            times.sort_by(f64::total_cmp);
            let elapsed = times[1];
            println!(
                "\nCOMPILER_METRIC {shape} n={n} bytes={} seconds={elapsed:.9} computrons={meter}",
                source.len()
            );
            if let Some((old_time, old_meter)) = previous {
                let time_ratio = elapsed / old_time;
                let meter_ratio = meter as f64 / old_meter as f64;
                println!(
                    "COMPILER_RATIO {shape} n={n} time={time_ratio:.3} meter={meter_ratio:.3}"
                );
                if time_ratio >= 2.5 || meter_ratio >= 2.5 {
                    failures.push(format!(
                        "{shape} n={n}: time={time_ratio:.3}x meter={meter_ratio:.3}x"
                    ));
                }
            }
            previous = Some((elapsed, meter));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
