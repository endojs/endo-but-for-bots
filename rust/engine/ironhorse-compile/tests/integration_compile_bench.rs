//! Same-fixture integration comparison using the release-4 and release-5 API.
//! Refusal timings measure early termination, not equivalent completed work.
use ironhorse_compile::{compile_atoms_budgeted, compile_atoms_with, CompileError, Goal};
use std::{hint::black_box, time::Instant};

#[test]
#[ignore = "compiler integration timing: serial release run"]
fn integration_compiler_cost() {
    assert!(!cfg!(debug_assertions));
    for (shape, sizes) in [
        ("branches", &[4000usize, 8000, 16000, 32000][..]),
        ("declarations", &[2000usize, 4000, 8000][..]),
        ("refusal", &[1000usize, 10000, 1_000_000][..]),
    ] {
        for &n in sizes {
            let source = match shape {
                "branches" => "if(a00000){b00000;}else{c00000;}".repeat(n),
                "declarations" => (0..n).map(|i| format!("var v{i:05}=1;\n")).collect(),
                _ => format!("/*{}*/1", "x".repeat(n)),
            };
            let refuse = shape == "refusal";
            let expected = (!refuse).then(|| compile_atoms_with(&source, false).unwrap());
            let mut times = Vec::new();
            let mut expected_charge = None;
            for round in 0..6 {
                let mut charged = 0u64;
                let mut callbacks = 0usize;
                let start = Instant::now();
                let result =
                    compile_atoms_budgeted(black_box(&source), Goal::Eval, false, &mut |raw| {
                        charged = charged.checked_add(raw).expect("charge overflow");
                        callbacks += 1;
                        !refuse
                    });
                let seconds = start.elapsed().as_secs_f64();
                if refuse {
                    assert!(matches!(result, Err(CompileError::MeterAbort)));
                    assert_eq!(callbacks, 1, "no callback after refusal");
                } else {
                    let compiled = result.unwrap();
                    assert_eq!(compiled.parse_meter_raw, charged);
                    assert_eq!(compiled.parse_computrons, charged >> 16);
                    assert_eq!(
                        (compiled.bytecode, compiled.symbols),
                        *expected.as_ref().unwrap()
                    );
                }
                assert!(charged > 0);
                if let Some(old) = expected_charge {
                    assert_eq!(charged, old);
                }
                expected_charge = Some(charged);
                if round > 0 {
                    times.push(seconds);
                }
            }
            times.sort_by(f64::total_cmp);
            println!(
                "INTEGRATION_COMPILE shape={shape} n={n} mode={} seconds={:.9} raw={} completed={}",
                if refuse { "refusal" } else { "callback" },
                times[2],
                expected_charge.unwrap(),
                !refuse
            );
        }
    }
}
