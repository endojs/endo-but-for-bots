//! TEMPORARY audit probe (ONT-5 consequence/intent verifier). Deleted after the run.
mod common;
use common::TestCompiler;
use ironhorse_vm::{Compartment, Machine, Meter};
use std::rc::Rc;

fn crank(m: &Machine, c: &Compartment, source: &str) -> String {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    let out = m.evaluate_compartment_with_symbols_continuing_meter_shared(
        c, Rc::from(code), &symbols, Meter::new(), None,
    );
    if out.completed { out.result } else { format!("HALT {:?}", out.halt) }
}

#[test]
fn consumer_cranks_only_settle_from_sibling() {
    // Every host step is a full consumer crank (evaluate + pump), as in a
    // multi-compartment host. START's own crank drains its queue. START's
    // promise is later settled during B's crank by a resolver the host shared.
    let machine = Machine::new();
    machine.set_source_compiler(Rc::new(TestCompiler)).unwrap();
    let start = machine.start_compartment();
    let mut b = machine.new_compartment();
    b.set_source_compiler(Rc::new(TestCompiler));
    println!("1 start crank : {}", crank(&machine, &start,
        "var marker = 'START'; var out = []; var settle; \
         var p = new Promise(r => { settle = r; }); \
         p.then(eval).then(v => out.push('nativeEval:' + v)); \
         p.then(s => eval(s)).then(v => out.push('closureEval:' + v)); 'queued'"));
    let settle = start.global_value("settle").expect("settle rooted");
    b.define_global_value("settle", &settle).unwrap();
    println!("2 b crank     : {}", crank(&machine, &b, "var marker = 'B'; settle('marker'); 'settled'"));
    println!("3 start crank : {}", crank(&machine, &start, "out.join(' ')"));
}
