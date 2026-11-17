// AUDIT PROBE (temporary): the endo embedding compiles every top-level crank
// with `compile_atoms_with_meter` (= Goal::Eval, rust/endo/src/ironhorse_engine.rs:593),
// the thixotrope worker with Goal::Script (main.rs:131-133). Replicate the
// embedding's VM calls (ironhorse_engine.rs:741-771) on one compartment, two
// cranks, under each goal.
use ironhorse_runtime::IronhorseSourceCompiler;
use ironhorse_vm::{Machine, Meter};
use std::rc::Rc;

fn cranks(goal: ironhorse_compile::Goal, sources: &[&str]) -> Vec<String> {
    let vm = Machine::new();
    vm.set_source_compiler(Rc::new(IronhorseSourceCompiler)).unwrap();
    let mut comp = vm.new_compartment();
    comp.set_source_compiler(Rc::new(IronhorseSourceCompiler));
    let mut out = Vec::new();
    for s in sources {
        let meter = ironhorse_compile::ParseMeter::with_budget(u64::MAX);
        let (code, symbols) =
            ironhorse_compile::compile_atoms_goal_with_meter(s, goal, false, meter).unwrap();
        let o = vm.evaluate_compartment_with_symbols_continuing_meter_shared(
            &comp,
            code.into(),
            &symbols,
            Meter::new(),
            None,
        );
        out.push(format!("completed={} result={:?} halt={:?}", o.completed, o.result, o.halt));
    }
    out
}

#[test]
fn probe() {
    let seqs: [&[&str]; 3] = [
        &["'use strict'; var counter = 41; function inc() { return ++counter; } 'defined'", "inc()"],
        &["'use strict'; var g = 1; typeof globalThis.g"],
        &["var y = 1; String(delete globalThis.y) + ' ' + typeof globalThis.y"],
    ];
    std::thread::Builder::new()
        .stack_size(64 << 20)
        .spawn(move || {
            for seq in seqs {
                println!("SEQ {seq:?}");
                for (goal, name) in [
                    (ironhorse_compile::Goal::Eval, "endo (Eval goal)  "),
                    (ironhorse_compile::Goal::Script, "thixo (Script goal)"),
                ] {
                    for (i, r) in cranks(goal, seq).into_iter().enumerate() {
                        println!("  {name} crank {i}: {r}");
                    }
                }
            }
        })
        .unwrap()
        .join()
        .unwrap();
}
