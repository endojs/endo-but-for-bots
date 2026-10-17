//! TEMPORARY audit probe (verify ONT-15). Deleted after the run.
mod common;
use common::TestCompiler;
use ironhorse_vm::{Compartment, Machine};
use std::rc::Rc;

fn show(c: &Compartment, source: &str) -> String {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    let out = c.evaluate_with_symbols(&code, &symbols);
    if out.completed { out.result } else { format!("HALT {:?}", out.halt) }
}

#[test]
fn verify_ont15() {
    let machine = Machine::new();
    machine.set_source_compiler(Rc::new(TestCompiler)).unwrap();
    let start = machine.start_compartment();
    println!("s1 let lx=1           : {}", show(&start, "let lx = 1; lx"));
    println!("s2 typeof lx          : {}", show(&start, "typeof lx"));
    println!("s3 const cx=1         : {}", show(&start, "const cx = 1; cx"));
    println!("s4 typeof cx          : {}", show(&start, "typeof cx"));
    println!("s5 class K{{}}          : {}", show(&start, "class K {}; typeof K"));
    println!("s6 typeof K           : {}", show(&start, "typeof K"));
    println!("s7 let lx again       : {}", show(&start, "let lx = 2; lx"));
    println!("s8 var lx             : {}", show(&start, "var lx; 'no error'"));
    println!("s9 let undefined      : {}", show(&start, "let undefined = 1; 'no error'"));
    println!("s10 closure across    : {}", show(&start, "let q = 5; var getQ = function(){ return q; }; 'ok'"));
    println!("s11 getQ()            : {}", show(&start, "getQ()"));
    println!("s12 typeof q          : {}", show(&start, "typeof q"));
    // guest compartment with globalLexicals
    println!("g1                    : {}", show(&start,
        "var gc = new Compartment({ globalLexicals: { a: 1 } }); var r = []; \
         try { r.push(gc.evaluate('let a = 2; a')); } catch (e) { r.push(e.name); } \
         try { r.push(gc.evaluate('a')); } catch (e) { r.push(e.name); } \
         try { r.push(gc.evaluate('let b = 3; b')); } catch (e) { r.push(e.name); } \
         try { r.push(gc.evaluate('typeof b')); } catch (e) { r.push(e.name); } \
         r.join('/')"));
}
