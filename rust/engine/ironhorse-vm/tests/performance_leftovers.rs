//! Oracle-free fixed-work measurements for the remaining F044/F120 paths.
use ironhorse_vm::{parse_symbols, Interp};
use std::time::Instant;

fn measure(setup: &str, source: &str, expected: &str) -> (f64, u64, u64) {
    let (setup_code, setup_symbols) = ironhorse_compile::compile_atoms(setup).unwrap();
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    let mut samples = Vec::new();
    let mut receipt = None;
    for round in 0..6 {
        let mut vm = Interp::new();
        vm.link_intrinsics(&parse_symbols(&setup_symbols));
        assert!(vm.run(&setup_code).completed);
        let code = vm.relink_crank(&code, &parse_symbols(&symbols)).unwrap();
        let raw_before = vm.meter_index();
        let start = Instant::now();
        let out = vm.run(&code);
        let seconds = start.elapsed().as_secs_f64();
        assert!(out.completed, "{:?}", out.halt);
        assert_eq!(out.result, expected);
        let current = (vm.meter_index() - raw_before, out.dispatched);
        if let Some(previous) = receipt {
            assert_eq!(current, previous);
        }
        receipt = Some(current);
        if round != 0 {
            samples.push(seconds);
        }
    }
    samples.sort_by(f64::total_cmp);
    let (raw, dispatches) = receipt.unwrap();
    (samples[2], raw, dispatches)
}

#[test]
#[ignore = "serial release performance measurement"]
fn bounded_string_slices() {
    assert!(!cfg!(debug_assertions));
    for method in ["slice", "substring"] {
        for length in [16, 4096, 1_048_576] {
            let setup = format!("var s='x'.repeat({length});");
            let source =
                format!("var result; for(var i=0;i<1000;i++) result=s.{method}(0,1); result");
            let (seconds, raw, dispatches) = measure(&setup, &source, "x");
            println!("LEFTOVER_METRIC {method}_{length} seconds={seconds:.9} raw={raw} dispatches={dispatches}");
        }
    }
}

#[test]
#[ignore = "serial release performance measurement"]
fn catch_entry_local_count() {
    assert!(!cfg!(debug_assertions));
    for count in [2, 50, 200, 400] {
        let declarations: String = (0..count).map(|i| format!("var local{i}={i};")).collect();
        for catching in [false, true] {
            let body = if catching {
                "try { total++; } catch(e) { total=-1; }"
            } else {
                "total++;"
            };
            let source = format!("function f(){{{declarations} var total=0; for(var i=0;i<100000;i++){{{body}}} return total;}} f()");
            let (seconds, raw, dispatches) = measure("0", &source, "100000");
            println!("LEFTOVER_METRIC catch_{catching}_{count} seconds={seconds:.9} raw={raw} dispatches={dispatches}");
        }
    }
}
