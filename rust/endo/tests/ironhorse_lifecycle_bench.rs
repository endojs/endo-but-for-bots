//! F176 production entry point, including compilation and default metering.
#![cfg(feature = "ironhorse-engine")]
use endo::ironhorse_engine::engine::Machine;
use std::time::Instant;

#[test]
#[ignore = "production lifecycle benchmark: release timing"]
fn repeated_stateless_evaluations() {
    assert!(!cfg!(debug_assertions));
    for (name, source, expected_result) in [
        ("daemon_scalar", "1", "1"),
        (
            "daemon_intrinsics",
            "Object.keys({a:1}).length + Math.abs(-1)",
            "2",
        ),
    ] {
        let machine = Machine::new();
        let mut times = Vec::new();
        let mut charge = None;
        for round in 0..6 {
            let start = Instant::now();
            for _ in 0..1000 {
                let outcome = machine.evaluate(source, false).unwrap();
                assert!(outcome.completed, "{:?}", outcome.halt);
                assert_eq!(outcome.result, expected_result);
                if let Some(old) = charge {
                    assert_eq!(old, outcome.meter_raw);
                }
                charge = Some(outcome.meter_raw);
            }
            let seconds = start.elapsed().as_secs_f64();
            if round > 0 {
                times.push(seconds);
            }
        }
        times.sort_by(f64::total_cmp);
        println!(
            "LIFECYCLE {name} n=1000 seconds={:.9} raw={}",
            times[2],
            charge.unwrap()
        );
    }
}
