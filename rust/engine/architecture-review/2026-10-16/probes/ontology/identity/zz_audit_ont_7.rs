//! Audit probe (ontology/identity): later-crank Date serialization through
//! the Machine/Compartment surface (the Endo daemon's path).
use ironhorse_vm::Machine;

fn compile(src: &str) -> (Vec<u8>, Vec<u8>) {
    ironhorse_compile::compile_atoms(src).expect("compiles")
}

#[test]
fn zz_audit_ont_7() {
    let machine = Machine::new();
    let c = machine.new_compartment();
    for src in ["0", "JSON.stringify(new Date(0))", "JSON.stringify(new Date(1))"] {
        let (code, syms) = compile(src);
        let out = c.evaluate_with_symbols(&code, &syms);
        println!("compartment crank {src:?} -> {:?} {:?}", out.result, out.halt);
    }
    let start = machine.start_compartment();
    for src in ["0", "JSON.stringify(new Date(0))"] {
        let (code, syms) = compile(src);
        let out = start.evaluate_with_symbols(&code, &syms);
        println!("start compartment crank {src:?} -> {:?} {:?}", out.result, out.halt);
    }
}
