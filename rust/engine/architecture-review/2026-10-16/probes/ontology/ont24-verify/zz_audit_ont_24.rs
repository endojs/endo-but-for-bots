use ironhorse_vm::{Compartment, Machine};

fn eval(compartment: &Compartment, source: &str) -> String {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    let out = compartment.evaluate_with_symbols(&code, &symbols);
    if out.completed { out.result } else { format!("HALT {:?}", out.halt) }
}

fn probe(label: &str, machine: Machine) {
    let a = machine.new_compartment();
    let b = machine.new_compartment();
    let start = machine.start_compartment();
    let frozen = eval(&a, "String(Object.isFrozen(Array.prototype))");
    let write = eval(&a, "try { Array.prototype.leak = 'from-a'; } catch (e) { e.name } String(Array.prototype.leak)");
    let in_b = eval(&b, "String([].leak)");
    let in_start = eval(&start, "String([].leak)");
    eval(&a, "var answer = 42; answer");
    let global_in_b = eval(&b, "typeof answer");
    println!("{label}: frozen={frozen} writeInA={write} seenInB={in_b} seenInStart={in_start} globalInB={global_in_b}");
}

#[test]
fn ont24() {
    probe("Machine::new", Machine::new());
    probe("Machine::unfrozen", Machine::unfrozen_with_start_global_names(None));
}
