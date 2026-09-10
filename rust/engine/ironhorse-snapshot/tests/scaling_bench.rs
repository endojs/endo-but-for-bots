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

/// F044: time exactly 100,000 indexed calls at identical dispatch/raw-meter
/// counts. Receiver construction and relinking are outside the measured crank.
#[test]
#[ignore = "receiver-length benchmark: nightly release lane"]
fn string_receiver_indexing_is_independent_of_receiver_length() {
    assert!(!cfg!(debug_assertions), "benchmark requires --release");
    let mut failures = Vec::new();
    for (name, expression) in [
        ("char_code_at", "s.charCodeAt(0) === 97"),
        ("code_point_at", "s.codePointAt(0) === 97"),
        ("char_at", "s.charAt(0) === 'a'"),
        ("at", "s.at(0) === 'a'"),
        ("starts_with", "s.startsWith('a')"),
        ("ends_with", "s.endsWith('a')"),
        ("includes", "s.includes('a')"),
        ("index_of", "s.indexOf('a') === 0"),
        ("last_index_of", "s.lastIndexOf('a', 0) === 0"),
        ("property", "s[0] === 'a'"),
    ] {
        let hot = format!("var count = 0; for (var i = 0; i < 100000; i++) {{ if ({expression}) count++; }} count");
        let (hot_code, hot_symbols) = ironhorse_compile::compile_atoms(&hot).unwrap();
        let hot_names = parse_symbols(&hot_symbols);
        let mut first_time = None;
        let mut expected_cost = None;
        for n in [16, 256, 1024, 4096] {
            let build = format!("var s = '{}';", "a".repeat(n));
            let (build_code, build_symbols) = ironhorse_compile::compile_atoms(&build).unwrap();
            let build_names = parse_symbols(&build_symbols);
            let mut times = Vec::new();
            let mut cost = (0, 0);
            for round in 0..6 {
                let mut machine = Interp::new();
                machine.link_intrinsics(&build_names);
                let setup = machine.run(&build_code);
                assert!(setup.completed);
                let code = machine.relink_crank(&hot_code, &hot_names).unwrap();
                let before = machine.meter_index();
                let start = Instant::now();
                let outcome = machine.run(&code);
                let elapsed = start.elapsed().as_secs_f64();
                assert!(outcome.completed, "{:?}", outcome.halt);
                assert_eq!(outcome.result, "100000");
                cost = (
                    outcome.meter_raw - before,
                    outcome.dispatched - setup.dispatched,
                );
                if let Some(expected) = expected_cost {
                    assert_eq!(
                        cost, expected,
                        "{name}: receiver length must not affect metered work"
                    );
                } else {
                    expected_cost = Some(cost);
                }
                if round > 0 {
                    times.push(elapsed);
                }
            }
            times.sort_by(f64::total_cmp);
            let elapsed = times[2];
            println!(
                "\nSTRING_INDEX_METRIC {name} n={n} seconds={elapsed:.9} raw={} dispatched={}",
                cost.0, cost.1
            );
            if let Some(first) = first_time {
                if elapsed / first >= 2.5 {
                    failures.push(format!(
                        "{name} n={n}: {:.3}x first length",
                        elapsed / first
                    ));
                }
            } else {
                first_time = Some(elapsed);
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// F044 attached path: large receivers cover 1–32 extents. The first timed
/// crank starts cold; subsequent cranks read resident extents on that machine.
#[test]
#[ignore = "lazy receiver-length benchmark: nightly release lane"]
fn lazy_string_indexing_spans_many_extents() {
    use ironhorse_snapshot::{
        machine::{begin_store_session, resume_from_store_lazy},
        store::MemoryStore,
        Signature,
    };
    use std::{cell::RefCell, rc::Rc};
    assert!(!cfg!(debug_assertions));
    let mut failures = Vec::new();
    for (name, expression) in [
        ("char_code_at", "s.charCodeAt(0) === 97"),
        ("property", "s[0] === 'a'"),
    ] {
        let hot = format!(
            "var count = 0; for (var i=0;i<1000;i++) {{ if ({expression}) count++; }} count"
        );
        let (hot_code, hot_symbols) = ironhorse_compile::compile_atoms(&hot).unwrap();
        let names = parse_symbols(&hot_symbols);
        let mut first: Option<[f64; 2]> = None;
        let mut expected_cost = [None; 2];
        for n in [32768, 65536, 262144, 1048576] {
            let (build, symbols) =
                ironhorse_compile::compile_atoms(&format!("var s='{}';", "a".repeat(n))).unwrap();
            let mut times = [Vec::new(), Vec::new()];
            let mut measured_cost = [0; 2];
            for sample in 0..6 {
                let mut machine = Interp::new();
                machine.link_intrinsics(&parse_symbols(&symbols));
                assert!(machine.run(&build).completed);
                let code = machine.relink_crank(&hot_code, &names).unwrap();
                let signature = Signature::new("lazy-string-indexing");
                let mut store = MemoryStore::new();
                begin_store_session(machine, &signature, &mut store)
                    .map_err(|(_, error)| error)
                    .unwrap();
                let mut machine = resume_from_store_lazy(Rc::new(RefCell::new(store)), &signature)
                    .unwrap()
                    .into_machine();
                for (arm, readings) in times.iter_mut().enumerate() {
                    let before = machine.meter_index();
                    let start = Instant::now();
                    let out = machine.run(&code);
                    let elapsed = start.elapsed().as_secs_f64();
                    assert!(out.completed, "{:?}", out.halt);
                    assert_eq!(out.result, "1000");
                    measured_cost[arm] = out.meter_raw - before;
                    if let Some(expected) = expected_cost[arm] {
                        assert_eq!(measured_cost[arm], expected);
                    } else {
                        expected_cost[arm] = Some(measured_cost[arm]);
                    }
                    if sample > 0 {
                        readings.push(elapsed);
                    }
                }
            }
            let mut medians = [0.0; 2];
            for (i, readings) in times.iter_mut().enumerate() {
                readings.sort_by(f64::total_cmp);
                medians[i] = readings[2];
                println!(
                    "\nLAZY_STRING_METRIC {name}_{} n={n} seconds={:.9} raw={}",
                    if i == 0 { "cold" } else { "resident" },
                    medians[i],
                    measured_cost[i]
                );
            }
            if let Some(small) = first {
                for i in 0..2 {
                    if medians[i] / small[i] >= 2.5 {
                        failures.push(format!(
                            "{name} n={n} arm={i}: {:.3}x",
                            medians[i] / small[i]
                        ));
                    }
                }
            } else {
                first = Some(medians);
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// Separates iterator traversal from object construction, whose named-property
/// insertion currently has its own quadratic cost. The end-to-end gate above
/// deliberately retains construction and remains strict about that regression.
#[test]
#[ignore = "iterator-phase benchmark: nightly release lane"]
fn for_in_traversal_scales_after_construction() {
    assert!(!cfg!(debug_assertions), "benchmark requires --release");
    let mut previous: Option<(f64, u64)> = None;
    let mut failures = Vec::new();
    for n in [2000, 4000, 8000, 16000] {
        let build = format!("var o = {{}}; for (var i = 0; i < {n}; i++) {{ o['k' + i] = i; }} 0");
        let hot = "var count = 0; for (var k in o) { count++; } count";
        let (build_code, symbols) = ironhorse_compile::compile_atoms(&build).unwrap();
        let mut machine = Interp::new();
        machine.link_intrinsics(&parse_symbols(&symbols));
        let build_start = Instant::now();
        let built = machine.run(&build_code);
        assert!(built.completed);
        let mut dispatched_before = built.dispatched;
        let build_seconds = build_start.elapsed().as_secs_f64();
        let (hot_code, symbols) = ironhorse_compile::compile_atoms(hot).unwrap();
        let hot_code = machine
            .relink_crank(&hot_code, &parse_symbols(&symbols))
            .unwrap();
        let mut times = Vec::new();
        let mut cost = None;
        for round in 0..8 {
            let before = machine.meter_index();
            let start = Instant::now();
            let outcome = machine.run(&hot_code);
            let elapsed = start.elapsed().as_secs_f64();
            assert!(outcome.completed, "{:?}", outcome.halt);
            assert_eq!(outcome.result, n.to_string());
            if round > 0 {
                let current = (
                    outcome.meter_raw - before,
                    outcome.dispatched - dispatched_before,
                );
                if let Some(old) = cost {
                    assert_eq!(old, current);
                }
                cost = Some(current);
                times.push(elapsed);
            }
            dispatched_before = outcome.dispatched;
        }
        times.sort_by(f64::total_cmp);
        let seconds = times[3];
        let (raw, dispatched) = cost.unwrap();
        println!("ITERATION_PHASE for_in n={n} seconds={seconds:.9} build_seconds={build_seconds:.9} raw={raw} dispatched={dispatched}");
        if let Some((old_time, old_raw)) = previous {
            let time_ratio = seconds / old_time;
            let meter_ratio = raw as f64 / old_raw as f64;
            if time_ratio >= 2.5 || meter_ratio >= 2.5 {
                failures.push(format!(
                    "n={n}: time={time_ratio:.3}x meter={meter_ratio:.3}x"
                ));
            }
        }
        previous = Some((seconds, raw));
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
