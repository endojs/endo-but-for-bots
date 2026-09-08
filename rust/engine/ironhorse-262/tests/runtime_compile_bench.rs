//! F065 runtime compilation pair. Source construction and outer compilation are excluded.
use ironhorse_262::IronhorseSourceCompiler;
use ironhorse_compile::compile_atoms_with;
use ironhorse_vm::{parse_symbols, Halt, Interp};
use std::{rc::Rc, time::Instant};

#[test]
#[ignore = "runtime compilation performance: serial release run"]
fn runtime_compilation_cost() {
    assert!(!cfg!(debug_assertions));
    for (shape, sizes) in [
        ("eval", &[100usize, 1000, 4000][..]),
        ("function", &[100usize, 1000, 4000][..]),
        ("refusal", &[1000usize, 10000, 1_000_000][..]),
    ] {
        for &n in sizes {
            let payload = if shape == "refusal" {
                format!("/*{}*/1", "x".repeat(n))
            } else {
                format!("{}1", "if(false){0;}".repeat(n))
            };
            let source = if shape == "function" {
                format!("Function({payload:?})()")
            } else {
                format!("eval({payload:?})")
            };
            let (code, symbols) = compile_atoms_with(&source, false).unwrap();
            let names = parse_symbols(&symbols);
            let mut times = Vec::new();
            let mut expected = None;
            for round in 0..6 {
                let mut vm = Interp::new();
                vm.link_intrinsics(&names);
                vm.set_source_compiler(Rc::new(IronhorseSourceCompiler));
                if shape == "refusal" {
                    vm.arm_meter(1, Box::new(|spent| spent <= 32));
                }
                let before = vm.meter_index();
                let start = Instant::now();
                let outcome = vm.run(&code);
                let seconds = start.elapsed().as_secs_f64();
                assert!(outcome.completed || outcome.halt == Halt::MeterAbort);
                if shape != "refusal" {
                    assert!(outcome.completed, "{:?}", outcome.halt);
                    assert_eq!(
                        outcome.result,
                        if shape == "function" {
                            "undefined"
                        } else {
                            "1"
                        }
                    );
                }
                let observation = (vm.meter_index() - before, outcome.completed, outcome.result);
                if let Some(ref old) = expected {
                    assert_eq!(&observation, old);
                }
                expected = Some(observation);
                if round > 0 {
                    times.push(seconds);
                }
            }
            times.sort_by(f64::total_cmp);
            let (raw, completed, _) = expected.unwrap();
            println!(
                "RUNTIME_COMPILE shape={shape} n={n} seconds={:.9} raw={raw} completed={completed}",
                times[2]
            );
        }
    }
}
