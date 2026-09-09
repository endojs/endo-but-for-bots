//! Microbenchmark comparison, not the complete stage-8 daemon/footprint envelope.
use std::time::Instant;

struct Sample {
    compile_ns: f64,
    execute_ns: f64,
}

fn ironhorse(source: &str, expected: &str) -> Sample {
    let started = Instant::now();
    let (code, symbols) = ironhorse_compile::compile_atoms_with(source, false).unwrap();
    let compile_ns = started.elapsed().as_secs_f64() * 1e9;
    let mut machine = ironhorse_vm::Interp::new();
    let names = ironhorse_vm::parse_symbols(&symbols);
    // Runtime preparation/linking is included; machine creation is excluded.
    let started = Instant::now();
    machine.link_intrinsics(&names);
    let result = machine.run(&code);
    let execute_ns = started.elapsed().as_secs_f64() * 1e9;
    assert!(result.completed, "{result:?}");
    assert_eq!(result.result, expected);
    Sample {
        compile_ns,
        execute_ns,
    }
}

fn xs(source: &str, expected: &str) -> Sample {
    let (result, timing) = xs_oracle::run_timed(source).expect("XS starts");
    assert!(result.completed && !result.result_truncated, "{result:?}");
    assert_eq!(result.result, expected);
    assert!(timing.compile_ns > 0 && timing.execute_ns > 0, "{timing:?}");
    Sample {
        compile_ns: timing.compile_ns as f64,
        execute_ns: timing.execute_ns as f64,
    }
}

fn median(values: &[f64]) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    sorted[sorted.len() / 2]
}

#[test]
#[ignore = "XS microbenchmark: run serially in release mode"]
fn compare_xs_microbenchmarks() {
    assert!(!cfg!(debug_assertions), "release measurements only");
    let parse = format!("{}42", "if(false){var branch = 1;}".repeat(2000));
    let fixtures = [
        ("parse", parse.as_str(), "42", true),
        (
            "properties",
            "var o = {x: 1}; for(var i=0;i<20000;i++) o.x += 1; o.x",
            "20001",
            false,
        ),
        (
            "calls",
            "function f(x) { return x + 1; } var n=0; for(var i=0;i<20000;i++) n=f(n); n",
            "20000",
            false,
        ),
        (
            "allocation_churn",
            "var n=0; for(var i=0;i<10000;i++) {var o={a:i,b:i+1}; n+=o.b;} n",
            "50005000",
            false,
        ),
        (
            "strings",
            "var s='abcXYZ'; var n=0; for(var i=0;i<20000;i++) n+=s.charCodeAt(i%6); n",
            "1870008",
            false,
        ),
    ];
    let mut log_ratios = Vec::new();
    for (name, source, expected, compile) in fixtures {
        let mut reference = Vec::new();
        let mut candidate = Vec::new();
        for round in 0..8 {
            let (a, b) = if round % 2 == 0 {
                let a = xs(source, expected);
                (a, ironhorse(source, expected))
            } else {
                let b = ironhorse(source, expected);
                (xs(source, expected), b)
            };
            if round != 0 {
                reference.push(if compile { a.compile_ns } else { a.execute_ns });
                candidate.push(if compile { b.compile_ns } else { b.execute_ns });
            }
        }
        let a = median(&reference);
        let b = median(&candidate);
        let ratio = b / a;
        assert!(ratio.is_finite() && ratio > 0.0);
        println!("XS_MICRO {name} xs_ns={a:.0} ironhorse_ns={b:.0} ratio={ratio:.6}");
        println!("XS_SAMPLES {name} xs={reference:?} ironhorse={candidate:?}");
        log_ratios.push(ratio.ln());
    }
    let geometric_mean = (log_ratios.iter().sum::<f64>() / log_ratios.len() as f64).exp();
    println!(
        "XS_MICRO_ENVELOPE geometric_mean={geometric_mean:.6} limit=2.0 within_limit={}",
        geometric_mean <= 2.0
    );
    println!("STAGE8_ENVELOPE unavailable: daemon arm and comparable heap/code footprint are not measured");
}
