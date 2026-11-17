//! TEMPORARY audit probe (verify ONT-5). Deleted after the run.
mod common;
use common::TestCompiler;
use ironhorse_vm::{Compartment, Machine, Meter};
use std::rc::Rc;

fn evaluate(c: &Compartment, source: &str) -> ironhorse_vm::RunOutcome {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    c.evaluate_with_symbols(&code, &symbols)
}
fn show(c: &Compartment, source: &str) -> String {
    let out = evaluate(c, source);
    if out.completed { out.result } else { format!("HALT {:?}", out.halt) }
}
fn crank(m: &Machine, c: &Compartment, source: &str) -> String {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    let out = m.evaluate_compartment_with_symbols_continuing_meter_shared(
        c,
        Rc::from(code),
        &symbols,
        Meter::new(),
        None,
    );
    if out.completed { out.result } else { format!("HALT {:?}", out.halt) }
}

#[test]
fn a_original_reproduction() {
    let machine = Machine::new();
    machine.set_source_compiler(Rc::new(TestCompiler)).unwrap();
    let start = machine.start_compartment();
    let mut b = machine.new_compartment();
    b.set_source_compiler(Rc::new(TestCompiler));
    println!("A start direct Function: {}", show(&start, "var marker = 'START'; var out = []; Function('return marker')()"));
    println!("A start direct eval    : {}", show(&start, "(0, eval)('marker')"));
    println!("A queue                : {}", show(&start,
        "Promise.resolve('return marker').then(Function).then(f => out.push('Function:' + f())); \
         Promise.resolve('marker').then(eval).then(v => out.push('eval:' + v)); \
         Promise.resolve('marker').then(s => eval(s)).then(v => out.push('closure-eval:' + v)); 0"));
    println!("A b                    : {}", show(&b, "var marker = 'B'; 0"));
    let pump = machine.run_promise_jobs();
    println!("A pump completed       : {} {:?}", pump.completed, pump.halt);
    println!("A start out            : {}", show(&start, "out.join(' ')"));
    println!("A b sees leak?         : {}", show(&b, "typeof leaked"));
}

#[test]
fn b_consumer_crank_and_declaration_leak() {
    // START queues without pumping (Compartment::evaluate never pumps), then a
    // production consumer crank of B pumps the one Machine queue.
    let machine = Machine::new();
    machine.set_source_compiler(Rc::new(TestCompiler)).unwrap();
    let start = machine.start_compartment();
    let mut b = machine.new_compartment();
    b.set_source_compiler(Rc::new(TestCompiler));
    println!("B start queue          : {}", show(&start,
        "var marker = 'START'; var out = []; \
         Promise.resolve('var leaked = marker; leaked').then(eval).then(v => out.push('eval:' + v)); 0"));
    println!("B b crank              : {}", crank(&machine, &b, "var marker = 'B'; 0"));
    println!("B start out            : {}", show(&start, "out.join(' ') + ' start.leaked=' + typeof leaked"));
    println!("B b leaked             : {}", show(&b, "typeof leaked === 'undefined' ? 'none' : leaked"));
}

#[test]
fn c_same_ops_order_flipped() {
    // Same program, but the host happens to touch START last before pumping.
    let machine = Machine::new();
    machine.set_source_compiler(Rc::new(TestCompiler)).unwrap();
    let start = machine.start_compartment();
    let mut b = machine.new_compartment();
    b.set_source_compiler(Rc::new(TestCompiler));
    println!("C b                    : {}", show(&b, "var marker = 'B'; 0"));
    println!("C start queue          : {}", show(&start,
        "var marker = 'START'; var out = []; \
         Promise.resolve('marker').then(eval).then(v => out.push('eval:' + v)); 0"));
    let pump = machine.run_promise_jobs();
    println!("C pump completed       : {} {:?}", pump.completed, pump.halt);
    println!("C start out            : {}", show(&start, "out.join(' ')"));
}
