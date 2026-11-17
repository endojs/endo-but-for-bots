//! TEMPORARY audit probe (spec-model lens). Deleted after the run.
mod common;
use common::TestCompiler;
use ironhorse_vm::{Compartment, Machine};
use std::rc::Rc;

fn evaluate(c: &Compartment, source: &str) -> ironhorse_vm::RunOutcome {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    c.evaluate_with_symbols(&code, &symbols)
}
fn show(c: &Compartment, source: &str) -> String {
    let out = evaluate(c, source);
    if out.completed { out.result } else { format!("HALT {:?}", out.halt) }
}

#[test]
fn probe_job_environment_and_global_lexicals() {
    // Production shape: frozen Machine, compilers installed.
    let machine = Machine::new();
    machine.set_source_compiler(Rc::new(TestCompiler)).unwrap();
    let start = machine.start_compartment();
    let mut b = machine.new_compartment();
    b.set_source_compiler(Rc::new(TestCompiler));

    // (1) the START compartment's own evaluators, called directly
    println!("start direct Function: {}", show(&start, "var marker = 'START'; var out = []; Function('return marker')()"));
    println!("start direct eval    : {}", show(&start, "(0, eval)('marker')"));
    // (2) the same evaluators used as promise reaction handlers by START code
    println!("queue               : {}", show(&start,
        "Promise.resolve('return marker').then(Function).then(f => out.push('Function:' + f())); \
         Promise.resolve('marker').then(eval).then(v => out.push('eval:' + v)); 0"));
    // the host then runs some other compartment, and pumps the one ordered queue
    println!("b                   : {}", show(&b, "var marker = 'B'; 0"));
    let pump = machine.run_promise_jobs();
    println!("pump completed      : {} {:?}", pump.completed, pump.halt);
    println!("start out           : {}", show(&start, "out.join(' ')"));

    // (3) global Environment Record across two Scripts of one compartment
    println!("script1 let         : {}", show(&start, "let lx = 1; lx"));
    println!("script2 typeof lx   : {}", show(&start, "typeof lx"));
    println!("script3 let lx again: {}", show(&start, "let lx = 2; lx"));
    println!("script4 var lx      : {}", show(&start, "var lx; 'no error'"));
    println!("script5 let NaN     : {}", show(&start, "let NaN = 1; 'no error'"));
    println!("script6 let undefined: {}", show(&start, "let undefined = 1; 'no error'"));
}
