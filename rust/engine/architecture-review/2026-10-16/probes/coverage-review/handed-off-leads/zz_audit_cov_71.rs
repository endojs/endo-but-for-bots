// Coverage-review probe (handed-off leads): the crank completion render.
// Mirrors the endo seam (rust/endo/src/ironhorse_engine.rs:741-771): a shared
// Machine, a fresh compartment, a begun meter with a crank ceiling, and
// evaluate_compartment_with_symbols_continuing_meter_shared.
use ironhorse_vm::{Machine, Meter};
use std::time::Instant;

fn crank(machine: &Machine, src: &str, ceiling: u64) {
    let (code, symbols) = ironhorse_compile::compile_atoms(src).unwrap();
    let comp = machine.new_compartment();
    let mut meter = Meter::new();
    meter.begin(1);
    let host: Box<dyn FnMut(u64) -> bool> = Box::new(move |c| c <= ceiling);
    let t = Instant::now();
    let out = machine.evaluate_compartment_with_symbols_continuing_meter_shared(
        &comp,
        code.into(),
        &symbols,
        meter,
        Some(host),
    );
    println!(
        "completed={} halt={:?} computrons_this_run={} result_len={} wall={:?}",
        out.completed,
        out.halt,
        out.computrons_this_run,
        out.result.len(),
        t.elapsed()
    );
}

#[test]
fn completion_render_is_unbounded_and_unmetered() {
    let machine = Machine::new();
    for n in [16u32, 18, 20, 22, 24] {
        print!("n={n} ceiling=20000: ");
        crank(
            &machine,
            &format!("var a = ['xxxxxxxxxx']; for (var i = 0; i < {n}; i++) a = [a, a]; a"),
            20_000,
        );
        print!("n={n} void control: ");
        crank(
            &machine,
            &format!("var a = ['xxxxxxxxxx']; for (var i = 0; i < {n}; i++) a = [a, a]; void 0"),
            20_000,
        );
    }
}
