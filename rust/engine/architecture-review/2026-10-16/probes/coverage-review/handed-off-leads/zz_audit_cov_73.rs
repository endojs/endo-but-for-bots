// Coverage-review probe (handed-off leads): are a compartment's own evaluator
// copies frozen on the production frozen Machine::new()? (SES freezes them.)
use ironhorse_vm::Machine;
use std::rc::Rc;

fn eval_in(machine: &Machine, comp: &ironhorse_vm::Compartment, src: &str) -> String {
    let (code, symbols) = ironhorse_compile::compile_atoms(src).unwrap();
    let out = comp.evaluate_with_symbols(&code, &symbols);
    let _ = machine;
    format!("completed={} result={} halt={:?}", out.completed, out.result, out.halt)
}

#[test]
fn compartment_evaluators_frozen_on_machine() {
    let machine = Machine::new();
    let _ = machine.set_source_compiler(Rc::new(ironhorse_runtime::IronhorseSourceCompiler));
    let probe = "JSON.stringify({ F: Object.isFrozen(Function), E: Object.isFrozen(eval), C: Object.isFrozen(Compartment), G: Object.isFrozen(globalThis), sameF: Function === Object.getPrototypeOf(function(){}).constructor })";
    let mut start = machine.new_compartment();
    start.set_source_compiler(Rc::new(ironhorse_runtime::IronhorseSourceCompiler));
    println!("host compartment: {}", eval_in(&machine, &start, probe));
    let guest = format!("var c = new Compartment({{}}); c.evaluate({:?})", probe);
    println!("guest child of host compartment: {}", eval_in(&machine, &start, &guest));
    let mutate = "var c = new Compartment({}); var d = new Compartment({ globals: { peer: c.evaluate('Function') } }); var ok; try { d.evaluate('peer.leak = 42'); ok = c.evaluate('Function.leak'); } catch (e) { ok = 'threw ' + e.name; } String(ok)";
    println!("host-compartment Function mutable: {}", eval_in(&machine, &start, "var ok; try { Function.leak2 = 1; ok = Function.leak2; } catch (e) { ok = 'threw ' + e.name; } String(ok)"));
    println!("mutate child Function: {}", eval_in(&machine, &start, mutate));
}
