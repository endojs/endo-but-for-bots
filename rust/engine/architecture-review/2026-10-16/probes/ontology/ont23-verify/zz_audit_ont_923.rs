//! ONT-23 verifier probe (temporary).
use ironhorse_vm::{parse_symbols, Interp, Machine};

const SRC: &str = "globalThis.x = 0; Promise.resolve().then(() => { globalThis.x = 1; }); 'done'";

#[test]
fn ont23_verify() {
    let (code, symbols) = ironhorse_compile::compile_atoms(SRC).unwrap();
    let (rcode, rsyms) = ironhorse_compile::compile_atoms("globalThis.x").unwrap();

    // A: Compartment-level evaluate (documented non-pumping).
    let m = Machine::new();
    let start = m.start_compartment();
    let o = start.evaluate_with_symbols(&code, &symbols);
    println!("A compartment.evaluate: completed={} halt={:?} result={:?}", o.completed, o.halt, o.result);
    println!("A is_quiescent={:?} has_pending_jobs={:?}",
        m.with_persistence(|i| i.is_quiescent()), m.with_persistence(|i| i.has_pending_jobs()));
    println!("A x before pump = {}", start.evaluate_with_symbols(&rcode, &rsyms).result);
    let p = m.run_promise_jobs();
    println!("A pump completed={} ; x after pump = {}", p.completed, start.evaluate_with_symbols(&rcode, &rsyms).result);

    // B: Machine-level crank (what rust/endo's seam calls).
    let m2 = Machine::new();
    let start2 = m2.start_compartment();
    let o2 = m2.evaluate_compartment_with_symbols_continuing_meter_shared(
        &start2, code.clone().into(), &symbols, ironhorse_vm::Meter::new(), None);
    println!("B machine.evaluate_compartment_*: completed={} result={:?}", o2.completed, o2.result);
    println!("B is_quiescent={:?} has_pending_jobs={:?} x={}",
        m2.with_persistence(|i| i.is_quiescent()), m2.with_persistence(|i| i.has_pending_jobs()),
        start2.evaluate_with_symbols(&rcode, &rsyms).result);

    // C: standalone Interp, run_script_shared (non-shared mode).
    let mut vm = Interp::new();
    let c = vm.relink_crank(&code, &parse_symbols(&symbols)).unwrap();
    let o3 = vm.run_script_shared(std::rc::Rc::from(c));
    println!("C standalone run_script_shared: completed={} is_quiescent={} has_pending_jobs={}",
        o3.completed, vm.is_quiescent(), vm.has_pending_jobs());
}
