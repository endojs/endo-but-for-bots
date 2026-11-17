//! Audit probe (ontology/vocabulary): `RunOutcome::completed` is documented
//! as "the dispatch reached END and the job queue drained"; Compartment
//! evaluation never pumps jobs.
use ironhorse_vm::Machine;

fn eval(c: &ironhorse_vm::Compartment, src: &str) -> ironhorse_vm::RunOutcome {
    let (code, symbols) = ironhorse_compile::compile_atoms(src).unwrap();
    c.evaluate_with_symbols(&code, &symbols)
}

#[test]
fn zz_audit_ont_3() {
    let m = Machine::new();
    let start = m.start_compartment();
    let out = eval(&start, "globalThis.x = 0; Promise.resolve().then(() => { globalThis.x = 1; }); 'done'");
    println!("completed={} halt={:?} result={:?}", out.completed, out.halt, out.result);
    let quiescent = m.with_persistence(|i| i.is_quiescent()).unwrap();
    println!("is_quiescent after completed crank = {quiescent}");
    let read = eval(&start, "String(globalThis.x)");
    println!("x before pump = {}", read.result);
    let pumped = m.run_promise_jobs();
    println!("run_promise_jobs completed={}", pumped.completed);
    println!("x after pump = {}", eval(&start, "String(globalThis.x)").result);
}
