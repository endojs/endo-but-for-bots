//! Budgeted compiler overhead and refusal timing; source construction excluded.
#[path = "common/compiler_growth.rs"]
mod compiler_growth;
use ironhorse_compile::{compile_atoms_with, compile_atoms_with_budget, ParseErrorKind};
use std::time::Instant;

#[test]
#[ignore = "compiler budget timing: serial release run"]
fn budgeted_compiler_cost() {
    assert!(!cfg!(debug_assertions));
    let mut previous = [None; 3];
    let mut failures = Vec::new();
    let sizes = [4000, 8000, 16000, 32000];
    let mut elapsed_samples: [Vec<(usize, f64)>; 3] = std::array::from_fn(|_| Vec::new());
    for n in sizes {
        let source = "if(a00000){b00000;}else{c00000;}".repeat(n);
        let expected = compile_atoms_with(&source, false).unwrap();
        let mut budgeted_raw = None;
        for (mode_index, mode) in ["legacy", "budgeted", "callback"].into_iter().enumerate() {
            let mut times = Vec::new();
            let mut expected_raw = None;
            for round in 0..6 {
                let mut callback_raw = None;
                let start = Instant::now();
                let (result, raw) = if mode == "callback" {
                    let mut charged = 0;
                    let meter =
                        ironhorse_compile::ParseMeter::with_charge_callback(u64::MAX, |raw| {
                            charged += raw;
                            true
                        });
                    let result =
                        ironhorse_compile::compile_atoms_with_meter(&source, false, meter.clone())
                            .unwrap();
                    let raw = meter.raw();
                    drop(meter);
                    callback_raw = Some(charged);
                    (result, raw)
                } else if mode == "budgeted" {
                    let report = compile_atoms_with_budget(&source, false, u64::MAX);
                    (report.result.unwrap(), report.parse_meter_raw)
                } else {
                    (compile_atoms_with(&source, false).unwrap(), 0)
                };
                let seconds = start.elapsed().as_secs_f64();
                if let Some(charged) = callback_raw {
                    assert_eq!(raw, charged);
                }
                assert_eq!(result, expected);
                if let Some(old) = expected_raw {
                    assert_eq!(old, raw);
                }
                expected_raw = Some(raw);
                if round > 0 {
                    times.push(seconds);
                }
            }
            times.sort_by(f64::total_cmp);
            println!(
                "COMPILE_BUDGET n={n} mode={mode} seconds={:.9} raw={}",
                times[2],
                expected_raw.unwrap()
            );
            elapsed_samples[mode_index].push((n, times[2]));
            let raw = expected_raw.unwrap();
            if mode == "budgeted" {
                budgeted_raw = Some(raw);
            } else if mode == "callback" {
                assert_eq!(Some(raw), budgeted_raw);
            }
            if let Some((old_time, old_raw)) = previous[mode_index] {
                let time_ratio = times[2] / old_time;
                let meter_ratio = if old_raw == 0 {
                    1.0
                } else {
                    raw as f64 / old_raw as f64
                };
                println!("COMPILE_BUDGET_RATIO n={n} mode={mode} time={time_ratio:.3} meter={meter_ratio:.3}");
                if meter_ratio >= 2.5 {
                    failures.push(format!(
                        "{mode} n={n}: time={time_ratio:.3}x meter={meter_ratio:.3}x"
                    ));
                }
            }
            previous[mode_index] = Some((times[2], raw));
        }
    }
    for (mode, samples) in ["legacy", "budgeted", "callback"]
        .into_iter()
        .zip(&elapsed_samples)
    {
        match compiler_growth::check(&sizes, samples) {
            Ok(growth) => println!(
                "COMPILE_BUDGET_FULL_RANGE mode={mode} time={:.6} limit={:.6}",
                growth.full_ratio, growth.limit
            ),
            Err(error) => failures.push(format!("{mode}: {error}")),
        }
    }
    for n in [1000, 10000, 1_000_000] {
        let source = format!("/*{}*/1", "x".repeat(n));
        for bounded in [false, true] {
            let mut times = Vec::new();
            for round in 0..8 {
                let start = Instant::now();
                if bounded {
                    let report = compile_atoms_with_budget(&source, false, 32 << 16);
                    assert_eq!(report.result.unwrap_err().kind, ParseErrorKind::MeterLimit);
                    assert_eq!(report.parse_meter_raw, 32 << 16);
                } else {
                    compile_atoms_with(&source, false).unwrap();
                }
                let seconds = start.elapsed().as_secs_f64();
                if round > 0 {
                    times.push(seconds);
                }
            }
            times.sort_by(f64::total_cmp);
            println!(
                "COMPILE_ADMISSION n={n} bounded={bounded} seconds={:.9}",
                times[3]
            );
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
