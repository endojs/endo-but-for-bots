//! F176: bytecode ownership and fresh-realm evaluation overhead.
use ironhorse_vm::{parse_symbols, Compartment, Interp, Machine, RunOutcome};
use std::rc::Rc;
use std::time::Instant;

// Baseline adapter: the identical fixture runs on revisions preceding the
// shared-buffer API. Once the inherent method exists, Rust resolves to it.
#[allow(dead_code)]
trait SharedRunBaseline {
    fn run_shared(&mut self, code: Rc<[u8]>) -> RunOutcome;
}
impl SharedRunBaseline for Interp {
    fn run_shared(&mut self, code: Rc<[u8]>) -> RunOutcome {
        self.run(&code)
    }
}

#[test]
#[ignore = "lifecycle benchmark: release timing"]
fn repeated_shared_bytecode_and_fresh_realms() {
    assert!(!cfg!(debug_assertions));
    let (short, symbols) = ironhorse_compile::compile_atoms("1").unwrap();
    let names = parse_symbols(&symbols);
    let mut shortest: Option<f64> = None;
    let mut failures = Vec::new();
    for bytes in [short.len(), 4096, 1_048_576, 8_388_608] {
        let mut padded = short.clone();
        padded.resize(bytes, 0); // Unreachable bytes after the program's END.
        let code: Rc<[u8]> = padded.into();
        let mut interp = Interp::new();
        interp.link_intrinsics(&names);
        let mut times = Vec::new();
        let mut expected = None;
        for round in 0..6 {
            let raw = interp.meter_index();
            let start = Instant::now();
            let mut last = None;
            for _ in 0..1000 {
                last = Some(interp.run_shared(code.clone()));
            }
            let seconds = start.elapsed().as_secs_f64();
            let last = last.unwrap();
            assert!(last.completed, "{:?}", last.halt);
            assert_eq!(last.result, "1");
            let charge = last.meter_raw - raw;
            if let Some(old) = expected {
                assert_eq!(old, charge);
            }
            expected = Some(charge);
            if round > 0 {
                times.push(seconds);
            }
        }
        times.sort_by(f64::total_cmp);
        if let Some(base) = shortest {
            if times[2] / base >= 2.5 {
                failures.push(format!("shared n={bytes}: {:.3}x", times[2] / base));
            }
        } else {
            shortest = Some(times[2]);
        }
        println!(
            "LIFECYCLE shared_run n={bytes} seconds={:.9} raw={}",
            times[2],
            expected.unwrap()
        );
    }
    let mut machine = Machine::new();
    let mut compartment: Compartment = machine.new_compartment();
    for (name, source, expected_result) in [
        ("fresh_scalar", "1", "1"),
        (
            "fresh_intrinsics",
            "Object.keys({a: 1}).length + Math.abs(-1)",
            "2",
        ),
    ] {
        let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
        let mut times = Vec::new();
        let mut expected = None;
        for round in 0..6 {
            let start = Instant::now();
            for _ in 0..1000 {
                // Release the realm after each evaluation so every run
                // mints, links, and meters a fresh namespace over the
                // machine's shared graph — the constant per-evaluation
                // meter this bench locks — without accumulating parked
                // realm roots.
                let out = compartment.evaluate_with_symbols(machine.interp_mut(), &code, &symbols);
                compartment.release(machine.interp_mut());
                assert!(out.completed, "{:?}", out.halt);
                assert_eq!(out.result, expected_result);
                if let Some(old) = expected {
                    assert_eq!(old, out.meter_raw);
                }
                expected = Some(out.meter_raw);
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
            expected.unwrap()
        );
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
