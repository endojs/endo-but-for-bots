// Temporary audit probe (ONT-14 verification). Same shape as
// runtime_compile_meter.rs::evaluators_retain_target_globals_when_shared_and_after_origin_drop,
// but the evaluators are the START compartment's, on a frozen Machine::new().
use ironhorse_runtime::IronhorseSourceCompiler;
use std::rc::Rc;

fn ev(c: &ironhorse_vm::Compartment, source: &str) -> String {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    let r = c.evaluate_with_symbols(&code, &symbols);
    if !r.completed {
        return format!("HALT {:?}", r.halt);
    }
    r.result
}

#[test]
fn start_evaluators_shared_to_a_compartment() {
    let machine = ironhorse_vm::Machine::new();
    let mut start = machine.start_compartment();
    start.set_source_compiler(Rc::new(IronhorseSourceCompiler));
    let mut a = machine.new_compartment();
    let mut b = machine.new_compartment();
    a.set_source_compiler(Rc::new(IronhorseSourceCompiler));
    b.set_source_compiler(Rc::new(IronhorseSourceCompiler));
    println!("start setup: {}", ev(&start, "var answer = 17; var e = eval; var F = Function; 0"));
    println!("a setup: {}", ev(&a, "var answer = 42; var e = eval; var F = Function; 0"));
    b.define_global_value("evalS", &start.global_value("e").unwrap()).unwrap();
    b.define_global_value("FunctionS", &start.global_value("F").unwrap()).unwrap();
    b.define_global_value("evalA", &a.global_value("e").unwrap()).unwrap();
    b.define_global_value("FunctionA", &a.global_value("F").unwrap()).unwrap();
    println!("frozen: {}", ev(&start, "Object.isFrozen(Function.prototype)"));
    println!(
        "from b: {}",
        ev(&b, "var answer = 99; ['evalS=' + evalS('answer'), 'FunctionS=' + FunctionS('return answer')(), 'evalA=' + evalA('answer'), 'FunctionA=' + FunctionA('return answer')()].join(' ')")
    );
    println!("b var via evalS: {}", ev(&b, "evalS('var definedViaStartEval = 1'); typeof definedViaStartEval"));
    println!("start sees it: {}", ev(&start, "typeof definedViaStartEval"));
    println!("start eval is proto ctor: {}", ev(&start, "Function === Function.prototype.constructor"));
}
